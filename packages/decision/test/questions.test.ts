import { expect, test } from 'bun:test';
import { choice, noul, score } from '../src/questions.ts';

test('a builder adds the kind of its question and leaves the rest as given', () => {
  expect(
    choice({
      instructions: 'How much reasoning does this need?',
      criteria: { quick: 'A short question', deep: null },
    }),
  ).toEqual({
    type: 'choice',
    instructions: 'How much reasoning does this need?',
    criteria: { quick: 'A short question', deep: null },
  });
  expect(
    score({
      instructions: 'How risky is this change?',
      criteria: ['Harmless', 'Needs a review', 'Dangerous'],
    }),
  ).toEqual({
    type: 'score',
    instructions: 'How risky is this change?',
    criteria: ['Harmless', 'Needs a review', 'Dangerous'],
  });
  expect(noul({ instructions: 'Is this about software?' })).toEqual({
    type: 'noul',
    instructions: 'Is this about software?',
  });
  expect(
    noul({
      instructions: 'Is this about software?',
      criteria: { true: 'It names code', false: 'It names none' },
    }),
  ).toEqual({
    type: 'noul',
    instructions: 'Is this about software?',
    criteria: { true: 'It names code', false: 'It names none' },
  });
});

test('a choice takes one to 255 options and is refused with none or one more', () => {
  const options = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`team-${index}`, null]),
    );

  expect(
    [1, 255].map(
      (count) =>
        Object.keys(
          choice({ instructions: 'Which team?', criteria: options(count) })
            .criteria,
        ).length,
    ),
  ).toEqual([1, 255]);
  expect(() => choice({ instructions: 'Which team?', criteria: {} })).toThrow(
    new Error('A choice has from one to 255 options, and this one has 0'),
  );
  expect(() =>
    choice({ instructions: 'Which team?', criteria: options(256) }),
  ).toThrow(
    new Error('A choice has from one to 255 options, and this one has 256'),
  );
});

test('a score takes one to ten levels and is refused with none or eleven', () => {
  const levels = (count: number) =>
    Array.from({ length: count }, (_, index) => `Level ${index}`);

  expect(
    [1, 10].map(
      (count) =>
        score({ instructions: 'How risky?', criteria: levels(count) }).criteria
          .length,
    ),
  ).toEqual([1, 10]);
  expect(() => score({ instructions: 'How risky?', criteria: [] })).toThrow(
    new Error('A score has from one to ten levels, and this one has 0'),
  );
  expect(() =>
    score({ instructions: 'How risky?', criteria: levels(11) }),
  ).toThrow(
    new Error('A score has from one to ten levels, and this one has 11'),
  );
});
