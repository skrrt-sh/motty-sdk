import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { carrying } from '../../src/wire/carried.ts';
import { dict, parsed } from '../../src/wire/json.ts';

test('only the headers named are heard, in any letter case, and an empty one says nothing', () => {
  const { heard } = carrying((name) => name.endsWith('-beta'));
  expect(
    heard(
      new Headers({
        'Anthropic-Beta': ' effort-2025-11-24 ',
        'openai-beta': ' ',
        'x-api-key': 'sk-ant-callers-own',
        'x-app': 'cli',
      }),
    ),
  ).toEqual({ 'anthropic-beta': 'effort-2025-11-24' });
});

test('a header sent twice is heard as one list', () => {
  const headers = new Headers();
  headers.append('anthropic-beta', 'effort-2025-11-24');
  headers.append('anthropic-beta', 'files-api-2025-04-14');
  expect(carrying((name) => name === 'anthropic-beta').heard(headers)).toEqual({
    'anthropic-beta': 'effort-2025-11-24, files-api-2025-04-14',
  });
});

test('fields are parted into the headers named and the body`s own', () => {
  expect(
    carrying((name) => name === 'anthropic-beta').parted({
      'anthropic-beta': 'effort-2025-11-24',
      'x-api-key': 'sk-ant-planted',
      service_tier: 'auto',
    }),
  ).toEqual({
    headers: { 'anthropic-beta': 'effort-2025-11-24' },
    rest: { 'x-api-key': 'sk-ant-planted', service_tier: 'auto' },
  });
});

test('a header named in another letter case is still a header', () => {
  expect(
    carrying((name) => name === 'anthropic-beta').parted({
      'Anthropic-Beta': 'effort-2025-11-24',
    }),
  ).toEqual({ headers: { 'anthropic-beta': 'effort-2025-11-24' }, rest: {} });
});

test('a header that is not text fails the call', () => {
  expect(() =>
    carrying((name) => name === 'anthropic-beta').parted({
      'anthropic-beta': ['effort-2025-11-24'],
    }),
  ).toThrow(new InvalidRequest('The header anthropic-beta must be text'));
});

test('a field named as the prototype stays the body`s own, and names no header', () => {
  const { headers, rest } = carrying(
    (name) => name === 'anthropic-beta',
  ).parted(
    dict(
      parsed(
        '{"__proto__":{"anthropic-beta":"planted","service_tier":"planted"},"container":"c_1"}',
      ),
    ),
  );
  const { service_tier: tier } = rest;

  expect(headers).toEqual({});
  expect(Object.keys(rest)).toEqual(['__proto__', 'container']);
  expect(Object.getPrototypeOf(rest)).toBe(Object.prototype);
  expect(tier).toBeUndefined();
});
