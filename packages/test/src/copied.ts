import type { Json, ReadonlyJson } from '@mottyjs/core/host';

function isList(value: ReadonlyJson): value is readonly ReadonlyJson[] {
  return Array.isArray(value);
}

export function copied(value: ReadonlyJson): Json {
  if (typeof value !== 'object' || value === null) return value;
  if (isList(value)) return value.map(copied);
  // Made from entries, a key named as the prototype is a key like any other.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, copied(item)]),
  );
}
