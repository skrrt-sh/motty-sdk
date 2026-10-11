import type { Json } from '@mottyjs/core/host';

function isFields(
  value: unknown,
): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJson(value: unknown): value is Json {
  if (Array.isArray(value)) return value.every(isJson);
  if (isFields(value)) return Object.values(value).every(isJson);
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

// A parser returns JSON and types it as anything. Walking the value is what
// lets the type say JSON with no assertion; text that is not JSON throws.
export function parsed(text: string): Json {
  const value: unknown = JSON.parse(text);
  if (isJson(value)) return value;
  throw new SyntaxError('The text holds a value JSON does not have');
}
