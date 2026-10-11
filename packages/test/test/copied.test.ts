import { expect, test } from 'bun:test';
import { copied } from '../src/copied.ts';

test('a copy shares nothing with what it was made from', () => {
  const given = { list: [{ deep: 1 }], text: 'a', none: null };
  const copy = copied(given);

  expect(copy).toEqual(given);
  expect(copy).not.toBe(given);
  expect(copy).toHaveProperty('list', [{ deep: 1 }]);
  given.list.push({ deep: 2 });
  expect(copy).toHaveProperty('list', [{ deep: 1 }]);
});

test('a key named as the prototype is held as a key of the copy, at any depth', () => {
  const copy = copied({
    inner: Object.fromEntries([['__proto__', { admin: true }]]),
  });

  expect(JSON.stringify(copy)).toBe('{"inner":{"__proto__":{"admin":true}}}');
  expect(copy).not.toHaveProperty('inner.admin');
});
