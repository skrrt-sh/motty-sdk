import { expect, test } from 'bun:test';
import { parameterless } from '../../src/wire/openai-tools.ts';

test('a function that takes no parameters gets a schema of its own', () => {
  expect(parameterless()).toEqual({ type: 'object', properties: {} });
  expect(parameterless()).not.toBe(parameterless());
});
