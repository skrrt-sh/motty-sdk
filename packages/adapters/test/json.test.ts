import { expect, test } from 'bun:test';
import { parsed } from '../src/json.ts';

test('every kind of JSON value is read as it was written', () => {
  expect(
    parsed('{"text":"deep","n":1.5,"on":true,"none":null,"list":[1,[2]]}'),
  ).toEqual({ text: 'deep', n: 1.5, on: true, none: null, list: [1, [2]] });
  expect(parsed('null')).toBeNull();
});
