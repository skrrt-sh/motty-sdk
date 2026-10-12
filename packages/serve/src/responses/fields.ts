import type { Json } from '@mottyjs/core/host';
import { type Dict, dict } from '../wire/json.ts';

// An item of this API is read a field at a time, and may not be an object.
export function field(value: Json | undefined, key: string): Json | undefined {
  return dict(value)[key];
}

export const callNeutral = ['call_id', 'name', 'arguments', 'input'];

// A reply's items are numbered and ended by whoever writes it, so the id and
// the status an upstream gave a call are not carried to the caller.
export const callUncarried = ['id', 'status', 'type', ...callNeutral];

// A call to a custom tool is told from one to a function by its type alone,
// so the type is what a chunk of this family carries to mark one.
export function isCustom(item: Dict): boolean {
  return field(item, 'type') === 'custom_tool_call';
}

// Each field is defined, not assigned, so a key named as the prototype is a
// key like any other. The item grows where it is, since copying it at every
// chunk cost a call the square of its chunks.
export function put(item: Dict, more: Dict): void {
  for (const [name, value] of Object.entries(more)) {
    Object.defineProperty(item, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}
