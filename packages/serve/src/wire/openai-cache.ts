import type { Cache } from '@mottyjs/core/host';
import { cacheTo } from './cache-control.ts';
import type { Leaving } from './fieldless.ts';
import type { Dict } from './json.ts';

// Both OpenAI APIs mark the end of a cached prefix the same way, on a
// content part, and neither gives one marker a lifetime of its own. A
// router's marker has one, and sits in the same place.
export function breakpoint(left: Leaving, cache: Cache | undefined): Dict {
  if (cache === undefined) return {};
  if (left.marks === 'cache_control') return cacheTo(cache);
  left.without('cache.ttl', cache.ttl);
  if (left.marks) return { prompt_cache_breakpoint: { mode: 'explicit' } };
  left.without('cache', cache);
  return {};
}

// A marker a key implied is no ask of an upstream that takes none: there
// it is not written, does not turn text into parts, and is not reported.
export function cacheFor(left: Leaving, cache: Cache | undefined) {
  return cache?.implied === true && !left.marks ? undefined : cache;
}
