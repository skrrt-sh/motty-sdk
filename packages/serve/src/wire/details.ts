import type { Json } from '@mottyjs/core/host';
import { isDict } from './json.ts';

// A reply streams one detail as fragments of one type and index: its text
// grows, and what signs it is said once.
export function joined(fragments: readonly Json[]): Json[] {
  const whole = new Map<string, Map<string, Json>>();
  for (const fragment of fragments) {
    if (!isDict(fragment)) continue;
    const { type, index } = fragment;
    const key =
      typeof index === 'number' ? `${type} ${index}` : `${whole.size}`;
    const held = whole.get(key) ?? new Map<string, Json>();
    for (const [name, value] of Object.entries(fragment)) {
      const had = held.get(name);
      if (
        typeof had === 'string' &&
        typeof value === 'string' &&
        (name === 'text' || name === 'summary' || name === 'data')
      ) {
        held.set(name, had + value);
      } else if (value !== null || had === undefined) held.set(name, value);
    }
    whole.set(key, held);
  }
  // Made from entries, a name that is the prototype's is a field like any.
  return [...whole.values()].map((held) => Object.fromEntries(held));
}
