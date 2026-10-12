import { expect, test } from 'bun:test';
import {
  callFields,
  merged,
  parted,
  rebuilt,
  toolFields,
} from '../../src/chat-completions/unread.ts';
import { dict, parsed } from '../../src/wire/json.ts';

test('a call that holds its own fields alone carries nothing', () => {
  expect(
    parted(
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'weather', arguments: '{}' },
      },
      'function',
      callFields,
    ),
  ).toBeUndefined();
});

test('a field around the object is carried at the top and one inside under its key', () => {
  expect(
    parted(
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'weather', arguments: '{}', signature: 'c2ln' },
        extra_content: { a: 1 },
      },
      'function',
      callFields,
    ),
  ).toEqual({ extra_content: { a: 1 }, function: { signature: 'c2ln' } });
});

test('the object of the other kind is not carried', () => {
  expect(
    parted(
      { type: 'custom', custom: { vendor: 1 }, function: { signature: 'a' } },
      'custom',
      callFields,
    ),
  ).toEqual({ custom: { vendor: 1 } });
});

test('a tool keeps what a call does not, and each kind its own fields', () => {
  expect(
    parted(
      { index: 2, function: { name: 'weather', format: 'x', strict: true } },
      'function',
      toolFields,
    ),
  ).toEqual({ index: 2, function: { format: 'x' } });
  expect(
    parted(
      { custom: { name: 'shell', format: {}, strict: true } },
      'custom',
      toolFields,
    ),
  ).toEqual({ custom: { strict: true } });
});

test('a field named as the prototype is carried as any other', () => {
  const carried = parted(
    dict(parsed('{"id":"call_a","__proto__":{"a":1}}')),
    'function',
    callFields,
  );

  expect(Object.keys(carried ?? {})).toEqual(['__proto__']);
});

test('what a later fragment carried is added to an earlier one`s, at the top and inside alike', () => {
  expect(
    merged(
      { a: 1, b: 1, function: { c: 1, d: 1 } },
      { b: 2, e: 2, function: { d: 2, f: 2 } },
      'function',
    ),
  ).toEqual({ a: 1, b: 2, e: 2, function: { c: 1, d: 2, f: 2 } });
});

test('the first fragment to carry anything is kept as it came', () => {
  expect(merged(undefined, { a: 1 }, 'custom')).toEqual({ a: 1 });
});

test('what was carried goes back where it sat, under the call`s own fields', () => {
  expect(
    rebuilt(
      { extra_content: { a: 1 }, function: { signature: 'c2ln' } },
      'function',
      callFields,
      { id: 'call_a', type: 'function' },
      { name: 'weather', arguments: '{}' },
    ),
  ).toEqual({
    extra_content: { a: 1 },
    id: 'call_a',
    type: 'function',
    function: { signature: 'c2ln', name: 'weather', arguments: '{}' },
  });
});

test('nothing carried leaves the call`s own fields alone', () => {
  expect(
    rebuilt(undefined, 'custom', callFields, { index: 0 }, { input: 'ls' }),
  ).toEqual({ index: 0, custom: { input: 'ls' } });
});

test('a carried field the call has of its own is never written', () => {
  expect(
    rebuilt(
      {
        index: 9,
        id: 'call_stray',
        type: 'stray',
        custom: { name: 'stray' },
        function: { name: 'stray', arguments: 'stray', input: 'stray', a: 1 },
      },
      'function',
      callFields,
      { index: 0 },
      { arguments: '{}' },
    ),
  ).toEqual({ index: 0, function: { a: 1, arguments: '{}' } });
});
