import type { Cache, Content, Json, Media, Part } from '@mottyjs/core/host';
import { cacheOf } from '../wire/cache-control.ts';
import { type Dict, isDict } from '../wire/json.ts';
import { invalid } from '../wire/refusals.ts';
import { family, marked, noted } from './family.ts';

type Marker = { cache?: Cache };

function mediaOf(source: Json | undefined): Media | undefined {
  if (!isDict(source)) return undefined;
  const { type, data, media_type: mediaType, url, file_id: id } = source;
  if (type === 'base64' && typeof data === 'string') {
    return typeof mediaType === 'string' ? { data, mediaType } : undefined;
  }
  if (type === 'url' && typeof url === 'string') return { url };
  if (type === 'file' && typeof id === 'string') return { id };
  return undefined;
}

// A plain-text document comes as the text it is, and is held as any other
// file is, in base64.
function writtenOf(source: Json | undefined): Media | undefined {
  if (!isDict(source)) return undefined;
  const { type, data, media_type: mediaType } = source;
  if (type !== 'text' || typeof data !== 'string') return undefined;
  if (mediaType !== 'text/plain') return undefined;
  let bytes = '';
  for (const byte of new TextEncoder().encode(data)) {
    bytes += String.fromCharCode(byte);
  }
  return { data: btoa(bytes), mediaType };
}

// Whole or streamed, a citation is read one way: a search result has a
// title of its own, and a quote from a document its document's.
export function cited(raw: Dict): Extract<Part, { type: 'citation' }> {
  const { cited_text: text, document_title: document, title, url } = raw;
  const named = typeof title === 'string' ? title : document;
  return {
    type: 'citation',
    ...(typeof named === 'string' ? { title: named } : {}),
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof text === 'string' ? { text } : {}),
    provider: { [family]: raw },
  };
}

function citationOf(raw: Json): Part {
  if (!isDict(raw)) invalid('A citation must be an object');
  return cited(raw);
}

function callOf(fields: Dict, cache: Marker, hosted: boolean): Part {
  const { id, name, input, ...rest } = fields;
  if (typeof id !== 'string' || typeof name !== 'string') {
    invalid('A tool_use block needs an id and a name');
  }
  if (!isDict(input)) invalid('A tool_use block needs an input object');
  return {
    type: 'tool_call',
    id,
    name,
    input,
    ...(hosted ? { hosted } : {}),
    ...cache,
    // Its own type marks a call this API's upstream ran as this API's. What
    // a caller's own call says beside its input came with the reply it
    // echoes, and another family answers the turn as well without it.
    ...(hosted ? marked({ ...rest, type: 'server_tool_use' }) : noted(rest)),
  };
}

function resultOf(fields: Dict, cache: Marker): Part {
  const { tool_use_id: id, content, is_error: failed, ...rest } = fields;
  if (typeof id !== 'string') invalid('A tool_result block needs tool_use_id');
  return {
    type: 'tool_result',
    id,
    ...(content === undefined || content === null
      ? { text: '' }
      : contentOf(content, 'tool_result content')),
    ...(failed === true ? { failed } : {}),
    ...cache,
    ...marked(rest),
  };
}

// One block may be several parts: a text block's citations follow its text.
export function partsOf(raw: Json): Part[] {
  if (!isDict(raw)) invalid('A content block must be an object');
  const { type, cache_control: control, ...fields } = raw;
  const cache = cacheOf(control);
  switch (type) {
    case 'text': {
      const { text, citations, ...rest } = fields;
      if (typeof text !== 'string') invalid('A text block needs text');
      return [
        { type: 'text', text, ...cache, ...marked(rest) },
        ...(Array.isArray(citations) ? citations.map(citationOf) : []),
      ];
    }
    case 'image': {
      const { source, ...rest } = fields;
      const media = mediaOf(source);
      if (media === undefined) invalid('An image block needs a known source');
      return [{ type: 'image', ...media, ...cache, ...marked(rest) }];
    }
    case 'document': {
      const { source, title, ...rest } = fields;
      const media = mediaOf(source) ?? writtenOf(source);
      // A source made of content blocks has no neutral form: it stays as sent.
      if (media === undefined) break;
      const name = typeof title === 'string' ? { name: title } : {};
      return [{ type: 'file', ...media, ...name, ...cache, ...marked(rest) }];
    }
    case 'tool_use':
      return [callOf(fields, cache, false)];
    case 'server_tool_use':
      return [callOf(fields, cache, true)];
    case 'tool_result':
      return [resultOf(fields, cache)];
    case 'thinking': {
      const { thinking, signature, ...rest } = fields;
      if (typeof thinking !== 'string') invalid('A thinking block needs text');
      // No signature means no model wrote it: it is progress sent back.
      const signed =
        typeof signature === 'string' && signature !== ''
          ? { ...rest, signature }
          : rest;
      return [{ type: 'reasoning', text: thinking, ...marked(signed) }];
    }
  }
  if (typeof type !== 'string') invalid('A content block needs a type');
  return [{ type: 'provider', provider: { [family]: raw } }];
}

export function contentOf(content: Json | undefined, what: string): Content {
  if (typeof content === 'string') return { text: content };
  if (Array.isArray(content)) return { parts: content.flatMap(partsOf) };
  return invalid(`${what} must be a string or a list of content blocks`);
}
