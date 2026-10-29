import type { Cache, Json } from '@mottyjs/core/host';
import { cacheTo } from './cache-control.ts';
import type { Leaving } from './fieldless.ts';
import type { Dict } from './json.ts';

// Both OpenAI APIs mark the end of a cached prefix the same way, on a
// content part, and neither gives one marker a lifetime of its own. A
// router's marker has one, and sits in the same place; one that keeps a
// marker only five minutes is sent none. Where the lifetime is the
// request's, a marker writes nothing and only asks for its lifetime.
export function breakpoint(
  left: Leaving,
  cache: Cache | undefined,
  extra?: Json,
): Dict {
  if (cache === undefined) return {};
  if (left.lifetime === 'prompt_cache_options') {
    left.lasting(cache);
    return {};
  }
  if (left.marks === 'cache_control') {
    if (left.lifetime !== '5m') return cacheTo(cache, extra);
    left.without('cache.ttl', cache.ttl === '1h' ? cache.ttl : undefined);
    return cacheTo({}, extra);
  }
  left.without('cache.ttl', cache.ttl);
  if (left.marks) return { prompt_cache_breakpoint: { mode: 'explicit' } };
  left.without('cache', cache);
  return {};
}

// A marker a key implied is no ask of an upstream that takes none: there
// it is not written, does not turn text into parts, and is not reported.
// Where the lifetime is the request's, no marker is written either.
export function cacheFor(left: Leaving, cache: Cache | undefined) {
  if (cache !== undefined && left.lifetime === 'prompt_cache_options') {
    left.lasting(cache);
    return undefined;
  }
  return cache?.implied === true && !left.marks ? undefined : cache;
}

// A marker a key implied is no ask of the caller, so with no place it is
// not reported either.
export function asked(cache: Cache | undefined): Cache | undefined {
  return cache?.implied === true ? undefined : cache;
}
