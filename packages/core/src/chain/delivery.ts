import type { Progress, RunStream } from '../contract.ts';
import {
  disclosed,
  type ErrorFacts,
  stopReason,
  toFacts,
} from '../data/errors.ts';
import {
  isTerminal,
  type StreamEvent,
  type Terminal,
  type Usage,
} from '../data/event.ts';
import { type Answer, arrival, ending, sentWith } from '../request/answer.ts';
import {
  endPhase,
  phaseStopper,
  type RequestState,
} from '../request/context.ts';
import { progress } from '../request/think.ts';
import { onAbort, readOut } from '../request/wait.ts';
import type { Outcome } from './builder.ts';

type Sent = StreamEvent | Progress;

type SentRead = IteratorResult<Sent, undefined>;

type Phase = 'open' | 'stopped' | 'ended';

// The whole error, for the host: the caller is told it without its stack
// and cause, and one who left is told nothing.
export type Ended = { outcome: Outcome; error?: ErrorFacts };

export type Delivery = {
  stream: RunStream;
  answered: (answer: Answer) => Promise<Ended>;
  failed: (thrown: unknown) => Promise<Ended>;
};

export function delivery(state: RequestState): Delivery {
  const stopPhase = phaseStopper();
  const { signal, calls } = state;
  const stage = progress(state, () => {
    pumping = pump();
  });
  const offered: { event: Sent; taken: (reached: boolean) => void }[] = [];
  const asking: ((read: SentRead) => void)[] = [];
  let phase: Phase = 'open';
  let pumping: Promise<void> | undefined;
  let reason: ErrorFacts | undefined;
  let sending: (() => void) | undefined;

  function failure(error: ErrorFacts): Terminal {
    return {
      type: 'error',
      error: disclosed(error),
      usage: { ...calls.total },
    };
  }

  // Read once: the caller and the host are told of the one stop.
  function why(): ErrorFacts {
    reason ??= toFacts(stopReason(signal.reason));
    return reason;
  }

  function stopRead(): SentRead {
    return { done: false, value: failure(why()) };
  }

  function drop(): void {
    for (const offer of offered.splice(0)) offer.taken(false);
  }

  function endStream(): void {
    phase = 'ended';
    drop();
    for (const give of asking.splice(0)) give(readOut);
  }

  function onStop(): void {
    switch (phase) {
      case 'open': {
        const give = asking.shift();
        if (give === undefined) {
          drop();
          phase = 'stopped';
        } else {
          give(stopRead());
          endStream();
        }
        break;
      }
      case 'stopped':
      case 'ended':
        break;
      default:
        phase satisfies never;
    }
    sending?.();
  }

  // True when a reader took the event, so that nothing waits a turn for it.
  function delivered(event: Sent): boolean | Promise<boolean> {
    switch (phase) {
      case 'open': {
        const give = asking.shift();
        if (give === undefined) {
          return new Promise((taken) => {
            offered.push({ event, taken });
          });
        }
        give({ done: false, value: event });
        if (isTerminal(event)) endStream();
        return true;
      }
      case 'stopped':
      case 'ended':
        return false;
      default:
        return phase satisfies never;
    }
  }

  function next(): Promise<SentRead> {
    switch (phase) {
      case 'open': {
        const offer = offered.shift();
        if (offer === undefined) {
          return new Promise((give) => {
            asking.push(give);
          });
        }
        const { event, taken } = offer;
        if (isTerminal(event)) endStream();
        taken(true);
        return Promise.resolve({ done: false, value: event });
      }
      case 'stopped':
        endStream();
        return Promise.resolve(stopRead());
      case 'ended':
        return Promise.resolve(readOut);
      default:
        return phase satisfies never;
    }
  }

  function left(): Promise<SentRead> {
    switch (phase) {
      case 'open':
      case 'stopped':
        endStream();
        stopPhase();
        break;
      case 'ended':
        break;
      default:
        phase satisfies never;
    }
    return Promise.resolve(readOut);
  }

  async function pump(): Promise<void> {
    for await (const { piece, text } of stage.pieces) {
      await delivered({ type: 'progress', piece, text });
    }
  }

  // Every line offered so far still goes out ahead of the answer.
  async function closed(): Promise<void> {
    stage.close();
    await pumping;
  }

  // Whether every chunk was sent, each as it arrives. How the answer ended is
  // read from its ending. By hand and not its replay: that generator and its
  // turns cost about 50 nanoseconds a chunk.
  function sentWhole(answer: Answer): Promise<boolean> {
    const { buffer, state, onArrival } = arrival(answer);
    return new Promise((resolve) => {
      let read = 0;
      const send = () => {
        if (offered.length > 0) return;
        for (
          let chunk = buffer[read];
          chunk !== undefined;
          chunk = buffer[read]
        ) {
          read += 1;
          const taken = delivered(chunk);
          if (taken !== true) {
            Promise.resolve(taken).then((went) =>
              went ? send() : over(false),
            );
            return;
          }
        }
        if (state().at !== 'arriving') over(true);
        else if (phase !== 'open') over(false);
      };
      const unfollow = onArrival(send);
      const over = (whole: boolean) => {
        unfollow();
        sending = undefined;
        resolve(whole);
      };
      sending = send;
      send();
    });
  }

  // The phase ends ahead of the terminal event, so the usage a caller is told
  // counts every call, as the record does. Whatever stopped the request, it
  // did not complete and did not fail.
  async function last(
    built?: (usage: Usage) => Terminal,
    error?: ErrorFacts,
  ): Promise<Ended> {
    unfollow();
    await endPhase();
    if (built === undefined || !(await delivered(built({ ...calls.total })))) {
      return { outcome: 'aborted', error: why() };
    }
    return error === undefined
      ? { outcome: 'completed' }
      : { outcome: 'failed', error };
  }

  function failed(thrown: unknown): Promise<Ended> {
    const error = toFacts(thrown);
    return last(() => failure(error), error);
  }

  // Told at once, so the caller hears of the stop ahead of whatever the
  // stopped work throws.
  const unfollow = onAbort(signal, onStop, 'atOnce');
  const reader: AsyncIterator<Sent, undefined> = { next, return: left };

  return {
    stream: { [Symbol.asyncIterator]: () => reader },
    answered: async (answer) => {
      await closed();
      try {
        if (!(await sentWhole(answer))) return last();
        const finish = await ending(answer);
        return last((usage) => sentWith(finish, usage));
      } catch (thrown) {
        return failed(thrown);
      }
    },
    failed: async (thrown) => {
      await closed();
      return failed(thrown);
    },
  };
}
