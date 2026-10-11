import type { Json, Media, Part } from '@mottyjs/core/host';
import { inline } from '../wire/data-url.ts';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, dict, given, isDict, list, text } from '../wire/json.ts';
import { breakpoint } from '../wire/openai-cache.ts';
import { detailed } from '../wire/openai-detail.ts';
import { filename } from '../wire/openai-file.ts';
import { a, invalid, unsupported } from '../wire/refusals.ts';
import { carried, family, hinted, noted, own } from './family.ts';
import { field, without } from './fields.ts';

// What a known content part holds beside what is read may be left out by
// another family, and is put back for this one. A cache marker is read, so
// it reaches an upstream of any family.
function extra(fields: Dict, read: readonly string[]) {
  const { prompt_cache_breakpoint: marker } = fields;
  return {
    ...noted(without(fields, ['type', 'prompt_cache_breakpoint', ...read])),
    ...(isDict(marker) ? { cache: {} } : {}),
  };
}

function imageOf(part: Dict, at: string): Part {
  const { image_url: url, file_id: id, detail } = part;
  const more = detailed(
    detail,
    extra(part, ['image_url', 'file_id', 'detail']),
  );
  if (typeof url === 'string')
    return { type: 'image', ...(inline(url) ?? { url }), ...more };
  if (typeof id === 'string') return { type: 'image', id, ...more };
  invalid(`${at} needs an image_url or a file_id`);
}

function fileOf(part: Dict, at: string): Part {
  const { file_data: data, file_url: url, file_id: id, filename } = part;
  const more = {
    ...(typeof filename === 'string' ? { name: filename } : {}),
    ...extra(part, ['file_data', 'file_url', 'file_id', 'filename']),
  };
  if (typeof data === 'string') {
    return { type: 'file', ...(inline(data) ?? { data }), ...more };
  }
  if (typeof url === 'string') return { type: 'file', url, ...more };
  if (typeof id === 'string') return { type: 'file', id, ...more };
  invalid(`${at} needs file_data, a file_url or a file_id`);
}

function audioOf(part: Dict, at: string): Part {
  const { data, format } = dict(field(part, 'input_audio'));
  if (typeof data !== 'string' || typeof format !== 'string') {
    invalid(`${at} needs input_audio with data and a format`);
  }
  return {
    type: 'audio',
    data,
    mediaType: `audio/${format}`,
    ...extra(part, ['input_audio']),
  };
}

function citationOf(annotation: Json): Part {
  const { url, title, filename } = dict(annotation);
  const named = text(title) ?? text(filename);
  return {
    type: 'citation',
    ...(typeof url === 'string' ? { url } : {}),
    ...(named === undefined ? {} : { title: named }),
    provider: { [family]: annotation },
  };
}

// One content part of a message or of a tool's output. Output text gives its
// annotations too, each as a citation after the text it annotates.
export function partsOf(raw: Json, at: string): Part[] {
  if (!isDict(raw)) invalid(`${at} must be an object`);
  const { type } = raw;
  switch (type) {
    case 'input_text':
    case 'output_text':
    case 'text': {
      const { text: said, annotations } = raw;
      if (typeof said !== 'string') {
        invalid(`${at} needs text`);
      }
      return [
        { type: 'text', text: said, ...extra(raw, ['text', 'annotations']) },
        ...list(annotations).map(citationOf),
      ];
    }
    case 'refusal': {
      const { refusal } = raw;
      if (typeof refusal !== 'string') {
        invalid(`${at} needs a refusal`);
      }
      return [{ type: 'refusal', text: refusal, ...extra(raw, ['refusal']) }];
    }
    case 'input_image':
      return [imageOf(raw, at)];
    case 'input_file':
      return [fileOf(raw, at)];
    case 'input_audio':
      return [audioOf(raw, at)];
    default:
      return [{ type: 'provider', provider: { [family]: raw } }];
  }
}

// Inline bytes of a named type go as a data address.
function address(media: Media): string | undefined {
  const { url, data, mediaType } = media;
  if (url !== undefined) return url;
  return data === undefined || mediaType === undefined
    ? undefined
    : `data:${mediaType};base64,${data}`;
}

export function inputContent(left: Leaving, part: Part): Dict {
  if (part.type === 'audio') left.without('audio', part);
  switch (part.type) {
    case 'text':
      return {
        ...carried(part, 'a text part'),
        type: 'input_text',
        text: part.text,
        ...breakpoint(left, part.cache),
      };
    case 'image': {
      const url = address(part);
      if (part.id === undefined && url === undefined) {
        left.without('image.untyped', part);
      }
      return {
        ...carried(part, 'an image part'),
        type: 'input_image',
        ...given({ image_url: url, file_id: part.id }),
        ...breakpoint(left, part.cache),
      };
    }
    case 'file':
      return {
        ...carried(part, 'a file part'),
        type: 'input_file',
        ...given({
          filename: filename(part),
          file_id: part.id,
          file_url: part.url,
          // A file's bytes may go bare, with no type named.
          file_data:
            part.data === undefined ? undefined : (address(part) ?? part.data),
        }),
        ...breakpoint(left, part.cache),
      };
    case 'provider':
      return { ...hinted(part.hints), ...own(part.provider, 'a part') };
    default:
      unsupported(
        `The Responses API cannot carry ${a(part.type)} part as input content`,
      );
  }
}
