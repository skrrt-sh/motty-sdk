import type { Json, Message, Part, Role } from '@mottyjs/core/host';
import { cacheOf } from '../wire/cache-control.ts';
import { inline } from '../wire/data-url.ts';
import {
  type Dict,
  dict,
  given,
  isDict,
  list,
  parsed,
  text,
} from '../wire/json.ts';
import { detailed } from '../wire/openai-detail.ts';
import { invalid, unsupported } from '../wire/refusals.ts';
import { family, marked, noted } from './family.ts';
import { callFields, parted } from './unread.ts';

// What the object inside a part holds beside what is read is a hint, and
// goes back inside it. An image's detail is one both OpenAI APIs read.
function imageOf({ url, detail, ...more }: Dict): Part {
  if (typeof url !== 'string') {
    invalid('An image_url part needs a url');
  }
  return {
    type: 'image',
    ...(inline(url) ?? { url }),
    ...detailed(detail, noted(more)),
  };
}

function audioOf({ data, format, ...more }: Dict): Part {
  if (typeof data !== 'string' || typeof format !== 'string') {
    invalid('An input_audio part needs data and a format');
  }
  return { type: 'audio', data, mediaType: `audio/${format}`, ...noted(more) };
}

// A dialect's `file_data` may be an address, where OpenAI's is bytes alone.
function fileOf(fields: Dict): Part {
  const { file_data: data, file_id: id, filename, ...more } = fields;
  const extra = {
    ...(typeof filename === 'string' ? { name: filename } : {}),
    ...noted(more),
  };
  if (typeof data === 'string') {
    const media = /^https?:/.test(data) ? { url: data } : { data };
    return { type: 'file', ...extra, ...(inline(data) ?? media) };
  }
  if (typeof id === 'string') return { type: 'file', ...extra, id };
  invalid('A file part needs file_data or a file_id');
}

function known({ type, ...fields }: Dict): Part | undefined {
  switch (type) {
    case 'text': {
      const { text: said, ...more } = fields;
      if (typeof said !== 'string') {
        invalid('A text part needs its text');
      }
      return { type: 'text', text: said, ...noted(more) };
    }
    case 'image_url': {
      const { image_url: image, ...more } = fields;
      return { ...imageOf(dict(image)), ...marked(more) };
    }
    case 'input_audio': {
      const { input_audio: audio, ...more } = fields;
      return { ...audioOf(dict(audio)), ...marked(more) };
    }
    case 'file': {
      // One dialect writes a file's fields with no object around them.
      const { file, ...more } = fields;
      return isDict(file)
        ? { ...fileOf(file), ...marked(more) }
        : fileOf(fields);
    }
    case 'refusal': {
      const { refusal, ...more } = fields;
      return { type: 'refusal', text: text(refusal) ?? '', ...noted(more) };
    }
    default:
      return undefined;
  }
}

// A cache marker is read in either spelling: this API's own breakpoint, and
// the `cache_control` routers of this family take, which may hold a lifetime.
function partOf(raw: Json): Part {
  if (!isDict(raw)) invalid('A content part is an object');
  const {
    prompt_cache_breakpoint: breakpoint,
    cache_control: control,
    ...fields
  } = raw;
  const part = known(fields);
  if (part === undefined)
    return { type: 'provider', provider: { [family]: raw } };
  return {
    ...part,
    ...(isDict(breakpoint) ? { cache: {} } : {}),
    ...cacheOf(control),
  };
}

// Pictures a model made come back in a field of their own, each written as
// an image part is.
function picturesOf(images: Json | undefined): Part[] {
  return list(images).map((image) =>
    partOf({ type: 'image_url', ...dict(image) }),
  );
}

// What a call holds beside what is read is a hint, and goes back where it
// sat. Its place in a stream is no field of the call.
function callOf(raw: Json): Part {
  const call = dict(raw);
  const { id, type = 'function', function: fn, custom } = call;
  if (typeof id !== 'string') invalid('A tool call needs an id');
  if (type === 'custom') {
    const { name, input } = dict(custom);
    if (typeof name !== 'string' || typeof input !== 'string') {
      invalid('A custom tool call needs a name and an input');
    }
    const more = noted(parted(call, 'custom', callFields) ?? {});
    return { type: 'tool_call', id, name, input, ...more };
  }
  const { name, arguments: source } = dict(fn);
  if (type !== 'function' || typeof name !== 'string') {
    invalid('A tool call needs a function name');
  }
  const more = noted(parted(call, 'function', callFields) ?? {});
  const written = text(source) ?? '';
  const input = parsed(written);
  // A bare string is a custom tool's input, never a function's arguments.
  return input === undefined || typeof input === 'string'
    ? { type: 'tool_call', id, name, raw: written, ...more }
    : { type: 'tool_call', id, name, input, ...more };
}

function partsOf(content: Json | undefined): Part[] {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    invalid('Message content is a string or a list of parts');
  }
  return content.map(partOf);
}

function roleOf(role: Json | undefined): Exclude<Role, 'tool'> {
  switch (role) {
    case 'system':
    case 'developer':
    case 'user':
    case 'assistant':
      return role;
    case 'function':
      return unsupported(
        'Function messages are not served: send tool messages',
      );
    default:
      return invalid(`Unknown message role: ${JSON.stringify(role)}`);
  }
}

function resultOf(id: Json | undefined, content: Json | undefined): Part {
  if (typeof id !== 'string') {
    invalid('A tool message needs a tool_call_id');
  }
  return typeof content === 'string'
    ? { type: 'tool_result', id, text: content }
    : { type: 'tool_result', id, parts: partsOf(content) };
}

export function messageOf(raw: Json): Message {
  if (!isDict(raw)) invalid('A message is an object');
  const {
    role,
    name,
    content,
    tool_call_id: id,
    tool_calls: calls,
    refusal,
    audio,
    reasoning,
    reasoning_content: thought,
    reasoning_details: details,
    images,
    function_call: legacy,
    ...others
  } = raw;
  const extra = marked(others);
  if (role === 'tool') {
    return { role, parts: [resultOf(id, content)], ...extra };
  }
  if (legacy !== undefined && legacy !== null) {
    unsupported('function_call is not served: send tool_calls');
  }
  const base = {
    role: roleOf(role),
    ...(typeof name === 'string' ? { name } : {}),
    ...extra,
  };
  const { id: heard, ...sound } = dict(audio);
  const said = partsOf(content);
  const parts: Part[] = [];
  // Details are what the model goes on from, so they stay with the
  // reasoning, and where no text was sent beside them theirs is read.
  const kept = marked(given({ reasoning_details: details }));
  const mused = thought ?? reasoning;
  const thinking =
    typeof mused === 'string'
      ? mused
      : list(details)
          .map((detail) => {
            const { text: said } = dict(detail);
            return text(said) ?? '';
          })
          .join('');
  if (thinking !== '' || kept.provider !== undefined) {
    parts.push({ type: 'reasoning', text: thinking, ...kept });
  }
  for (const part of said) parts.push(part);
  if (typeof refusal === 'string') {
    parts.push({ type: 'refusal', text: refusal });
  }
  if (typeof heard === 'string') {
    parts.push({ type: 'audio', id: heard, ...noted(sound) });
  }
  for (const picture of picturesOf(images)) parts.push(picture);
  for (const call of list(calls)) parts.push(callOf(call));
  return typeof content === 'string' && parts.length === said.length
    ? { ...base, text: content }
    : { ...base, parts };
}
