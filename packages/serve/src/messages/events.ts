import type { Chunk, Finish, Json, StreamEvent } from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import { cutShort, unreadable } from '../wire/broken-stream.ts';
import {
  type Dict,
  dict,
  given,
  isDict,
  number,
  parsed,
} from '../wire/json.ts';
import type { Clean } from '../wire/upstream-failure.ts';
import { failed } from './errors.ts';
import { family, marked } from './family.ts';
import { countsOf, merged, reasonOf } from './finish.ts';
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

function started(block: Dict, placed: Placed): Chunk[] {
  const { type, text, thinking, signature, id, name, input, ...rest } = block;
  switch (type) {
    case 'text':
      return typeof text === 'string' && text !== ''
        ? [{ type: 'text', text, ...placed }]
        : [];
    case 'thinking': {
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
      if (typeof id !== 'string') return [];
      const whole = isDict(input) && Object.keys(input).length > 0;
      const hosted = type === 'server_tool_use';
      return [
        {
          type: 'tool_call',
          id,
          ...(typeof name === 'string' ? { name } : {}),
          arguments: whole ? JSON.stringify(input) : '',
          ...(hosted ? { hosted } : {}),
          ...placed,
          // Its own type marks a call this API's upstream ran as this API's.
          ...marked(hosted ? { ...rest, type } : rest),
        },
      ];
    }
    default:
      // A block this codec does not read comes whole and goes back as it
      // came.
      return [{ type: 'provider', ...placed, provider: { [family]: block } }];
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

function ended(start: Dict, stop: Dict, counts: Dict): Finish {
  const { id, model } = start;
  const { stop_reason: reason, stop_sequence: sequence, stop_details } = stop;
  return {
    type: 'finish',
    reason: reasonOf(reason),
    usage: countsOf(counts),
    ...(typeof reason === 'string' ? { rawReason: reason } : {}),
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...marked(
      given({
        stop_sequence: sequence ?? undefined,
        stop_details: stop_details ?? undefined,
      }),
    ),
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
  let start: Dict = {};
  let stop: Dict = {};
  let counts: Dict = {};
  for await (const { data } of messages) {
    const event: Json | undefined = parsed(data);
    if (!isDict(event)) {
      yield { type: 'error', error: unreadable(), usage: countsOf(counts) };
      return;
    }
    const { type, index, message, content_block: block, delta, usage } = event;
    const at = number(index);
    const placed = at === undefined ? {} : { block: at };
    switch (type) {
      case 'message_start': {
        start = dict(message);
        const { usage: opened } = start;
        counts = merged(counts, dict(opened));
        break;
      }
      case 'content_block_start': {
        for (const chunk of started(dict(block), placed)) {
          if (chunk.type === 'tool_call') {
            calls.set(at, chunk.id);
            if (chunk.arguments === '') bare.set(at, chunk.id);
          }
          yield chunk;
        }
        break;
      }
      case 'content_block_delta': {
        const chunk = continued(dict(delta), placed, calls.get(at));
        if (chunk === undefined) break;
        if (chunk.type === 'tool_call' && chunk.arguments !== '') {
          bare.delete(at);
        }
        yield chunk;
        break;
      }
      case 'content_block_stop': {
        const id = bare.get(at);
        if (id === undefined) break;
        bare.delete(at);
        yield { type: 'tool_call', id, arguments: '{}', ...placed };
        break;
      }
      case 'message_delta':
        stop = merged(stop, dict(delta));
        counts = merged(counts, dict(usage));
        break;
      case 'message_stop':
        yield ended(start, stop, counts);
        return;
      case 'error':
        // Told inside a stream it has no status: only its own name tells it.
        yield {
          type: 'error',
          error: failed(event, clean),
          usage: countsOf(counts),
        };
        return;
    }
  }
  const { stop_reason: reason } = stop;
  yield typeof reason === 'string'
    ? ended(start, stop, counts)
    : { type: 'error', error: cutShort(), usage: countsOf(counts) };
}
