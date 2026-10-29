import type { Json, ReadonlyJson } from '@mottyjs/core/host';

export type Dict = { [key: string]: Json };

export function isDict(value: Json | undefined): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function dict(value: Json | undefined): Dict {
  return isDict(value) ? value : {};
}

export function list(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function number(value: Json | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

// A schema of ten levels, the most the providers take, nests some thirty
// deep. This is many times that, and far less than any stack holds.
export const deepest = 512;

// Brackets are counted in the text, outside its strings. Text shorter than
// two characters a level cannot nest too deep, so little of it is scanned.
export function nested(source: string): boolean {
  if (source.length <= 2 * deepest) return false;
  let depth = 0;
  for (let at = 0; at < source.length; at++) {
    const code = source.charCodeAt(at);
    if (code === 0x22) {
      // A quote after an odd run of backslashes is the string's own.
      for (let escaped = true; escaped; ) {
        at = source.indexOf('"', at + 1);
        if (at === -1) return false;
        let back = at;
        while (source.charCodeAt(back - 1) === 0x5c) back--;
        escaped = (at - back) % 2 === 1;
      }
    } else if (code === 0x7b || code === 0x5b) {
      if (++depth > deepest) return true;
    } else if (code === 0x7d || code === 0x5d) depth--;
  }
  return false;
}

// A parser returns nothing JSON does not have, so what it read is taken as
// JSON as it is: walking it to say so cost a third as much as parsing it.
const read: (source: string) => Json = JSON.parse;

// Text nested too deep is read as none, so all that is read may be recursed.
export function parsed(source: string): Json | undefined {
  if (nested(source)) return undefined;
  try {
    return read(source);
  } catch {
    return undefined;
  }
}

// Defined, not assigned, a key named as the prototype is a key like any
// other. Assigned, a body's fields cost a fifth of building it from entries.
function put(into: Dict, key: string, value: Json): void {
  if (key !== '__proto__') into[key] = value;
  else {
    Object.defineProperty(into, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

// JSON has no undefined, so a field that was not given is left out.
export function given(fields: { [key: string]: Json | undefined }): Dict {
  const said: Dict = {};
  for (const key of Object.keys(fields)) {
    const value = fields[key];
    if (value !== undefined) put(said, key, value);
  }
  return said;
}

// The fields kept, in their order.
export function picked(
  fields: Dict,
  keep: (key: string, value: Json) => boolean,
): Dict {
  const kept: Dict = {};
  for (const [key, value] of Object.entries(fields)) {
    if (keep(key, value)) put(kept, key, value);
  }
  return kept;
}

export function without(fields: Dict, names: readonly string[]): Dict {
  return picked(fields, (key) => !names.includes(key));
}

function isList(value: ReadonlyJson): value is readonly ReadonlyJson[] {
  return Array.isArray(value);
}

// Read-only JSON may be shared with its owner; a body is built from a copy.
export function copied(value: ReadonlyJson): Json {
  if (typeof value !== 'object' || value === null) return value;
  if (isList(value)) return value.map(copied);
  // Made from entries, a key named as the prototype is a key like any other.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copied(item)]),
  );
}
