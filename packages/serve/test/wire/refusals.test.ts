import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import { a, invalid, unsupported } from '../../src/wire/refusals.ts';

test("a malformed body is the caller's mistake", () => {
  expect(() => invalid('model must be a string')).toThrow(InvalidRequest);
  expect(() => invalid('model must be a string')).toThrow(
    'model must be a string',
  );
});

test('what this wire cannot say is unsupported', () => {
  expect(() => unsupported('no audio')).toThrow(Unsupported);
});

test('a kind is named with the article it takes', () => {
  expect(a('image')).toBe('an image');
  expect(a('audio')).toBe('an audio');
  expect(a('file')).toBe('a file');
  expect(a('tool_call')).toBe('a tool_call');
});
