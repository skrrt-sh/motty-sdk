import type { EventStream } from '../contract.ts';
import {
  type ErrorFacts,
  fromFacts,
  MottyError,
  stopReason,
  toFacts,
} from '../data/errors.ts';
import {
  eventOf,
  type Failed,
  isTerminal,
  type StreamEvent,
  type Terminal,
  type Usage,
} from '../data/event.ts';
import type { JsonOutput, OutputSchema, Prompt } from '../data/message.ts';
import {
  type Answer,
  buffered,
  calledBy,
  endedEarly,
  type Parsed,
} from './answer.ts';
import { current, mayGoUnawaited, openCall } from './context.ts';
import { wired } from './output-schema.ts';
import { close, onAbort, reader, reasonOf } from './wait.ts';

export type Model = {
  complete: <Schema extends OutputSchema = OutputSchema>(
    prompt: Prompt<Schema>,
  ) => Promise<Answer<Parsed<Schema>>>;
};

// What a combinator returns has no single name, so only a model made by
// name carries one.
export type NamedModel = Model & { readonly name: string };

// Resolves on the first event, so whoever switches models can still switch;
// a failure before any chunk rejects, a later one stays in the stream.
export type Call = (
  prompt: Prompt<JsonOutput>,
  signal: AbortSignal,
) => Promise<EventStream>;

export type Read = IteratorResult<StreamEvent, undefined>;

const calls = new WeakMap<Model, Call>();

const readOut: Read = { done: true, value: undefined };

// A call given up with no reason, as when its phase ends, is ended by these:
// no error is made for an ending nobody may ever read.
const givenUp: ErrorFacts = {
  code: 'aborted',
  status: 499,
  message: 'The call was given up',
  retryable: false,
};

async function asked<Schema extends OutputSchema>(
  call: Call,
  prompt: Prompt<Schema>,
): Promise<Answer<Parsed<Schema>>> {
  const { signal } = current();
  // Read before the wait, so the reply is held to the schema that was sent.
  const sent = wired(prompt);
  const { output } = prompt;
  return buffered(await call(sent, signal), output);
}

export function callable(call: Call): Model {
  const made: Model = {
    complete: (prompt) => mayGoUnawaited(asked(call, prompt)),
  };
  calls.set(made, call);
  return made;
}

export function callOf(model: Model): Call {
  const call = calls.get(model);
  if (call === undefined) {
    throw new Error('Not a model: it was not made by model() or a combinator');
  }
  return call;
}

export function stopEvent(signal: AbortSignal, usage?: Usage): Failed {
  const reason = reasonOf(signal);
  return {
    type: 'error',
    error: reason === undefined ? givenUp : toFacts(stopReason(reason)),
    ...(usage === undefined ? {} : { usage }),
  };
}

// The core's own verdict on what a host sent, so it is no failure of the
// host's to mark.
function refused(message: string): Failed {
  return { type: 'error', error: toFacts(new MottyError(message)) };
}

// What a host throws enters as the error event it could have sent, so one
// gate marks every failure of a host, thrown or sent. A value that is no SDK
// error may hold a key or an address, so nothing of it is told: a timeout or
// an abort of the host's own is one, since the call's signal has not fired.
function thrownBy(thrown: unknown, name: string): Terminal {
  const error = toFacts(
    thrown instanceof MottyError
      ? thrown
      : new MottyError(`The model call to ${name} failed`, {
          unexpected: true,
        }),
  );
  const failed = eventOf({ type: 'error', error });
  return failed !== undefined && isTerminal(failed)
    ? failed
    : refused('The model call failed');
}

function entering(result: IteratorResult<unknown>): StreamEvent | string {
  if (result?.done) return endedEarly;
  return (
    eventOf(result?.value) ?? 'The host sent something that is not an event'
  );
}

// A finish is given whole: its entry takes the id and the warnings by name.
function usageAndCode(last: Terminal) {
  return last.type === 'error'
    ? { ...last.usage, code: last.error.code, message: last.error.message }
    : { ...last.usage, ...last };
}

