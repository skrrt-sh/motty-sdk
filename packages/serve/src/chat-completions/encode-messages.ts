import type { Json, Message, Part, Role } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, given } from '../wire/json.ts';
import { breakpoint } from '../wire/openai-cache.ts';
import { a, unsupported } from '../wire/refusals.ts';
import { thinking } from './content-chunks.ts';
import { type Dialect, inlined, plain, returned } from './dialect.ts';
import { audio, file, image } from './encode-media.ts';
import { family, hinted, own } from './family.ts';
import { callFields, rebuilt } from './unread.ts';

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
  // What a call holds for another API alone is not this wire's to refuse.
  const carried = {
    ...hinted(part.hints),
    ...(part.provider?.[family] === undefined
      ? {}
      : own(part.provider, 'a tool call')),
  };
  if (typeof input === 'string') {
    const outer = { id, type: 'custom' };
    return rebuilt(carried, 'custom', callFields, outer, { name, input });
  }
  const written = part.raw ?? JSON.stringify(input);
  const outer = { id, type: 'function' };
  const inner = { name, arguments: written };
  return rebuilt(carried, 'function', callFields, outer, inner);
}

function result(
  left: Leaving,
  dialect: Dialect,
  part: Extract<Known, { type: 'tool_result' }>,
): Dict {
  left.without('tool.cache', part.cache);
  left.without('hosted', part.hosted);
  left.without('tool_result.failed', part.failed);
  const content =
    part.text ??
    part.parts.flatMap((inner) => {
      const wire = contentPart(left, dialect, 'tool', inner);
      return wire === undefined ? [] : [wire];
    });
  return { role: 'tool', tool_call_id: part.id, content };
}

function encoded(left: Leaving, message: Message, dialect: Dialect): Dict[] {
  const { role, name, cache } = message;
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
  const results: Dict[] = [];
  const thoughts: Extract<Known, { type: 'reasoning' }>[] = [];
  const pictures: Dict[] = [];
  let heard: Dict | undefined;
  for (const part of message.parts ?? []) {
    const spoke = role === 'assistant';
    if (part.type === 'tool_call') calls.push(call(left, part));
    else if (part.type === 'tool_result') {
      results.push(result(left, dialect, part));
    } else if (part.type === 'audio' && spoke && part.id) {
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
  // A marker sits on content, and a turn of calls or results has none.
  if (last === undefined) left.without('tool.cache', cache);
  if (role === 'tool' && content.length > 0) {
    unsupported('Chat Completions cannot carry a tool message with no result');
  }
  const silent = calls.length > 0 || heard !== undefined;
  if (
    role === 'tool' ||
    (results.length > 0 && last === undefined && !silent)
  ) {
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
