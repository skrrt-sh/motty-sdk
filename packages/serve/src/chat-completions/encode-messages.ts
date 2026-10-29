import type { Cache, Json, Message, Part, Role } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, given } from '../wire/json.ts';
import { asked, breakpoint, cacheFor } from '../wire/openai-cache.ts';
import { a, unsupported } from '../wire/refusals.ts';
import { thinking } from './content-chunks.ts';
import { type Dialect, inlined, plain, returned } from './dialect.ts';
import { audio, file, image } from './encode-media.ts';
import { hinted, mine, own } from './family.ts';
import { wireCall } from './unread.ts';

type Known = Exclude<Part, { type: 'provider' }>;

// OpenAI's own takes media from a user alone. A dialect may take it in a
// tool message too, and a picture a model made in a field of its own.
function placed(dialect: Dialect, role: Role, part: Known): void {
  const media =
    part.type === 'image' || part.type === 'audio' || part.type === 'file';
  if (!media || role === 'user') return;
  if (role === 'tool' && dialect.shown === true) return;
  unsupported(
    role === 'tool'
      ? `Chat Completions cannot carry ${a(part.type)} part in a tool result`
      : `Chat Completions takes no ${part.type} part from the ${role} role`,
  );
}

function shown(left: Leaving, dialect: Dialect, part: Known): Dict | undefined {
  switch (part.type) {
    case 'text':
      return { ...hinted(part.hints), type: 'text', text: part.text };
    case 'image':
      return image(left, dialect, part);
    case 'audio':
      return audio(dialect, part);
    case 'file':
      return file(dialect, part);
    case 'refusal':
      return { ...hinted(part.hints), type: 'refusal', refusal: part.text };
    // OpenAI's own API takes no reasoning back, and none takes citations.
    case 'reasoning':
    case 'citation':
      left.without(part.type, part);
      return undefined;
    case 'tool_call':
    case 'tool_result':
      return unsupported(
        `Chat Completions cannot carry ${a(part.type)} inside content`,
      );
    default:
      return part satisfies never;
  }
}

function contentPart(
  left: Leaving,
  dialect: Dialect,
  role: Role,
  part: Part,
): Dict | undefined {
  if (part.type === 'provider') return own(part.provider, 'a part');
  placed(dialect, role, part);
  const wire = shown(left, dialect, part);
  if (wire === undefined) return undefined;
  return {
    ...own(part.provider, 'a part option'),
    ...wire,
    ...breakpoint(left, part.cache),
  };
}

function call(
  left: Leaving,
  part: Extract<Known, { type: 'tool_call' }>,
): Dict {
  left.without('tool.cache', part.cache);
  left.without('hosted', part.hosted);
  const { id, name, input } = part;
  const carried = { ...hinted(part.hints), ...mine(part.provider) };
  return typeof input === 'string'
    ? wireCall('custom', input, carried, { id, name })
    : wireCall('function', part.raw ?? JSON.stringify(input), carried, {
        id,
        name,
      });
}

// A marker on a result sits on the last text part of what it returned, which
// both OpenAI's and a router's tool message take. Empty text is refused.
function result(
  left: Leaving,
  dialect: Dialect,
  part: Extract<Known, { type: 'tool_result' }>,
  held?: Cache,
): Dict {
  left.without('hosted', part.hosted);
  left.without('tool_result.failed', part.failed);
  const said =
    part.text ??
    part.parts.flatMap((inner) => {
      const wire = contentPart(left, dialect, 'tool', inner);
      return wire === undefined ? [] : [wire];
    });
  const wire = { role: 'tool', tool_call_id: part.id, content: said };
  const cache = part.cache ?? held;
  if (cache === undefined) return wire;
  // Where the lifetime is the request's, the marker only asks for it.
  if (left.lifetime === 'prompt_cache_options') {
    breakpoint(left, cache);
    return wire;
  }
  const parts =
    typeof said !== 'string'
      ? said
      : said === ''
        ? []
        : [{ type: 'text', text: said }];
  const end = parts.at(-1);
  if (!left.marks || end === undefined) {
    left.without('tool.cache', asked(cache));
    return wire;
  }
  const marked = { ...end, ...breakpoint(left, cache) };
  return { ...wire, content: [...parts.slice(0, -1), marked] };
}

