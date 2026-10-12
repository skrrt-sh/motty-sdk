import { expect, test } from 'bun:test';
import {
  copied,
  dict,
  given,
  isDict,
  list,
  number,
  parsed,
  text,
  without,
} from '../../src/wire/json.ts';

test('only a JSON object is a dict', () => {
  expect(isDict({ a: 1 })).toBe(true);
  expect(isDict([1])).toBe(false);
  expect(isDict(null)).toBe(false);
  expect(isDict('a')).toBe(false);
  expect(isDict(undefined)).toBe(false);
});

test('a value of the wrong kind reads as empty or absent', () => {
  expect(dict([1])).toEqual({});
  expect(dict({ a: 1 })).toEqual({ a: 1 });
  expect(list({ a: 1 })).toEqual([]);
  expect(list([1, 'a'])).toEqual([1, 'a']);
  expect(text(1)).toBeUndefined();
  expect(text('a')).toBe('a');
  expect(number('1')).toBeUndefined();
  expect(number(0)).toBe(0);
});

test('text that is not JSON parses to nothing', () => {
  expect(parsed('{"a":[1,null]}')).toEqual({ a: [1, null] });
  expect(parsed('null')).toBeNull();
  expect(parsed('{"a":')).toBeUndefined();
  expect(parsed('')).toBeUndefined();
});

test('every kind of JSON value parses to itself', () => {
  expect(parsed('[1,"a",true,null,{"b":[]}]')).toEqual([
    1,
    'a',
    true,
    null,
    { b: [] },
  ]);
  expect(parsed('"a"')).toBe('a');
  expect(parsed('0')).toBe(0);
  expect(parsed('false')).toBe(false);
});

test('a key named as the prototype parses to a key like any other', () => {
  const read = dict(parsed('{"__proto__":{"planted":true},"a":1}'));
  const { planted } = read;

  expect(Object.keys(read)).toEqual(['__proto__', 'a']);
  expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  expect(planted).toBeUndefined();
});

test('a field that was not given is left out, a null is kept', () => {
  expect(given({ a: 1, b: undefined, c: null, d: false })).toEqual({
    a: 1,
    c: null,
    d: false,
  });
  expect(Object.keys(given({ b: undefined }))).toEqual([]);
});

test('a copy shares nothing with what it was made from', () => {
  const schema = { type: 'object', required: ['a'], properties: { a: {} } };

  const copy = copied(schema);
  const { required } = dict(copy);

  expect(copy).toEqual(schema);
  expect(copy).not.toBe(schema);
  expect(required).toEqual(['a']);
  expect(required).not.toBe(schema.required);
  expect(copied('a')).toBe('a');
  expect(copied(null)).toBeNull();
});

test('a copy keeps a key named as the prototype as a key', () => {
  const copy = dict(
    copied(parsed('{"__proto__":{"planted":true},"a":1}') ?? {}),
  );
  const { planted } = copy;

  expect(Object.keys(copy)).toEqual(['__proto__', 'a']);
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  expect(planted).toBeUndefined();
});

test('text nested deeper than any request goes parses to nothing, and brackets in a string open nothing', () => {
  expect(parsed(`${'['.repeat(512)}${']'.repeat(512)}`)).toBeDefined();
  expect(parsed(`${'['.repeat(513)}${']'.repeat(513)}`)).toBeUndefined();
  expect(parsed(`${'{"a":'.repeat(513)}1${'}'.repeat(513)}`)).toBeUndefined();
  expect(parsed(`{"a":[[${'[1],'.repeat(600)}[1]]]}`)).toBeDefined();
  expect(parsed(JSON.stringify(['['.repeat(2000)]))).toEqual([
    '['.repeat(2000),
  ]);
  expect(parsed(JSON.stringify([`\\"${'{"'.repeat(1000)}\\`, 'b']))).toEqual([
    `\\"${'{"'.repeat(1000)}\\`,
    'b',
  ]);
});

test('a copy is made of a value as deep as any that is read', () => {
  const deep = parsed(`${'{"a":'.repeat(512)}1${'}'.repeat(512)}`) ?? null;

  expect(copied(deep)).toEqual(deep);
});

test('a given field named as the prototype is a field, and nothing is read through it', () => {
  const kept = given(dict(parsed('{"__proto__":{"planted":true},"a":1}')));
  const { planted } = kept;

  expect(Object.keys(kept)).toEqual(['__proto__', 'a']);
  expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  expect(planted).toBeUndefined();
});

test('the named fields are left out, and one named as the prototype is a field', () => {
  const rest = without(
    dict(parsed('{"__proto__":{"planted":true},"a":1,"b":2}')),
    ['a'],
  );
  const { planted } = rest;

  expect(Object.keys(rest)).toEqual(['__proto__', 'b']);
  expect(Object.getPrototypeOf(rest)).toBe(Object.prototype);
  expect(planted).toBeUndefined();
  expect(without({ a: 1 }, [])).toEqual({ a: 1 });
});
