import type { Media } from '@mottyjs/core/host';

// Media given inline is split, so each wire can send the bytes its own way.
export function inline(
  address: string,
): { data: string; mediaType: string } | undefined {
  const [, mediaType, data] =
    /^data:([^;,]+);base64,(.*)$/s.exec(address) ?? [];
  return mediaType === undefined || data === undefined
    ? undefined
    : { mediaType, data };
}

// Both OpenAI APIs take inline bytes of a named type as a data address.
export function address(media: Media): string | undefined {
  const { url, data, mediaType } = media;
  if (url !== undefined) return url;
  return data === undefined || mediaType === undefined
    ? undefined
    : `data:${mediaType};base64,${data}`;
}
