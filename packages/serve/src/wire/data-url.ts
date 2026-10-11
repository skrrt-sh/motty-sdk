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
