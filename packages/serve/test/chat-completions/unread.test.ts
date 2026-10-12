import { expect, test } from 'bun:test';
import {
  callFields,
  mergedUnread,
  toolFields,
  unreadOf,
  wireCall,
  withUnread,
} from '../../src/chat-completions/unread.ts';
import { dict, parsed } from '../../src/wire/json.ts';

test('a call that holds its own fields alone carries nothing', () => {
  expect(
    unreadOf(
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
    unreadOf(
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
    unreadOf(
      { type: 'custom', custom: { vendor: 1 }, function: { signature: 'a' } },
      'custom',
      callFields,
    ),
  ).toEqual({ custom: { vendor: 1 } });
});

test('a tool keeps what a call does not, and each kind its own fields', () => {
  expect(
    unreadOf(
      { index: 2, function: { name: 'weather', format: 'x', strict: true } },
      'function',
      toolFields,
    ),
  ).toEqual({ index: 2, function: { format: 'x' } });
  expect(
    unreadOf(
      { custom: { name: 'shell', format: {}, strict: true } },
      'custom',
      toolFields,
    ),
  ).toEqual({ custom: { strict: true } });
});

test('a field named as the prototype is carried as any other', () => {
  const carried = unreadOf(
    dict(parsed('{"id":"call_a","__proto__":{"a":1}}')),
    'function',
    callFields,
  );

  expect(Object.keys(carried ?? {})).toEqual(['__proto__']);
});

test.each([
  ['custom', { function: { signature: 'a' }, late: 1 }],
  ['function', { type: 'custom', custom: { signature: 'a' }, late: 1 }],
] as const)(
  'what a fragment marked as the other kind than its %s call holds inside is carried inside the call`s own object',
  (kind, raw) => {
    expect(unreadOf(raw, kind, callFields)).toEqual({
      late: 1,
      [kind]: { signature: 'a' },
    });
  },
);

test('what a later fragment carried is added to an earlier one`s, at the top and inside alike', () => {
  expect(
    mergedUnread(
      [
        { a: 1, b: 1, function: { c: 1, d: 1 } },
        { b: 2, e: 2, function: { d: 2, f: 2 } },
        { g: 3, custom: { h: 3 } },
      ],
      'function',
    ),
  ).toEqual({
    a: 1,
    b: 2,
    e: 2,
    g: 3,
    custom: { h: 3 },
    function: { c: 1, d: 2, f: 2, h: 3 },
  });
});

test('one fragment is kept as it came, and none carry nothing', () => {
  expect(mergedUnread([{ a: 1 }], 'custom')).toEqual({ a: 1 });
  expect(mergedUnread([], 'custom')).toBeUndefined();
});

test('a field named as the prototype is merged as any other', () => {
  const merged = mergedUnread(
    [dict(parsed('{"__proto__":{"a":1}}')), { b: 1 }],
    'function',
  );

  expect(Object.keys(merged ?? {})).toEqual(['__proto__', 'b', 'function']);
});

test('what was carried goes back where it sat, under the call`s own fields', () => {
  expect(
    withUnread(
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
    withUnread(undefined, 'custom', callFields, { index: 0 }, { input: 'ls' }),
  ).toEqual({ index: 0, custom: { input: 'ls' } });
});

test('a carried field the call has of its own is never written', () => {
  expect(
    withUnread(
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

test.each([
  [
    'function',
    { index: 0, id: 'call_a', type: 'function' },
    { name: 'weather', arguments: '{}' },
  ],
  [
    'custom',
    { index: 0, id: 'call_a', type: 'custom' },
    { name: 'weather', input: '{}' },
  ],
] as const)(
  'a %s call that opens is written with its id, its kind and its name',
  (kind, outer, inner) => {
    expect(
      wireCall(kind, '{}', { vendor: 1 }, { id: 'call_a', name: 'weather' }, 0),
    ).toEqual({ vendor: 1, ...outer, [kind]: inner });
  },
);

test('a call that neither opens nor has a place is written as its input alone', () => {
  expect(wireCall('function', '{}')).toEqual({ function: { arguments: '{}' } });
});
