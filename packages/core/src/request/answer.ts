import type { EventStream } from '../contract.ts';
import { fromFacts, MottyError, stopReason } from '../data/errors.ts';
import {
  type Chunk,
  chunkOf,
  type Finish,
  type FinishReason,
  type StreamEvent,
  type Terminal,
  type Usage,
} from '../data/event.ts';
import type { OutputSchema, StandardSchema } from '../data/message.ts';
import { running } from './context.ts';
import { type Arrival, replayed } from './replay.ts';
import { structured } from './structured-output.ts';
import { readToEnd, wait } from './wait.ts';

export type Answer<Output = unknown> = {
  text: () => Promise<string>;
  chunks: () => AsyncIterable<Chunk>;
  json: () => Promise<Output>;
  usage: () => Promise<Usage>;
  finish: () => Promise<FinishReason>;
  model: () => Promise<string | undefined>;
};

export type Parsed<Schema> = Schema extends
  | StandardSchema<unknown, infer Output>
  | { schema: StandardSchema<unknown, infer Output> }
  ? Output
  : unknown;

// The error is made when the failure is first read, so an answer that fails
// unread makes none.
type Settled =
  | { at: 'finished'; finish: Finish }
  | { at: 'failed'; error: () => MottyError; usage?: Usage; model?: string };

type AnswerState = { at: 'arriving' } | Settled;

// The promise never rejects, so an answer nobody reads raises nothing.
type Ending = {
  buffer: readonly Chunk[];
  state: () => AnswerState;
  onArrival: Arrival<Chunk>['onArrival'];
  settled: Promise<Settled>;
  output: OutputSchema | undefined;
};

type Intake = {
  takeAndWantMore: (event: StreamEvent) => boolean;
  closeUnlessEnded: (over: Settled) => void;
};

const endings = new WeakMap<object, Ending>();

// Held beside the event and not in it, where a host could have written it.
const callers = new WeakMap<Terminal, string>();

// Copied, so an event a host sends for two calls names each of them.
export function calledBy(last: Terminal, name: string): Terminal {
  const own = { ...last };
  callers.set(own, name);
  return own;
}

// The finish a caller is sent is a copy with the request's usage, and whoever
// reads that copy as an answer is told the model as the motty was.
export function sentWith(finish: Finish, usage: Usage): Finish {
  const sent = { ...finish, usage };
  const name = callers.get(finish);
  if (name !== undefined) callers.set(sent, name);
  return sent;
}

const plainFinish: Settled = {
  at: 'finished',
  finish: { type: 'finish', reason: 'stop' },
};

function once(make: () => MottyError): () => MottyError {
  let made: MottyError | undefined;
  return () => {
    made ??= make();
    return made;
  };
}

function step(
  state: AnswerState,
  event: StreamEvent,
  buffer: Chunk[],
): AnswerState {
  if (state.at !== 'arriving') return state;
  switch (event.type) {
    case 'finish':
      return { at: 'finished', finish: event };
    case 'error': {
      const model = callers.get(event);
      return {
        at: 'failed',
        error: once(() => fromFacts(event.error)),
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(model === undefined ? {} : { model }),
      };
    }
    // Whatever is left is a chunk: an event of no known kind was refused
    // where it entered.
    default:
      buffer.push(event);
      return state;
  }
}

function thrownAs(thrown: unknown, from: AnswerState | undefined): Settled {
  // A rewrite that reads a failed answer rethrows its error: fail as it did,
  // usage included.
  if (from?.at === 'failed' && from.error() === thrown) return from;
  const error =
    thrown instanceof MottyError
      ? thrown
      : new MottyError('The stream failed', { cause: thrown });
  return { at: 'failed', error: () => error };
}

function finishOf(over: Settled): Finish {
  if (over.at === 'failed') throw over.error();
  return over.finish;
}

