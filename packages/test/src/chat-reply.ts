import { MottyError } from '@mottyjs/core';
import {
  type Chunk,
  type EventStream,
  type Finish,
  type JsonOutput,
  type Prompt,
  type ReadonlyJson,
  type StreamEvent,
  toFacts,
} from '@mottyjs/core/host';

// A list of chunks may end with the finish event, for a reply that ends in
// another way than a plain stop or that states its usage.
type Scripted =
  | string
  | readonly Chunk[]
  | readonly [...Chunk[], Finish]
  | { readonly [key: string]: ReadonlyJson }
  | MottyError;

// What a function may give besides: chunks that come one at a time.
type Late = AsyncIterable<Chunk | Finish>;

export type ChatReply =
  | Scripted
  | ((
      prompt: Prompt<JsonOutput>,
      signal: AbortSignal,
    ) => Scripted | Late | Promise<Scripted | Late>);

// The standard check tells a list that may be changed, so a read-only one
// would be left in the type on both sides of it.
export function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function said(text: string): StreamEvent[] {
  return [
    { type: 'text', text },
    { type: 'finish', reason: 'stop' },
  ];
}

function isLate(scripted: Scripted | Late): scripted is Late {
  return typeof scripted === 'object' && Symbol.asyncIterator in scripted;
}

function events(scripted: Scripted): StreamEvent[] {
  if (typeof scripted === 'string') return said(scripted);
  if (scripted instanceof MottyError) {
    return [{ type: 'error', error: toFacts(scripted) }];
  }
  if (!isList(scripted)) return said(JSON.stringify(scripted));
  return scripted.at(-1)?.type === 'finish'
    ? [...scripted]
    : [...scripted, { type: 'finish', reason: 'stop' }];
}

// A stopped call ends with no event more, as an upstream that was hung up on:
// a script still waiting must not hold the call it was written for.
export async function* chatEvents(
  reply: ChatReply,
  prompt: Prompt<JsonOutput>,
  signal: AbortSignal,
): EventStream {
  if (typeof reply !== 'function') return yield* events(reply);
  if (signal.aborted) return;
  const stopped = new Promise<undefined>((resolve) => {
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
  });
  const scripted = await Promise.race([reply(prompt, signal), stopped]);
  if (scripted === undefined) return;
  if (!isLate(scripted)) return yield* events(scripted);
  const source = scripted[Symbol.asyncIterator]();
  try {
    while (true) {
      const read = await Promise.race([source.next(), stopped]);
      if (read === undefined) return;
      if (read.done) break;
      yield read.value;
      if (read.value.type === 'finish') return;
    }
    yield { type: 'finish', reason: 'stop' };
  } finally {
    // Not awaited: a script that never answers its close holds nobody.
    (async () => source.return?.())().catch(() => {});
  }
}
