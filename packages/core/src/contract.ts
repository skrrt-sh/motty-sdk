import type { ErrorFacts } from './data/errors.ts';
import type { Finish, StreamEvent, Usage } from './data/event.ts';
import {
  type ChatRequest,
  type Json,
  type JsonOutput,
  keyed,
  type Prompt,
  type ReadonlyJson,
} from './data/message.ts';

/**
 * The key a motty holds its contract under, shared by every copy of the SDK.
 */
export const mark = Symbol.for('@mottyjs/core');

/** The version of the contract between a motty and a host. */
export const version = 2;

/**
 * What a model call streams, with exactly one terminal event, finish or error,
 * as the last.
 */
export type EventStream = AsyncIterable<StreamEvent>;

/** A piece of progress a motty offered with `think`. */
export type Progress = {
  readonly type: 'progress';
  readonly piece: number;
  readonly text: string;
};

/**
 * Progress comes only ahead of the answer's first chunk, and the one terminal
 * event is the last whether the request answered, failed or was stopped.
 */
export type RunStream = AsyncIterable<StreamEvent | Progress>;

/**
 * Makes one model call by its full name, prefix included, and streams its
 * events.
 */
export type ModelCall = (
  model: string,
  prompt: Prompt<JsonOutput>,
  signal: AbortSignal,
) => EventStream;

/**
 * Makes one decision call. The core does not know the decision vocabulary, so
 * it is JSON in and JSON out.
 */
export type DecisionCall = (
  model: string,
  input: ReadonlyJson,
  signal: AbortSignal,
) => Promise<Json>;

/**
 * What a host stores with. A time to live is a whole number of ms, and a key
 * without one does not expire.
 */
export type Storage = {
  get: (key: string) => Promise<Json | undefined>;
  set: (
    key: string,
    value: ReadonlyJson,
    options?: { ttl?: number },
  ) => Promise<void>;
  delete: (key: string) => Promise<void>;
  /** Absent on a host that cannot add in one step of its database. */
  increment?: (
    key: string,
    by: number,
    options?: { ttl?: number },
  ) => Promise<number>;
};

/** Who is asking, as the auth adapter or the host proved it. */
export type Caller = { id: string };

/** What a host allows one request. */
export type Limits = {
  /**
   * The model calls one request may make, counting those in flight and those
   * after the response. Past it a call throws `LimitReached`. No limit unless
   * stated.
   */
  calls?: number;
  /** The time after-response hooks may take, in ms. The default is 30000. */
  afterResponse?: number;
};

// A timer given a longer delay than this fires after one millisecond.
export const timerMax = 2 ** 31 - 1;

/**
 * Gives a limit back once it is checked as a number of zero or more, and throws
 * on any other.
 */
export function bound(
  name: string,
  given: number | undefined,
  kind: 'finite' | 'whole' = 'finite',
): number | undefined {
  const counts = kind === 'whole' ? Number.isInteger : Number.isFinite;
  if (given !== undefined && !(counts(given) && given >= 0)) {
    throw new Error(`${name} must be a ${kind} number of zero or more`);
  }
  return given;
}

/** What a host hands a motty for one request. */
export type Host = {
  models: ModelCall;
  decisions?: DecisionCall;
  signal: AbortSignal;
  storage?: Storage;
  caller?: Caller;
  settings?: { [group: string]: Json };
  limits?: Limits;
  /** Called once, when the request is over. Nothing is collected without it. */
  record?: (record: RequestRecord) => void;
};

/**
 * What happened in one request, in ms for every time. A caller who left gets no
 * terminal event, so why the request ended is here.
 */
export type RequestRecord = {
  outcome: 'completed' | 'aborted' | 'failed';
  error?: ErrorFacts;
  path: string[];
  entries: string[];
  part?: string;
  calls: (Usage & {
    model: string;
    time: { total: number; firstEvent?: number };
    code?: ErrorFacts['code'];
    /**
     * What the failure said, so one a fallback recovered from is still told.
     */
    message?: string;
    /**
     * The upstream's own id for the response, to match a call against its logs.
     */
    id?: string;
    warnings?: NonNullable<Finish['warnings']>;
  })[];
  usage: Usage;
  time: { answer: number; total: number };
  afterResponse: {
    failed: { part: string; error: ErrorFacts }[];
    /** The hooks the time limit left no time for. */
    skipped: string[];
    /** The hooks typed to read a value that an early answer left unmade. */
    unreached: string[];
  };
};

/** What a motty says of itself, read by a host. */
export type Description = {
  sdk: string;
  name: string;
  plugins: string[];
};

// What a host may read of the chain a motty was built as: whether it answers,
// and the steps a part may stand under.
type Built = {
  readonly answers: boolean;
  readonly steps: readonly (
    | { readonly kind: 'use'; readonly part: Built }
    | {
        readonly kind: 'route';
        readonly table: {
          readonly [name: string]:
            | { readonly part: Built }
            | { readonly handler: object };
        };
      }
    | {
        readonly kind:
          | 'derive'
          | 'beforeHandle'
          | 'handle'
          | 'afterHandle'
          | 'afterResponse'
          | 'onError';
        readonly run: object;
      }
  )[];
};

/**
 * What a motty offers a host. `serve` and `mount` read it, and a custom host
 * may too.
 */
export type Contract = {
  version: number;
  description: Description;
  /**
   * For a host to refuse once, as it is made, what every request would fail on.
   * A motty of an older SDK has none to show.
   */
  root?: Built;
  run: (request: ChatRequest, host: Host) => RunStream;
};

/** Anything that carries a contract, a motty above all. */
export type Marked = { readonly [mark]: Contract };

/**
 * Tells whether a value carries a contract, whichever copy of the SDK made it.
 */
export function isMarked(value: unknown): value is Marked {
  return keyed(value) && mark in value;
}
