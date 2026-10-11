import type {
  Chunk,
  Json,
  Progress,
  RunStream,
  Terminal,
} from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import { type Dict, isDict, parsed } from '../wire/json.ts';
import { problem } from './errors.ts';
import { hinted } from './family.ts';
import { countsTo, stopOf } from './finish.ts';

// The counts are known only when the upstream has ended, so the start says
// none and the message_delta, whose counts are cumulative here, says them.
export function opening(id: string, model: string): Dict {
  return {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: countsTo(undefined),
  };
}

// One call per event, in order: it holds which block is open. Chunks of one
// kind and block number are one block. A thinking block must say a signature,
// so progress and another family's reasoning say an empty one, nobody's.
export function writer(
  shown: boolean,
): (event: Chunk | Progress | Terminal) => Dict[] {
  let index = -1;
  let open: string | undefined;
  let calling = false;
  let input = '';
  const begun = new Set<string>();
  const waiting = new Map<string, { block: Dict; json: string }>();
  const delta = (fields: Dict): Dict => ({
    type: 'content_block_delta',
    index,
    delta: fields,
  });
  const argued = (json: string): Dict[] =>
    json === ''
      ? []
      : [delta({ type: 'input_json_delta', partial_json: json })];
  // This wire streams one block at a time, so a call that began while
  // another was still being written waited: each goes out whole once that
  // one ends. Input that parses is whole, so the next call streams at once.
  const closed = (): Dict[] => {
    if (open === undefined) return [];
    open = undefined;
    calling = false;
    const out: Dict[] = [{ type: 'content_block_stop', index }];
    for (const { block, json } of waiting.values()) {
      index += 1;
      out.push(
        { type: 'content_block_start', index, content_block: block },
        ...argued(json),
        { type: 'content_block_stop', index },
      );
    }
    waiting.clear();
    return out;
  };
  const within = (key: string, block: Dict): Dict[] => {
    if (open === key) return [];
    const stop = closed();
    index += 1;
    open = key;
    return [
      ...stop,
      { type: 'content_block_start', index, content_block: block },
    ];
  };
  const said = (key: string, text: string): Dict[] => [
    ...within(key, { type: 'text', text: '' }),
    ...(text === '' ? [] : [delta({ type: 'text_delta', text })]),
  ];
  const thought = (key: string, thinking: string, signature?: Json): Dict[] => [
    ...within(key, { type: 'thinking', thinking: '', signature: '' }),
    ...(thinking === '' ? [] : [delta({ type: 'thinking_delta', thinking })]),
    ...(typeof signature === 'string'
      ? [delta({ type: 'signature_delta', signature })]
      : []),
  ];
  return (event) => {
    switch (event.type) {
      case 'progress':
        return shown ? thought(`progress ${event.piece}`, event.text) : [];
      case 'text':
      case 'refusal':
        // A whole reply is these blocks folded, and it takes no empty text.
        return event.text === '' ? [] : said(`text ${event.block}`, event.text);
      case 'citation': {
        // Every citation form of this API locates its source by an index
        // only Anthropic gives, so another family's cannot be written.
        const citation = hinted(event.provider);
        if (Object.keys(citation).length === 0) return [];
        return [
          ...said(`text ${event.block}`, ''),
          delta({ type: 'citations_delta', citation }),
        ];
      }
      case 'reasoning': {
        const block = hinted(event.provider);
        const { type, signature } = block;
        return type === 'redacted_thinking'
          ? [...within(`redacted ${event.block}`, block), ...closed()]
          : thought(`thinking ${event.block}`, event.text, signature);
      }
      case 'tool_call': {
        const { id, name = '', arguments: json } = event;
        const key = `tool ${id}`;
        if (open === key) {
          input += json;
          return argued(json);
        }
        const held = waiting.get(id);
        if (held !== undefined) {
          waiting.set(id, { ...held, json: held.json + json });
          return [];
        }
        // Its block has ended and cannot be opened again. Input cut there
        // does not parse, so the caller sees a failed call, not a wrong one.
        if (begun.has(id)) return [];
        begun.add(id);
        const type = event.hosted === true ? 'server_tool_use' : 'tool_use';
        const block: Dict = { type, id, name, input: {} };
        if (calling && (waiting.size > 0 || !isDict(parsed(input)))) {
          waiting.set(id, { block, json });
          return [];
        }
        const start = within(key, block);
        calling = true;
        input = json;
        return [...start, ...argued(json)];
      }
      case 'provider': {
        const block = hinted(event.provider);
        if (Object.keys(block).length === 0) return [];
        return [...within(`provider ${index}`, block), ...closed()];
      }
      case 'finish': {
        const { stop_sequence: sequence = null } = hinted(event.provider);
        return [
          ...closed(),
          {
            type: 'message_delta',
            delta: { stop_reason: stopOf(event), stop_sequence: sequence },
            usage: countsTo(event.usage),
          },
          { type: 'message_stop' },
        ];
      }
      case 'error':
        return [problem(event.error)];
      // A result or a file the model made has no block in this API unless
      // it came from this family, and then it came as the block itself. The
      // reply ends before either gets here.
      case 'tool_result':
      case 'file':
        return [];
    }
  };
}

function sent(event: Dict): ServerSentEvent {
  const { type } = event;
  return {
    ...(typeof type === 'string' ? { event: type } : {}),
    data: JSON.stringify(event),
  };
}

export async function* streamed(
  events: RunStream,
  id: string,
  model: string,
  shown: boolean,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  yield sent({ type: 'message_start', message: opening(id, model) });
  const write = writer(shown);
  for await (const event of events) {
    for (const out of write(event)) yield sent(out);
  }
}
