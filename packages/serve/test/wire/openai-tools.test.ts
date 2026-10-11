import { expect, test } from 'bun:test';
import { customNames, parameterless } from '../../src/wire/openai-tools.ts';

test('the custom tools are told from the functions by name', () => {
  expect(
    customNames([
      { type: 'function', name: 'weather', input: {} },
      { type: 'custom', name: 'patch' },
    ]),
  ).toEqual(new Set(['patch']));
  expect(customNames(undefined)).toEqual(new Set());
});

test('a function that takes no parameters gets a schema of its own', () => {
  expect(parameterless()).toEqual({ type: 'object', properties: {} });
  expect(parameterless()).not.toBe(parameterless());
});
