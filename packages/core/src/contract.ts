import type { ErrorFacts } from './data/errors.ts';
import type { Finish, StreamEvent, Usage } from './data/event.ts';
import type {
  ChatRequest,
  Json,
  JsonOutput,
  Prompt,
  ReadonlyJson,
} from './data/message.ts';

// From the global registry, so a bundle's SDK copy and the host's agree on it.
export const mark = Symbol.for('@mottyjs/core');

export const version = 1;

// Exactly one terminal event, finish or error, and it is the last.
export type EventStream = AsyncIterable<StreamEvent>;

export type Progress = {
  readonly type: 'progress';
  readonly piece: number;
  readonly text: string;
};

// Progress comes only ahead of the answer's first chunk, and the one terminal
// event is the last whether the request answered, failed or was stopped.
export type RunStream = AsyncIterable<StreamEvent | Progress>;

export type ModelCall = (
  model: string,
  prompt: Prompt<JsonOutput>,
  signal: AbortSignal,
) => EventStream;

// The core does not know the decision vocabulary: JSON in, JSON out.
export type DecisionCall = (
  model: string,
  input: ReadonlyJson,
  signal: AbortSignal,
) => Promise<Json>;

export type Storage = {
  get: (key: string) => Promise<Json | undefined>;
  set: (
    key: string,
    value: ReadonlyJson,
    options?: { ttlMs?: number },
  ) => Promise<void>;
  delete: (key: string) => Promise<void>;
  // Absent on a host that cannot add in one step of its database.
  increment?: (
    key: string,
    by: number,
    options?: { ttlMs?: number },
  ) => Promise<number>;
};

export type Caller = { id: string };

export type Limits = { calls?: number; afterResponseMs?: number };

// A bound that is no number would refuse nothing, with no word of it.
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

export type Host = {
  models: ModelCall;
  decisions?: DecisionCall;
  signal: AbortSignal;
  storage?: Storage;
  caller?: Caller;
  settings?: { [group: string]: Json };
  limits?: Limits;
  // Called once, when the request is over. Nothing is collected without it.
  record?: (record: RequestRecord) => void;
};

// A caller who left gets no terminal event, so why the request ended is here.
export type RequestRecord = {
  outcome: 'completed' | 'aborted' | 'failed';
  error?: ErrorFacts;
  path: string[];
  entries: string[];
  part?: string;
  calls: (Usage & {
    model: string;
    latencyMs: number;
    firstEventMs?: number;
    code?: ErrorFacts['code'];
    // What the failure said, so one a fallback recovered from is still told.
    message?: string;
    warnings?: NonNullable<Finish['warnings']>;
  })[];
  usage: Usage;
  answerMs: number;
  totalMs: number;
  afterResponse: {
    failed: { part: string; error: ErrorFacts }[];
    // The hooks the time limit left no time for.
    skipped: string[];
    // The hooks typed to read a value that an early answer left unmade.
    unreached: string[];
  };
};

export type Description = {
  sdk: string;
  name: string;
  plugins: string[];
};

export type Contract = {
  version: number;
  description: Description;
  run: (request: ChatRequest, host: Host) => RunStream;
};

export type Marked = { readonly [mark]: Contract };

export function isMarked(value: unknown): value is Marked {
  return (
    ((typeof value === 'object' && value !== null) ||
      typeof value === 'function') &&
    mark in value
  );
}