function buffering(
  feed: (into: Intake) => void,
  output?: OutputSchema,
): Answer {
  const buffer: Chunk[] = [];
  const settled = Promise.withResolvers<Settled>();
  let state: AnswerState = { at: 'arriving' };
  let readers: Set<() => void> | undefined;
  let whole: Promise<string> | undefined;
  let parsed: Promise<unknown> | undefined;

  function move(next: AnswerState) {
    state = next;
    if (state.at !== 'arriving') settled.resolve(state);
    if (readers !== undefined) for (const wake of readers) wake();
  }

  function onArrival(wake: () => void) {
    readers ??= new Set();
    readers.add(wake);
    return () => {
      readers?.delete(wake);
    };
  }

  function underReader<Value>(arriving: Promise<Value>): Promise<Value> {
    const signal = state.at === 'arriving' ? running()?.signal : undefined;
    return signal === undefined ? arriving : wait(arriving, signal);
  }

  async function wholeText() {
    finishOf(await settled.promise);
    let text = '';
    for (const chunk of buffer) {
      if (chunk.type === 'text') text += chunk.text;
    }
    return text;
  }

  function text() {
    whole ??= wholeText();
    return underReader(whole);
  }

  function json() {
    whole ??= wholeText();
    parsed ??= whole.then((source) => structured(source, output));
    return underReader(parsed);
  }

  async function usage() {
    const over = await underReader(settled.promise);
    if (over.at === 'finished') return over.finish.usage ?? {};
    if (over.usage === undefined) throw over.error();
    return over.usage;
  }

  async function model() {
    const over = await underReader(settled.promise);
    return over.at === 'finished' ? callers.get(over.finish) : over.model;
  }

  feed({
    takeAndWantMore: (event) => {
      move(step(state, event, buffer));
      return state.at === 'arriving';
    },
    closeUnlessEnded: (over) => {
      if (state.at === 'arriving') move(over);
    },
  });
  const arriving = { buffer, state: () => state, onArrival };
  const made: Answer = {
    text,
    chunks: () => replayed(arriving, running()?.signal),
    json,
    usage,
    finish: async () => finishOf(await underReader(settled.promise)).reason,
    model,
  };
  endings.set(made, { ...arriving, settled: settled.promise, output });
  return made;
}

async function upstream(events: EventStream, into: Intake): Promise<void> {
  try {
    for await (const event of events) {
      if (!into.takeAndWantMore(event)) return;
    }
  } catch (thrown) {
    into.closeUnlessEnded(thrownAs(thrown, undefined));
  }
  into.closeUnlessEnded({
    at: 'failed',
    error: once(
      () => new MottyError('The stream ended without a finish or an error'),
    ),
  });
}

export function buffered<Schema extends OutputSchema>(
  events: EventStream,
  output?: Schema,
): Answer<Parsed<Schema>>;
export function buffered(events: EventStream, output?: OutputSchema): Answer {
  return buffering((into) => upstream(events, into), output);
}

// A look-alike would have the core run and wait on code of its own.
export function isAnswer(value: unknown): value is Answer {
  return typeof value === 'object' && value !== null && endings.has(value);
}

function endingOf(answer: Answer): Ending {
  const found = endings.get(answer);
  if (found === undefined) {
    throw new Error(
      'Not an answer: it was not made by answer() or a model call',
    );
  }
  return found;
}

export function ending(answer: Answer): Promise<Finish> {
  return endingOf(answer).settled.then(finishOf);
}

export function arrival(answer: Answer): Arrival<Chunk> {
  return endingOf(answer);
}

function chunkFrom(value: unknown): Chunk {
  const chunk = chunkOf(value);
  if (chunk !== undefined) return chunk;
  throw new MottyError('The stream gave something that is not a chunk');
}

export function answer(
  content: string | AsyncIterable<Chunk>,
  from?: Answer,
): Answer {
  const end = from === undefined ? undefined : endingOf(from);
  return buffering((into) => {
    if (typeof content === 'string') {
      into.takeAndWantMore({ type: 'text', text: content });
      if (end === undefined) into.closeUnlessEnded(plainFinish);
      else end.settled.then(into.closeUnlessEnded);
      return;
    }
    // Its source is read no longer than the phase it was made in: after that
    // nobody is sent what it gives.
    const signal = running()?.signal;
    readToEnd(content, signal, (chunk) =>
      into.takeAndWantMore(chunkFrom(chunk)),
    )
      .then<Settled, Settled>(
        (wasReadOut) =>
          wasReadOut
            ? (end?.settled ?? plainFinish)
            : { at: 'failed', error: once(() => stopReason(signal?.reason)) },
        (thrown: unknown) => thrownAs(thrown, end?.state()),
      )
      .then(into.closeUnlessEnded);
  }, end?.output);
}
