import type { Cache, Json } from '@mottyjs/core/host';
import { type Dict, given, isDict } from './json.ts';
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

export function cacheTo(cache: Cache | undefined): Dict {
  if (cache === undefined) return {};
  return { cache_control: given({ type: 'ephemeral', ttl: cache.ttl }) };
}
