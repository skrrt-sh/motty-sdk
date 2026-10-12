import type {
  Chunk,
  Finish,
  Json,
  StreamEvent,
  Terminal,
} from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import { cutShort, unreadable } from '../wire/broken-stream.ts';
import { type Dict, dict, isDict, number, parsed } from '../wire/json.ts';
import type { Clean } from '../wire/upstream-failure.ts';
import { type Held, whole } from './deltas.ts';
import { failed } from './errors.ts';
import { family, marked } from './family.ts';
import { besides, counted, countsOf, merged, reasonOf } from './finish.ts';
import { cited } from './parts.ts';

type Placed = { block?: number };

function signed(data: Dict, placed: Placed): Chunk {
  return {
    type: 'reasoning',
    text: '',
    ...placed,
    provider: { [family]: data },
  };
}

function passedWhole(held: Held, placed: Placed): Chunk {
  return { type: 'provider', ...placed, provider: { [family]: whole(held) } };
}

function started(block: Dict, placed: Placed): Chunk[] | undefined {
  const { type, ...fields } = block;
  switch (type) {
    case 'text': {
      const { text } = fields;
      return typeof text === 'string' && text !== ''
        ? [{ type: 'text', text, ...placed }]
        : [];
    }
    case 'thinking': {
      const { thinking, signature } = fields;
      // The signature travels apart from the text, as it does in a delta: a
      // caller of another API is given the text and not the signature.
      const said: Chunk[] =
        typeof thinking === 'string' && thinking !== ''
          ? [{ type: 'reasoning', text: thinking, ...placed }]
          : [];
      return typeof signature === 'string' && signature !== ''
        ? [...said, signed({ signature }, placed)]
        : said;
    }
    // Redacted thinking is reasoning nobody may read: it comes whole and
    // goes back as it came.
    case 'redacted_thinking':
      return [signed(block, placed)];
    case 'tool_use':
    case 'server_tool_use': {
      const { id, name, input, ...rest } = fields;
      if (typeof id !== 'string') return [];
      const full = isDict(input) && Object.keys(input).length > 0;
      const hosted = type === 'server_tool_use';
      // Its own type marks a call this API's upstream ran as this API's.
      const unread = hosted ? { ...rest, type } : rest;
      return [
        {
          type: 'tool_call',
          id,
          ...(typeof name === 'string' ? { name } : {}),
          arguments: full ? JSON.stringify(input) : '',
          ...(hosted ? { hosted } : {}),
          ...placed,
          // An empty field is kept too, so a call reads the same streamed as
          // it does sent back whole.
          ...(Object.keys(unread).length === 0
            ? {}
            : { provider: { [family]: unread } }),
        },
      ];
    }
    default:
      return typeof type === 'string' ? undefined : [];
  }
}

function continued(
  delta: Dict,
  placed: Placed,
  call: string | undefined,
): Chunk | undefined {
  const { type, text, thinking, signature, partial_json: json } = delta;
  switch (type) {
    case 'text_delta':
      return typeof text === 'string'
        ? { type: 'text', text, ...placed }
        : undefined;
    case 'thinking_delta':
      return typeof thinking === 'string'
        ? { type: 'reasoning', text: thinking, ...placed }
        : undefined;
    case 'signature_delta':
      return typeof signature === 'string'
        ? signed({ signature }, placed)
        : undefined;
    case 'input_json_delta':
      return typeof json === 'string' && call !== undefined
        ? { type: 'tool_call', id: call, arguments: json, ...placed }
        : undefined;
    case 'citations_delta': {
      const { citation } = delta;
      return isDict(citation) ? { ...cited(citation), ...placed } : undefined;
    }
    default:
      return undefined;
  }
}

// What the message says that is not read here rides as this family's own,
// each field under its own name and what sat beside the delta kept apart.
function ended(start: Dict, stop: Dict, counts: Dict, beside: Dict): Finish {
  const { id, model, type, role, content, ...opened } = start;
  const { stop_reason: reason, ...said } = stop;
  const { usage, rest } = counted(counts);
  return {
    type: 'finish',
    reason: reasonOf(reason),
    usage,
    ...(typeof reason === 'string' ? { rawReason: reason } : {}),
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...marked({ ...opened, ...said, usage: rest, message_delta: beside }),
  };
}

