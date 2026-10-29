import type { Cache, Media, Part } from '@mottyjs/core/host';
import { cacheTo } from '../wire/cache-control.ts';
import { inline } from '../wire/data-url.ts';
import type { Leaving } from '../wire/fieldless.ts';
import { copied, type Dict, given, isDict } from '../wire/json.ts';
import { a, unsupported } from '../wire/refusals.ts';
import { hinted, mine, own } from './family.ts';

// A plain-text document is sent as the text it is, so bytes that are not
// UTF-8 have no form here.
function written(data: string): string {
  try {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const reader = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return reader.decode(bytes);
  } catch {
    return unsupported(
      'Anthropic Messages takes no plain-text file that is not UTF-8',
    );
  }
}

// Only what the API lists is sent: any other kind it would answer 400.
function sourceOf(media: Media, what: string, taken: readonly string[]): Dict {
  if (media.id !== undefined) return { type: 'file', file_id: media.id };
  // Another family sends inline bytes as a data address; this one does not.
  const split = media.url === undefined ? undefined : inline(media.url);
  const data = media.data ?? split?.data;
  const mediaType = media.mediaType ?? split?.mediaType;
  if (mediaType !== undefined && !taken.includes(mediaType)) {
    unsupported(`Anthropic Messages takes no ${mediaType} ${what}`);
  }
  const plain = mediaType === 'text/plain';
  if (data === undefined) {
    if (plain) {
      unsupported('Anthropic Messages takes no text/plain file by address');
    }
    return { type: 'url', url: media.url ?? '' };
  }
  if (mediaType === undefined) {
    unsupported(`Anthropic Messages needs the media type of ${what} bytes`);
  }
  return plain
    ? { type: 'text', media_type: mediaType, data: written(data) }
    : { type: 'base64', media_type: mediaType, data };
}

function unless<Content extends string | Dict[]>(
  content: Content,
): Content | undefined {
  return content.length === 0 ? undefined : content;
}

function blockOf(
  left: Leaving,
  part: Exclude<Part, { type: 'citation' }>,
): Dict | undefined {
  if (part.type === 'provider') {
    const block = own(part.provider, 'a part');
    if (Object.keys(block).length === 0) {
      unsupported('Anthropic Messages cannot carry an empty provider part');
    }
    return block;
  }
  if (part.type === 'reasoning') {
    // Reasoning no Anthropic model signed is refused upstream, so it is
    // left out: another family's, and progress a caller sent back.
    const { signature, ...rest } = hinted(part.provider);
    if (typeof signature === 'string') {
      return { ...rest, type: 'thinking', thinking: part.text, signature };
    }
    // Redacted thinking is signed whole, and carried back as it came.
    const { type } = rest;
    if (type === 'redacted_thinking') return rest;
    left.without('reasoning', part);
    return undefined;
  }
  const meant =
    part.type === 'tool_call' && part.hosted !== true
      ? mine(part.provider)
      : own(part.provider, `${a(part.type)} part`);
  const { cache_control: kept, ...extra } = {
    ...hinted(part.hints),
    ...meant,
  };
  const cache = cacheTo(part.cache, kept);
  // What the upstream of another API ran has no block here; this API's own
  // comes with the fields it wrote.
  if (part.type === 'tool_call' || part.type === 'tool_result') {
    left.without('hosted', part.hosted && Object.keys(meant).length === 0);
  }
  switch (part.type) {
    case 'text':
    case 'refusal':
      // The API takes no text block without text.
      return part.text === ''
        ? undefined
        : { ...extra, type: 'text', text: part.text, ...cache };
    case 'image':
      if (part.data !== undefined && part.mediaType === undefined) {
        left.without('image.untyped', part);
      }
      return {
        ...extra,
        type: 'image',
        source: sourceOf(part, 'image', [
          'image/jpeg',
          'image/png',
          'image/gif',
          'image/webp',
        ]),
        ...cache,
      };
    case 'file':
      return {
        ...extra,
        type: 'document',
        source: sourceOf(part, 'file', ['application/pdf', 'text/plain']),
        ...given({ title: part.name }),
        ...cache,
      };
    case 'audio':
      left.without('audio', part);
      return undefined;
    case 'tool_call': {
      // The two OpenAI APIs may say a call with no arguments as no text.
      if (part.input === undefined && part.raw !== '') {
        unsupported(
          'Anthropic Messages cannot carry tool input that is not JSON',
        );
      }
      // Free text is a custom tool's, which this API is sent as an object.
      const said = part.input === undefined ? {} : copied(part.input);
      const input = typeof said === 'string' ? { input: said } : said;
      if (!isDict(input)) {
        unsupported(
          'Anthropic Messages cannot carry a tool call whose input is not an object',
        );
      }
      return {
        ...extra,
        type: part.hosted === true ? 'server_tool_use' : 'tool_use',
        id: part.id,
        name: part.name,
        input,
        ...cache,
      };
    }
    case 'tool_result': {
      // A result of a tool this API's upstream ran says its own kind.
      const { type = 'tool_result' } = meant;
      return {
        ...extra,
        type,
        tool_use_id: part.id,
        ...given({
          content: unless(
            part.parts === undefined ? part.text : blocksOf(left, part.parts),
          ),
        }),
        ...(part.failed === true ? { is_error: true } : {}),
        ...cache,
      };
    }
  }
}

// A citation annotates the text before it. Only this family's own form can
// be written: its location fields have no neutral counterpart.
function cited(left: Leaving, blocks: Dict[], part: Part): void {
  const citation = hinted(part.provider);
  const last = blocks.at(-1);
  const { type, citations } = last ?? {};
  const own = Object.keys(citation).length > 0;
  if (last === undefined || type !== 'text' || !own) {
    left.without('citation', part);
  } else if (Array.isArray(citations)) citations.push(citation);
  else blocks.splice(-1, 1, { ...last, citations: [citation] });
}

// The cache marker of a whole message sits on its last block.
export function blocksOf(
  left: Leaving,
  parts: readonly Part[],
  cache?: Cache,
): Dict[] {
  const blocks: Dict[] = [];
  for (const part of parts) {
    if (part.type === 'citation') {
      cited(left, blocks, part);
      continue;
    }
    const block = blockOf(left, part);
    if (block !== undefined) blocks.push(block);
  }
  const last = blocks.at(-1);
  if (last === undefined || cache === undefined) return blocks;
  const { cache_control: kept } = last;
  return [...blocks.slice(0, -1), { ...last, ...cacheTo(cache, kept) }];
}