export function model(name: string): NamedModel {
  const made = callable(
    (prompt, signal) =>
      new Promise<EventStream>((resolve, reject) => {
        const { host, signal: phase } = current();
        const open = openCall(name, signal);
        let source: ReturnType<typeof reader> | undefined;
        let stream: AsyncIterator<unknown> | undefined;
        let pulling = false;
        let endLate: (() => void) | undefined;
        let lateTurn: ReturnType<typeof setTimeout> | undefined;
        let lateUntil = 0;
        let unread: StreamEvent | undefined;
        let asking: ((read: Read) => void) | undefined;
        let opening = true;
        let over = false;

        function hand(event: StreamEvent): void {
          if (!opening) {
            if (asking === undefined) unread = event;
            else asking({ done: false, value: event });
            asking = undefined;
          } else if (event.type !== 'error') {
            unread = event;
            resolve({ [Symbol.asyncIterator]: () => events });
          } else {
            // Facts would raise a copy of the reason a host gave for its stop.
            reject(
              signal.aborted
                ? stopReason(signal.reason)
                : fromFacts(event.error),
            );
          }
          opening = false;
        }

        // Counted before its terminal event is handed on, so whoever reads
        // that event reads whole totals.
        function endCall(last: Terminal, readOn = false): void {
          if (over) return;
          over = true;
          open.close(usageAndCode(last));
          if (readOn) readLate();
          else source?.end(false);
          hand(calledBy(last, name));
        }

        // The call has ended and nothing waits for this: what its host still
        // says it cost is counted until the phase it began in ends.
        function readLate(): void {
          endLate = onAbort(phase, dropLate, 'atOnce');
          source?.end(true);
          if (!pulling) pullLate();
        }

        function dropLate(): void {
          if (endLate === undefined || stream === undefined) return;
          endLate();
          endLate = undefined;
          clearTimeout(lateTurn);
          close(stream);
        }

        function pullLate(): void {
          if (stream === undefined) return;
          try {
            Promise.resolve(stream.next()).then(arrivedLate, dropLate);
          } catch {
            dropLate();
          }
        }

        function arrivedLate(result: IteratorResult<unknown>): void {
          if (endLate === undefined) return;
          let sent: StreamEvent | string;
          try {
            sent = entering(result);
          } catch {
            dropLate();
            return;
          }
          // A turn of the event loop once the reads have taken two milliseconds:
          // a host that yields with no wait of its own would otherwise be read
          // to its end before the phase could end and close it.
          if (typeof sent !== 'string' && !isTerminal(sent)) {
            if (performance.now() < lateUntil) pullLate();
            else {
              lateTurn = setTimeout(() => {
                lateUntil = performance.now() + 2;
                pullLate();
              });
            }
            return;
          }
          if (typeof sent !== 'string' && sent.usage !== undefined) {
            open.addUsage(sent.usage);
          }
          dropLate();
        }

        // Read on only for a call cut while its request goes on: a stream
        // that has ended, or a phase that has, leaves nothing to count.
        function stop(usage?: Usage, ended = false): void {
          endCall(
            stopEvent(signal, usage),
            !ended && signal.aborted && !phase.aborted,
          );
        }

        function hostThrew(thrown: unknown): void {
          pulling = false;
          if (over) dropLate();
          else if (signal.aborted) stop(undefined, true);
          else endCall(thrownBy(thrown, name));
        }

        function arrived(result: IteratorResult<unknown>): void {
          pulling = false;
          if (over) {
            arrivedLate(result);
            return;
          }
          let sent: StreamEvent | string;
          try {
            sent = entering(result);
          } catch (thrown) {
            hostThrew(thrown);
            return;
          }
          if (typeof sent === 'string') {
            if (signal.aborted) stop(undefined, true);
            else endCall(refused(sent));
          } else if (signal.aborted) {
            if (isTerminal(sent)) stop(sent.usage, true);
            else stop();
          } else {
            if (opening) open.markFirstEvent();
            if (isTerminal(sent)) endCall(sent);
            else hand(sent);
          }
        }

        // One read at a time, so no read makes a function of its own.
        const ask = (give: (read: Read) => void) => {
          asking = give;
          pulling = !signal.aborted;
          source?.read(arrived, hostThrew);
        };

        const events: AsyncIterator<StreamEvent, undefined> = {
          next: () => {
            if (unread !== undefined && !over && signal.aborted) stop();
            const value = unread;
            unread = undefined;
            if (value !== undefined) {
              return Promise.resolve({ done: false, value });
            }
            return over ? Promise.resolve(readOut) : new Promise(ask);
          },
          return: () => {
            const waiting = asking;
            asking = undefined;
            stop();
            unread = undefined;
            waiting?.(readOut);
            return Promise.resolve(readOut);
          },
        };

        try {
          stream = host.models(name, prompt, signal)[Symbol.asyncIterator]();
          source = reader(stream, signal, stop);
          pulling = true;
          source.read(arrived, hostThrew);
        } catch (thrown) {
          hostThrew(thrown);
        }
      }),
  );
  return Object.assign(made, { name });
}
