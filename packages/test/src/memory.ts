import type { Json, ReadonlyJson, Storage } from '@mottyjs/core/host';

// Refused as a real store refuses it, in the same words, so a motty that
// passes here does not fail there.
function milliseconds(ttl: number | undefined): number | undefined {
  const ms = ttl === undefined ? undefined : Math.ceil(ttl * 1000);
  if (ms !== undefined && (!(ms >= 1) || !Number.isSafeInteger(ms))) {
    throw new Error(
      `A time to live is a positive, finite number of seconds, and ${ttl} is not`,
    );
  }
  return ms;
}

function isList(value: ReadonlyJson): value is readonly ReadonlyJson[] {
  return Array.isArray(value);
}

// A real store holds JSON text, which has no negative zero and writes a
// number that is not finite as null. The copy is what that text reads back as.
function kept(value: ReadonlyJson): Json {
  if (typeof value === 'number')
    return Number.isFinite(value) ? value + 0 : null;
  if (typeof value !== 'object' || value === null) return value;
  if (isList(value)) return value.map(kept);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, kept(item)]),
  );
}

// A copy is held and a copy is read back, as with a real store: a value
// changed after it was set, or after it was read, does not change what is
// stored.
export function memory(): Storage {
  const held = new Map<string, { value: Json; until: number }>();
  return {
    get: async (key) => {
      const found = held.get(key);
      if (found === undefined) return undefined;
      if (found.until > Date.now()) return kept(found.value);
      held.delete(key);
      return undefined;
    },
    set: async (key, value, options) => {
      const ms = milliseconds(options?.ttl);
      held.set(key, {
        value: kept(value),
        until: ms === undefined ? Number.POSITIVE_INFINITY : Date.now() + ms,
      });
    },
    delete: async (key) => {
      held.delete(key);
    },
    // Nothing is awaited between the read and the write, so two additions
    // made at once are both kept, as they are by a real store.
    increment: async (key, by, options) => {
      if (!Number.isFinite(by)) {
        throw new Error(`An increment is a finite number, and ${by} is not`);
      }
      const ms = milliseconds(options?.ttl);
      const found = held.get(key);
      const live =
        found !== undefined && found.until > Date.now() ? found : undefined;
      const before = live === undefined ? 0 : live.value;
      if (typeof before !== 'number') {
        throw new Error(`The value stored under ${key} is not a number`);
      }
      const total = before + by;
      if (!Number.isFinite(total)) {
        throw new Error(
          `The total stored under ${key} would not be a finite number`,
        );
      }
      const made =
        ms === undefined ? Number.POSITIVE_INFINITY : Date.now() + ms;
      held.set(key, { value: total, until: live?.until ?? made });
      return total;
    },
  };
}
