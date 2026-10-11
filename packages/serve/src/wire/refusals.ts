import { InvalidRequest, Unsupported } from '@mottyjs/core';

export function invalid(message: string): never {
  throw new InvalidRequest(message);
}

export function unsupported(message: string): never {
  throw new Unsupported(message);
}

// A part is named by its kind, which may start with a vowel.
export function a(kind: string): string {
  return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
}
