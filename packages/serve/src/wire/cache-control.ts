import type { Cache, Json } from '@mottyjs/core/host';
import { type Dict, dict, given, isDict, without } from './json.ts';
import { invalid } from './refusals.ts';

export function cacheOf(control: Json | undefined): { cache?: Cache } {
  if (control === undefined || control === null) return {};
  if (!isDict(control)) invalid('cache_control must be an object');
  const { type, ttl } = control;
  if (type !== 'ephemeral') invalid('cache_control.type must be "ephemeral"');
  if (ttl === undefined) return { cache: {} };
  if (ttl === '5m' || ttl === '1h') return { cache: { ttl } };
  return invalid('cache_control.ttl must be "5m" or "1h"');
}

// What a marker says beside its kind and lifetime, a scope among them, has
// no neutral form, so its family keeps it to write back under the marker.
export function cacheExtra(control: Json | undefined): Dict | undefined {
  const extra = without(dict(control), ['type', 'ttl']);
  return Object.keys(extra).length === 0 ? undefined : extra;
}

export function cacheTo(cache: Cache | undefined, extra?: Json): Dict {
  if (cache === undefined) return {};
  return {
    cache_control: {
      ...dict(extra),
      ...given({ type: 'ephemeral', ttl: cache.ttl }),
    },
  };
}
