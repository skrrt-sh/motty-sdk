import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { cacheOf, cacheTo } from '../../src/wire/cache-control.ts';

test('a cache marker is read with and without its lifetime', () => {
  expect(cacheOf(undefined)).toEqual({});
  expect(cacheOf(null)).toEqual({});
  expect(cacheOf({ type: 'ephemeral' })).toEqual({ cache: {} });
  expect(cacheOf({ type: 'ephemeral', ttl: '1h' })).toEqual({
    cache: { ttl: '1h' },
  });
});

test('a malformed cache marker is rejected', () => {
  expect(() => cacheOf('ephemeral')).toThrow(InvalidRequest);
  expect(() => cacheOf({ type: 'persistent' })).toThrow(InvalidRequest);
  expect(() => cacheOf({ type: 'ephemeral', ttl: '2h' })).toThrow(
    InvalidRequest,
  );
});

test('a cache marker is written back as it was read', () => {
  expect(cacheTo(undefined)).toEqual({});
  expect(cacheTo({})).toEqual({ cache_control: { type: 'ephemeral' } });
  expect(cacheTo({ ttl: '5m' })).toEqual({
    cache_control: { type: 'ephemeral', ttl: '5m' },
  });
});