function encoded(left: Leaving, message: Message, dialect: Dialect): Dict[] {
  const { role, name } = message;
  const cache = cacheFor(left, message.cache);
  const extra = {
    ...hinted(message.hints),
    ...own(message.provider, 'a message option'),
  };
  const base = {
    ...extra,
    role,
    ...given({ name }),
  };
  const content: Dict[] = [];
  const calls: Dict[] = [];
  const answers: Extract<Known, { type: 'tool_result' }>[] = [];
  const thoughts: Extract<Known, { type: 'reasoning' }>[] = [];
  const pictures: Dict[] = [];
  let heard: Dict | undefined;
  for (const part of message.parts ?? []) {
    const spoke = role === 'assistant';
    if (part.type === 'tool_call') calls.push(call(left, part));
    else if (part.type === 'tool_result') answers.push(part);
    else if (part.type === 'audio' && spoke && part.id) {
      // Sound a model made is named by the id its reply gave it.
      if (dialect.sound === 'none') audio(dialect, part);
      heard = {
        ...own(part.provider, 'a part option'),
        ...hinted(part.hints),
        id: part.id,
      };
    } else if (part.type === 'image' && spoke && dialect.images === true) {
      const wire = contentPart(left, dialect, 'user', part);
      if (wire !== undefined) pictures.push(wire);
    } else if (
      part.type === 'reasoning' &&
      role === 'assistant' &&
      (dialect.thought !== undefined ||
        dialect.tagged !== undefined ||
        dialect.chunked === true)
    ) {
      thoughts.push(part);
    } else {
      const wire = contentPart(left, dialect, role, part);
      if (wire !== undefined) content.push(wire);
    }
  }
  if (message.text !== undefined) {
    content.push({ type: 'text', text: message.text });
  }
  const thought = inlined(left, dialect, thoughts);
  const [opens] = content;
  const { type: kind, text: opening } = opens ?? {};
  // Inside the first text there is, so a turn of one text stays one.
  if (thought !== '' && kind === 'text' && typeof opening === 'string') {
    content.splice(0, 1, { ...opens, text: thought + opening });
  } else if (thought !== '') content.unshift({ type: 'text', text: thought });
  if (dialect.chunked === true) content.unshift(...thinking(left, thoughts));
  const last = content.at(-1);
  if (last !== undefined) {
    content.splice(-1, 1, { ...last, ...breakpoint(left, cache) });
  }
  if (role === 'tool' && content.length > 0) {
    unsupported('Chat Completions cannot carry a tool message with no result');
  }
  const silent = calls.length > 0 || heard !== undefined;
  const answered =
    role === 'tool' || (answers.length > 0 && last === undefined && !silent);
  // A marker sits on content, or on the last result of a turn of results.
  const closing = answered ? answers.at(-1) : undefined;
  if (last === undefined && closing === undefined) {
    left.without('tool.cache', asked(cache));
  }
  const results = answers.map((part) =>
    result(left, dialect, part, part === closing ? cache : undefined),
  );
  if (answered) {
    // A message that only answers tools is just those answers, each with
    // what the message held for this wire. A tool message has no name.
    left.without('message.name.tool', name);
    return results.map((each) => ({ ...extra, ...each }));
  }
  const said =
    message.text !== undefined && cache === undefined
      ? message.text
      : content.length > 0
        ? content
        : silent
          ? null
          : '';
  const whole = {
    ...base,
    content: said,
    ...(calls.length === 0 ? {} : { tool_calls: calls }),
    ...(heard === undefined ? {} : { audio: heard }),
    ...(pictures.length === 0 ? {} : { images: pictures }),
    ...(thought === '' ? returned(left, dialect, thoughts) : {}),
  };
  return role === 'assistant' ? [whole, ...results] : [...results, whole];
}

export function wireMessages(
  left: Leaving,
  messages: readonly Message[],
  dialect: Dialect = plain,
): Json[] {
  return messages.flatMap((message) => encoded(left, message, dialect));
}
