import type { Json } from '@mottyjs/core/host';
import { type Dict, dict } from '../wire/json.ts';

// An item of this API is read a field at a time, and may not be an object.
export function field(value: Json | undefined, key: string): Json | undefined {
  return dict(value)[key];
}

// What a call's item says that a part or a chunk has a field of its own for.
export const callRead = ['call_id', 'name', 'arguments', 'input'];

// What this codec writes of a call it passes on, and so never carries. An
// item a caller echoes keeps its id and state, which go back as they came.
export const callWritten = ['id', 'status', 'type', ...callRead];

// A call to a custom tool is told from one to a function by its type alone,
// so the type is what a chunk of this family carries to mark one.
export function isCustom(item: Dict): boolean {
  return field(item, 'type') === 'custom_tool_call';
}
