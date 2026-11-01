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

/**
 * Reads a key, or undefined when it holds nothing. The type is the author's own
 * claim, since the store holds no schema to check it with.
 */
function get<Value extends ReadonlyJson = Json>(
  key: string,
): Promise<Value | undefined>;
async function get(key: string): Promise<Json | undefined> {
  return storage().get(key);
}

/**
 * Adds to a number in one step of the database, starting from zero, and gives
 * the total. A `ttl` applies only to a key this call makes, and a host whose
 * storage cannot add throws `Unsupported`.
 */
async function increment(
  key: string,
  by = 1,
  options?: { ttl?: number },
): Promise<number> {
  const supplied = storage().increment;
  if (supplied === undefined) {
    throw new Unsupported(
      'The store was asked to increment, and the storage of the host cannot',
    );
  }
  return supplied(key, by, options);
}

/**
 * What survives a request, with `get`, `set`, `delete` and `increment` over the
 * storage the host supplies. The host puts the motty's name ahead of every key,
 * a `ttl` is a whole number of ms, and each throws when the host supplied no
 * storage.
 *
 * @example
 * ```ts
 * await store.set('tier:42', 'deep', { ttl: 86_400_000 });
 * const tier = await store.get<string>('tier:42');
 * ```
 */
export const store = Object.freeze({
  get,
  set: async (...given: Parameters<Storage['set']>) => storage().set(...given),
  delete: async (key: string) => storage().delete(key),
  increment,
});
