import type { Json } from '@mottyjs/core/host';
import { type Dict, dict } from '../wire/json.ts';

// An item of this API is read a field at a time, and may not be an object.
export function field(value: Json | undefined, key: string): Json | undefined {
  return dict(value)[key];
}

export function without(fields: Dict, known: readonly string[]): Dict {
  // Made from entries, a key named as the prototype is a key like any other.
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => !known.includes(key)),
  );
}
