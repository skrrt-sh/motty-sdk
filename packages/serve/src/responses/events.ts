import type {
  Chunk,
  FinishReason,
  Json,
  StreamEvent,
  Usage,
} from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import { cutShort, unreadable } from '../wire/broken-stream.ts';
import { inline } from '../wire/data-url.ts';
import {
  type Dict,
  dict,
  given,
  isDict,
  list,
  number,
  parsed,
  text,
  without,
} from '../wire/json.ts';
import { failed } from '../wire/openai-failure.ts';
import type { Clean, Cut, FailureReader } from '../wire/upstream-failure.ts';
import { family, marked } from './family.ts';
import { callUncarried, field, isCustom } from './fields.ts';
import { reasoned, reasonedWhole } from './reasoning.ts';

// What has been passed on of one output item, so its end adds only the rest.
// A message's phase waits for text to ride on, and a call's own data is
// held as the text it was last told in.
type Seen = {
  call?: string;
  given: number;
  said: boolean;
  done?: true;
  phase: string | undefined;
  phased?: string;
  told?: string;
  early?: string;
};

function usageOf(response: Dict): { usage?: Usage } {
  const { usage } = response;
  if (!isDict(usage)) return {};
  const {
    input_tokens,
    output_tokens,
    input_tokens_details,
    output_tokens_details,
    cost: charged,
  } = usage;
  const input = number(input_tokens);
  const output = number(output_tokens);
  const { cached_tokens, cache_write_tokens } = dict(input_tokens_details);
  const cached = number(cached_tokens);
  const cacheWrite = number(cache_write_tokens);
  const reasoning = number(field(output_tokens_details, 'reasoning_tokens'));
  const cost = number(charged);
  return {
    usage: {
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      ...(cached === undefined ? {} : { cached }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(cost === undefined ? {} : { cost }),
    },
  };
}

function cut(reason: string | undefined): FinishReason {
  if (reason === 'max_output_tokens') return 'length';
  return reason === 'content_filter' ? 'content_filter' : 'other';
}

// The rest of a response echoes the request its upstream was sent, so only
// what tells the outcome goes back to a caller of this family.
function beyond({ end_turn, incomplete_details }: Dict) {
  return marked(given({ end_turn, incomplete_details }));
}

function ending(
  event: Dict,
  called: boolean,
  byProvider?: FailureReader,
  cuts?: readonly Cut[],
  clean?: Clean,
): StreamEvent | undefined {
  const response = dict(field(event, 'response'));
  const id = text(field(response, 'id'));
  const model = text(field(response, 'model'));
  const told = {
    ...usageOf(response),
    ...(id === undefined ? {} : { id }),
    ...(model === undefined ? {} : { model }),
  };
  switch (field(event, 'type')) {
    case 'response.completed':
      return {
        type: 'finish',
        reason: called ? 'tool_calls' : 'stop',
        rawReason: 'completed',
        ...told,
        ...beyond(response),
      };
    case 'response.incomplete': {
      const reason = text(
        field(field(response, 'incomplete_details'), 'reason'),
      );
      return {
        type: 'finish',
        reason: cut(reason),
        rawReason: reason ?? 'incomplete',
        ...told,
        ...beyond(response),
      };
    }
    case 'response.failed':
      return {
        type: 'error',
        error: failed(
          family,
          dict(field(response, 'error')),
          byProvider,
          cuts,
          clean,
        ),
        ...usageOf(response),
      };
    case 'error': {
      const { error } = event;
      return {
        type: 'error',
        error: failed(
          family,
          isDict(error) ? error : without(event, ['type', 'sequence_number']),
          byProvider,
          cuts,
          clean,
        ),
      };
    }
    default:
      return undefined;
  }
}

function seenAt(items: Map<number, Seen>, event: Dict): [number, Seen] {
  const index = number(field(event, 'output_index')) ?? 0;
  const seen = items.get(index) ?? {
    given: 0,
    said: false,
    phase: undefined,
  };
  items.set(index, seen);
  return [index, seen];
}

// No neutral field tells a call to a custom tool, so its type rides with
// the rest. An item is read anew at each event, so what was told is compared
// as text, and told again for its fields' order alone it costs one chunk.
function untold(seen: Seen, item: Dict) {
  const more = {
    ...without(item, callUncarried),
    ...(isCustom(item) ? { type: 'custom_tool_call' } : {}),
  };
  const said = JSON.stringify(more);
  if (said === '{}' || said === seen.told) return {};
  seen.told = said;
  return { provider: { [family]: more } };
}

function fragment(
  block: number,
  seen: Seen,
  item: Dict,
  more: string,
  last = false,
) {
  const { call_id: id, name } = item;
  const first = seen.call === undefined;
  seen.call ??= text(id) ?? `call_${block}`;
  seen.given += more.length;
  const chunk: Chunk & { type: 'tool_call' } = {
    type: 'tool_call',
    id: seen.call,
    ...(first && typeof name === 'string' ? { name } : {}),
    ...(first || last ? untold(seen, item) : {}),
    arguments: more,
    block,
  };
  return chunk;
}

function phased(seen: Seen, item: Dict): void {
  const phase = text(field(item, 'phase'));
  if (phase !== seen.phased) seen.phase = phase;
}

function started(block: number, seen: Seen, item: Dict): Chunk[] {
  switch (field(item, 'type')) {
    case 'function_call':
    case 'custom_tool_call':
      return [fragment(block, seen, item, seen.early ?? '')];
    case 'reasoning':
      return [
        { type: 'reasoning', text: '', block, provider: { [family]: item } },
      ];
    case 'message':
      phased(seen, item);
      return [];
    default:
      return [];
  }
}

// How the bytes of each kind of picture begin, in base64. A WebP shares its
// container with sound, so it is told by the name inside.
const signatures = {
  'image/png': /^iVBORw0KGgo/,
  'image/jpeg': /^\/9j\//,
  'image/gif': /^R0lGOD[dl]h/,
  'image/webp': /^UklGR.{6}XRUJQ/,
};

// A picture the model made is a file like any other, and its item stays
// this family's. One router writes the result as a data address; bare bytes
// are of the type the item names, or else of the type they begin as.
function pictured(block: number, item: Dict): Chunk {
  const { result, output_format: format } = item;
  const provider = { [family]: item };
  const made = typeof result === 'string' ? result : '';
  const [mediaType] =
    typeof format === 'string'
      ? [`image/${format}`]
      : (Object.entries(signatures).find(([, begins]) => begins.test(made)) ??
        []);
  const media =
    inline(made) ??
    (mediaType === undefined || made === ''
      ? undefined
      : { data: made, mediaType });
  return media === undefined
    ? { type: 'provider', block, provider }
    : { type: 'file', ...media, block, provider };
}

// An upstream that sent an item whole, with no pieces before it, is still
// read in full: the end of an item adds whatever its pieces did not bring.
function ended(block: number, seen: Seen, item: Dict): Chunk[] {
  switch (field(item, 'type')) {
    case 'function_call':
    case 'custom_tool_call': {
      const whole =
        text(field(item, 'arguments')) ??
        text(field(item, 'input')) ??
        seen.early ??
        '';
      const rest = whole.slice(seen.given);
      const opened = seen.call !== undefined;
      const piece = fragment(block, seen, item, rest, true);
      seen.done = true;
      // An item that was cut short is done as well, and is not whole.
      if (field(item, 'status') !== 'incomplete') {
        return [{ ...piece, ended: true }];
      }
      return opened && rest === '' && piece.provider === undefined
        ? []
        : [piece];
    }
    case 'reasoning':
      return [
        ...(seen.said ? [] : reasonedWhole(block, item)),
        { type: 'reasoning', text: '', block, provider: { [family]: item } },
      ];
    case 'message': {
      phased(seen, item);
      const content = seen.said ? [] : list(field(item, 'content'));
      const parts = content.flatMap((part): Chunk[] => {
        const { type, text: said, refusal, annotations } = dict(part);
        if (type === 'output_text' && typeof said === 'string') {
          return [
            spoken(block, seen, 'text', said),
            ...list(annotations).map((annotation) => cited(block, annotation)),
          ];
        }
        return type === 'refusal' && typeof refusal === 'string'
          ? [spoken(block, seen, 'refusal', refusal)]
          : [];
      });
      return [...parts, ...unsaid(block, seen)];
    }
    case 'image_generation_call':
      return [pictured(block, item)];
    default:
      return typeof field(item, 'type') === 'string'
        ? [{ type: 'provider', block, provider: { [family]: item } }]
        : [];
  }
}

function cited(block: number, raw: Json | undefined): Chunk {
  const annotation = dict(raw);
  const { url, title, filename } = annotation;
  const named = text(title) ?? text(filename);
  return {
    type: 'citation',
    ...(typeof url === 'string' ? { url } : {}),
    ...(named === undefined ? {} : { title: named }),
    block,
    provider: { [family]: annotation },
  };
}

function owed(seen: Seen) {
  const { phase } = seen;
  if (phase === undefined) return undefined;
  seen.phase = undefined;
  seen.phased = phase;
  return { provider: { [family]: { phase } } };
}

function spoken(
  block: number,
  seen: Seen,
  type: 'text' | 'refusal',
  said: string,
): Chunk {
  seen.said = true;
  return { type, text: said, block, ...owed(seen) };
}

// A citation's data is its annotation, and an item may tell its phase only
// as it ends, so a phase with no text to ride on goes in text that is empty.
function unsaid(block: number, seen: Seen): Chunk[] {
  const more = owed(seen);
  return more === undefined ? [] : [{ type: 'text', text: '', block, ...more }];
}

function read(event: Dict, items: Map<number, Seen>): Chunk[] {
  const [block, seen] = seenAt(items, event);
  const delta = text(field(event, 'delta')) ?? '';
  switch (field(event, 'type')) {
    case 'response.output_item.added':
      return started(block, seen, dict(field(event, 'item')));
    case 'response.output_item.done':
      return ended(block, seen, dict(field(event, 'item')));
    case 'response.output_text.delta':
      return [spoken(block, seen, 'text', delta)];
    case 'response.refusal.delta':
      return [spoken(block, seen, 'refusal', delta)];
    case 'response.reasoning_summary_part.added':
    case 'response.content_part.added': {
      // One reasoning item may hold several parts of a kind, each its own
      // paragraph.
      const kind = field(field(event, 'part'), 'type');
      const { summary_index, content_index } = event;
      return (kind === 'summary_text' || kind === 'reasoning_text') &&
        (number(summary_index ?? content_index) ?? 0) > 0
        ? [reasoned(block, kind, '\n\n')]
        : [];
    }
    case 'response.reasoning_summary_text.delta':
      seen.said = true;
      return [reasoned(block, 'summary_text', delta)];
    case 'response.reasoning_text.delta':
      seen.said = true;
      return [reasoned(block, 'reasoning_text', delta)];
    case 'response.function_call_arguments.delta':
    case 'response.custom_tool_call_input.delta':
      // A piece after its item was done would add to a call told as ended.
      if (seen.done) return [];
      // A piece that comes before its item has no id and no name to go
      // under, so it waits for the item.
      if (seen.call === undefined) {
        seen.early = `${seen.early ?? ''}${delta}`;
        return [];
      }
      return [fragment(block, seen, {}, delta)];
    case 'response.output_text.annotation.added':
      return [...unsaid(block, seen), cited(block, field(event, 'annotation'))];
    default:
      return [];
  }
}

// Exactly one event ends the stream: the upstream's own, or an error made
// here when the upstream stopped without one or sent what cannot be read.
export async function* events(
  messages: AsyncIterable<ServerSentEvent>,
  byProvider?: FailureReader,
  cuts?: readonly Cut[],
  clean?: Clean,
): AsyncGenerator<StreamEvent, void, undefined> {
  const items = new Map<number, Seen>();
  let called = false;
  for await (const { data } of messages) {
    if (data === '[DONE]') break;
    const event = parsed(data);
    if (!isDict(event)) {
      yield { type: 'error', error: unreadable() };
      return;
    }
    const last = ending(event, called, byProvider, cuts, clean);
    if (last !== undefined) {
      yield last;
      return;
    }
    for (const chunk of read(event, items)) {
      called ||= chunk.type === 'tool_call';
      yield chunk;
    }
  }
  yield { type: 'error', error: cutShort() };
}
