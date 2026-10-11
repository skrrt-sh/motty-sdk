import type { Part } from '@mottyjs/core/host';

// Both OpenAI APIs refuse file bytes sent with no name, so bytes of a named
// type that came with none are given a name that says the type.
export function filename({
  name,
  data,
  mediaType,
}: Extract<Part, { type: 'file' }>): string | undefined {
  if (name !== undefined || data === undefined || mediaType === undefined) {
    return name;
  }
  const [, kind = 'bin'] = /\/([a-z0-9]+)/.exec(mediaType) ?? [];
  return `file.${kind === 'plain' ? 'txt' : kind}`;
}
