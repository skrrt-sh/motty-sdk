import type { ErrorFacts } from './errors.ts';
import type { Closed, Json, ProviderData } from './message.ts';

type Data = Readonly<ProviderData>;

// Fragments with one id are one call: the name comes with the first and the
// arguments concatenate.
type KnownChunk =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string }
  | {
      readonly type: 'tool_call';
      readonly id: string;
      readonly name?: string;
      readonly arguments: string;
      readonly hosted?: boolean;
    }
  | {
      readonly type: 'tool_result';
      readonly id: string;
      readonly output: Json;
      readonly failed?: boolean;
      readonly hosted?: boolean;
    }
  | {
      readonly type: 'file';
      readonly data: string;
      readonly url?: never;
      readonly id?: never;
      readonly mediaType: string;
    }
  | {
      readonly type: 'file';
      readonly url: string;
      readonly data?: never;
      readonly id?: never;
      readonly mediaType?: string;
    }
  | {
      readonly type: 'file';
      readonly id: string;
      readonly data?: never;
      readonly url?: never;
      readonly mediaType?: string;
    }
  | {
      readonly type: 'citation';
      readonly title?: string;
      readonly url?: string;
      readonly text?: string;
    }
  | { readonly type: 'refusal'; readonly text: string };

// Chunks with the same block number are one block of the answer; a new number
// starts a new one, so two adjacent blocks of a kind stay apart.
export type Chunk =
  | (KnownChunk & {
      readonly block?: number;
      readonly provider?: Data;
    })
  | {
      readonly type: 'provider';
      readonly block?: number;
      readonly provider: Data;
    };

// One meaning for every family: input counts every prompt token, cached reads
// and cache writes included; output includes reasoning. A count is absent when
// the upstream did not report it; a reported zero is a zero. The cost is the
// upstream's own figure in its own unit, US dollars from OpenRouter: it is
// never worked out here, and a total adds what each call reported.
export const counts = [
  'input',
  'output',
  'cached',
  'cacheWrite',
  'reasoning',
  'cost',
] as const;

export type Usage = { [Count in (typeof counts)[number]]?: number };

const reasons = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'pause',
  'other',
] as const;

export type FinishReason = (typeof reasons)[number];

export type Finish = {
  readonly type: 'finish';
  readonly reason: FinishReason;
  readonly usage?: Readonly<Usage>;
  readonly rawReason?: string;
  readonly id?: string;
  readonly model?: string;
  readonly warnings?: readonly {
    readonly setting: string;
    readonly detail?: string;
  }[];
  readonly provider?: Data;
};

export type Failed = {
  readonly type: 'error';
  readonly error: Closed<ErrorFacts>;
  readonly usage?: Readonly<Usage>;
};

export type Terminal = Finish | Failed;

export type StreamEvent = Chunk | Terminal;

type Fields<Shape> = Shape extends unknown ? keyof Shape : never;

// Every field an event may hold, each of a type not yet known.
type Loose = {
  readonly [Field in Fields<StreamEvent | Usage | ErrorFacts>]?: unknown;
};

const finishes: ReadonlySet<unknown> = new Set(reasons);

function loose(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null;
}

function maybeText(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function maybeFlag(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function maybeData(value: unknown): boolean {
  return value === undefined || (loose(value) && !Array.isArray(value));
}

function json(value: unknown): boolean {
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'object':
      return true;
    case 'number':
      return Number.isFinite(value);
    default:
      return false;
  }
}

function media({ data, url, id, mediaType }: Loose): boolean {
  if (data !== undefined) {
    return (
      typeof data === 'string' &&
      typeof mediaType === 'string' &&
      url === undefined &&
      id === undefined
    );
  }
  if (!maybeText(mediaType)) return false;
  return url === undefined
    ? typeof id === 'string'
    : typeof url === 'string' && id === undefined;
}

function isChunk(value: Loose): value is Chunk {
  const { type, block, provider } = value;
  if (block !== undefined && !Number.isFinite(block)) return false;
  if (!maybeData(provider)) return false;
  switch (type) {
    case 'text':
    case 'reasoning':
    case 'refusal':
      return typeof value.text === 'string';
    case 'tool_call':
      return (
        typeof value.id === 'string' &&
        typeof value.arguments === 'string' &&
        maybeText(value.name) &&
        maybeFlag(value.hosted)
      );
    case 'tool_result':
      return (
        typeof value.id === 'string' &&
        json(value.output) &&
        maybeFlag(value.failed) &&
        maybeFlag(value.hosted)
      );
    case 'file':
      return media(value);
    case 'citation':
      return (
        maybeText(value.title) && maybeText(value.url) && maybeText(value.text)
      );
    case 'provider':
      return provider !== undefined;
    default:
      return false;
  }
}

export function isTerminal(event: {
  readonly type: string;
}): event is Terminal {
  return event.type === 'finish' || event.type === 'error';
}

// Usage is left to be counted: a wrong count costs the count, not the event.
function ending(value: Loose): value is Terminal {
  switch (value.type) {
    case 'finish':
      return (
        finishes.has(value.reason) &&
        maybeText(value.rawReason) &&
        maybeText(value.id) &&
        maybeText(value.model) &&
        (value.warnings === undefined || Array.isArray(value.warnings)) &&
        maybeData(value.provider)
      );
    case 'error':
      return loose(value.error) && typeof value.error.code === 'string';
    default:
      return false;
  }
}

// Whole numbers this size add up exactly, so a total of them stays finite.
// A cost is an amount, whole or not.
function count(name: string, value: unknown): value is number {
  if (typeof value !== 'number' || value < 0) return false;
  return name === 'cost' ? Number.isFinite(value) : Number.isSafeInteger(value);
}

function sound(usage: unknown): usage is Usage {
  if (!loose(usage)) return false;
  for (const name of counts) {
    const reported = usage[name];
    if (reported !== undefined && !count(name, reported)) return false;
  }
  return true;
}

// Whoever reports usage, a host or a plugin: a wrong count is dropped and the
// rest kept, and usage with nothing wrong is given back as it is.
export function usageOf(reported: unknown): Usage {
  if (sound(reported)) return reported;
  const usage: Usage = {};
  if (loose(reported)) {
    for (const name of counts) {
      const value = reported[name];
      if (count(name, value)) usage[name] = value;
    }
  }
  return usage;
}

function counted(event: Terminal): Terminal {
  if (event.usage === undefined) return event;
  const usage = usageOf(event.usage);
  return usage === event.usage ? event : { ...event, usage };
}

// A failure that enters came from outside unless its host says it is the
// host's own; that word is taken and not kept, so the mark is there or absent.
function outside(event: Terminal): Terminal {
  if (event.type !== 'error') return event;
  const { upstream, ...error } = event.error;
  return {
    ...event,
    error: upstream === false ? error : { ...error, upstream: true },
  };
}

export function chunkOf(value: unknown): Chunk | undefined {
  return loose(value) && isChunk(value) ? value : undefined;
}

export function eventOf(value: unknown): StreamEvent | undefined {
  if (!loose(value)) return undefined;
  if (isChunk(value)) return value;
  return ending(value) ? outside(counted(value)) : undefined;
}
