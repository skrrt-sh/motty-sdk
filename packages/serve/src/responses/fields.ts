import type { Json } from '@mottyjs/core/host';
import { type Dict, dict } from '../wire/json.ts';

// An item of this API is read a field at a time, and may not be an object.
export function field(value: Json | undefined, key: string): Json | undefined {
  return dict(value)[key];
}

export function without(fields: Dict, known: readonly string[]): Dict {
  const rest: Dict = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!known.includes(key)) rest[key] = value;
  }
  return rest;
}
