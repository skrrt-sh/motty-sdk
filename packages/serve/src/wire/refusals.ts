import { InvalidRequest, Unsupported } from '@mottyjs/core';

export function invalid(message: string): never {
  throw new InvalidRequest(message);
}

export function unsupported(message: string): never {
  throw new Unsupported(message);
}

// A part is named by its kind, which may start with a vowel, and a caller reads
// the two kinds a tool has in the words these refusals have always said.
export function a(kind: string): string {
  const said =
    kind === 'toolCall'
      ? 'tool_call'
      : kind === 'toolResult'
        ? 'tool_result'
        : kind;
  return `${/^[aeiou]/.test(said) ? 'an' : 'a'} ${said}`;
}