// Ends in exactly one terminal event whatever the upstream sends. A stream
// cut after the stop reason arrived has still said everything, so it
// finishes; one cut before it, or with data that cannot be read, failed.
export async function* events(
  messages: AsyncIterable<ServerSentEvent>,
  clean?: Clean,
): AsyncGenerator<StreamEvent, void, undefined> {
  const calls = new Map<number | undefined, string>();
  // The calls that have said no input yet. One that ends so takes nothing,
  // which the two OpenAI APIs write as an empty object and never as no text.
  const bare = new Map<number | undefined, string>();
  // A reply cut short stops its last block too, so a block's stop does not
  // say its call is whole. The start of the next block does.
  const own = new Map<number | undefined, string>();
  let ending: Chunk | undefined;
  // A block not read here may get its content in deltas, so it is told when
  // it ends. This wire sends one block at a time, so the next block's start
  // ends it as well, and every block is told in the order it came.
  let held: { at: number | undefined; open: Held } | undefined;
  let start: Dict = {};
  let stop: Dict = {};
  let counts: Dict = {};
  let beside: Dict = {};
  let last: Terminal | undefined;
  function* unended(): Generator<Chunk, void, undefined> {
    if (held === undefined) return;
    const { at, open } = held;
    held = undefined;
    yield passedWhole(open, at === undefined ? {} : { block: at });
  }
  try {
    reading: for await (const { data } of messages) {
      const event: Json | undefined = parsed(data);
      if (!isDict(event)) {
        last = { type: 'error', error: unreadable(), usage: countsOf(counts) };
        break;
      }
      const { type, index, message, content_block, delta, usage } = event;
      const at = number(index);
      const placed = at === undefined ? {} : { block: at };
      switch (type) {
        case 'message_start': {
          start = merged(start, dict(message));
          const { usage: opened } = start;
          counts = merged(counts, dict(opened));
          break;
        }
        case 'content_block_start': {
          yield* unended();
          if (ending !== undefined) yield ending;
          ending = undefined;
          const block = dict(content_block);
          const chunks = started(block, placed);
          if (chunks === undefined) {
            held = { at, open: { block, deltas: [] } };
            break;
          }
          for (const chunk of chunks) {
            if (chunk.type === 'tool_call') {
              calls.set(at, chunk.id);
              if (chunk.hosted !== true) own.set(at, chunk.id);
              if (chunk.arguments === '') bare.set(at, chunk.id);
            }
            yield chunk;
          }
          break;
        }
        case 'content_block_delta': {
          // Every delta at a held block's place is its own, one of a kind
          // read elsewhere too, so nothing it says is told ahead of it.
          if (held !== undefined && held.at === at) {
            held.open.deltas.push(dict(delta));
            break;
          }
          const chunk = continued(dict(delta), placed, calls.get(at));
          if (chunk === undefined) break;
          if (chunk.type === 'tool_call' && chunk.arguments !== '') {
            bare.delete(at);
          }
          yield chunk;
          break;
        }
        case 'content_block_stop': {
          if (held !== undefined && held.at === at) yield* unended();
          calls.delete(at);
          const call = own.get(at);
          if (call !== undefined) {
            own.delete(at);
            ending = {
              type: 'tool_call',
              id: call,
              arguments: '',
              ended: true,
              ...placed,
            };
          }
          const id = bare.get(at);
          if (id === undefined) break;
          bare.delete(at);
          yield { type: 'tool_call', id, arguments: '{}', ...placed };
          break;
        }
        case 'message_delta':
          stop = merged(stop, dict(delta));
          counts = merged(counts, dict(usage));
          beside = merged(beside, besides(event));
          break;
        case 'message_stop':
          last = ended(start, stop, counts, beside);
          break reading;
        case 'error':
          // Told inside a stream it has no status, so only its name tells it.
          last = {
            type: 'error',
            error: failed(event, clean),
            usage: countsOf(counts),
          };
          break reading;
      }
    }
  } catch (error) {
    yield* unended();
    throw error;
  }
  yield* unended();
  const { stop_reason: reason } = stop;
  yield last ??
    (typeof reason === 'string'
      ? ended(start, stop, counts, beside)
      : { type: 'error', error: cutShort(), usage: countsOf(counts) });
}
