import { Unsupported } from '@mottyjs/core';
import {
  hosted,
  type Json,
  type ReadonlyJson,
  type Storage,
} from '@mottyjs/core/host';

function storage() {
  const supplied = hosted().storage;
  if (supplied === undefined) {
    throw new Error('The store was used, and the host supplied no storage');
  }
  return supplied;
}

// The type is the author's own claim about what they stored. The store is
// one command over a database and holds no schema to check it with, so a
// value another version wrote is read as that type all the same.
function get<Value extends ReadonlyJson = Json>(
  key: string,
): Promise<Value | undefined>;
async function get(key: string): Promise<Json | undefined> {
  return storage().get(key);
}

// Never made of a read and a write here: two requests adding at once would
// each read the same number, and one addition would be lost.
async function increment(
  key: string,
  by = 1,
  options?: { ttlMs?: number },
): Promise<number> {
  const supplied = storage().increment;
  if (supplied === undefined) {
    throw new Unsupported(
      'The store was asked to increment, and the storage of the host cannot',
    );
  }
  return supplied(key, by, options);
}

export const store = Object.freeze({
  get,
  set: async (...given: Parameters<Storage['set']>) => storage().set(...given),
  delete: async (key: string) => storage().delete(key),
  increment,
});
