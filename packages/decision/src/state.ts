import type { ReadonlyJson } from '@mottyjs/core/host';
import type { Structured } from './wire.ts';

// What an author holds: a field may be there and undefined, and is then left
// out, as JSON leaves it out.
type Fields = { readonly [key: string]: Loose | undefined };

type Loose = ReadonlyJson | readonly Loose[] | Fields;

export type State = string | readonly Loose[] | Fields;

function isList(value: Loose): value is readonly Loose[] {
  return Array.isArray(value);
}

function fields(given: Fields): { readonly [key: string]: ReadonlyJson } {
  return Object.fromEntries(
    Object.entries(given).flatMap<[string, ReadonlyJson]>(([key, value]) =>
      value === undefined ? [] : [[key, json(value)]],
    ),
  );
}

function json(value: Loose): ReadonlyJson {
  return typeof value !== 'object' || value === null
    ? value
    : structured(value);
}

export function structured(state: State): Structured {
  if (typeof state === 'string') return state;
  return isList(state) ? state.map(json) : fields(state);
}
