import { expect, test } from 'bun:test';
import { structured } from '../src/state.ts';

test('a field that is undefined is left out, at any depth, as JSON leaves it out', () => {
  expect(
    structured({
      schema: undefined,
      question: 'Fill the form',
      thread: [{ role: 'user', name: undefined, turns: [1, null] }],
      __proto__: null,
    }),
  ).toStrictEqual({
    question: 'Fill the form',
    thread: [{ role: 'user', turns: [1, null] }],
  });
});

test('a list is sent as a list, its fields cleared the same way', () => {
  expect(
    structured(['Refactor the scheduler', { files: 40, owner: undefined }]),
  ).toStrictEqual(['Refactor the scheduler', { files: 40 }]);
});
