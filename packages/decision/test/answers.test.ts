import { expect, test } from 'bun:test';
import { InvalidOutput } from '@mottyjs/core';
import { assertAnswers } from '../src/answers.ts';
import { choice, noul, score } from '../src/questions.ts';

test('an answer of each kind passes in the fields of the API', () => {
  expect(() =>
    assertAnswers(
      {
        tier: choice({
          instructions: 'How much reasoning does this need?',
          criteria: { quick: 'A short question', deep: null },
        }),
        risk: score({
          instructions: 'How risky is this change?',
          criteria: ['Harmless', 'Dangerous'],
        }),
        software: noul({ instructions: 'Is this about software?' }),
      },
      {
        tier: {
          type: 'choice',
          choice: 'deep',
          probabilities: { quick: 0, deep: 1 },
          confidence: 0.8,
        },
        risk: {
          type: 'score',
          score: 0.7,
          legend: { '0': 'Harmless', '1': 'Dangerous' },
          probabilities: { '0': 0.3, '1': 0.7 },
          confidence: 0.4,
        },
        software: { type: 'noul', noul: 1 },
      },
    ),
  ).not.toThrow();
});

test('a legend holds a structured level as the question gave it', () => {
  expect(() =>
    assertAnswers(
      {
        risk: score({
          instructions: 'How risky is this change?',
          criteria: [
            { label: 'Harmless', examples: ['a typo'] },
            ['Dangerous'],
          ],
        }),
      },
      {
        risk: {
          type: 'score',
          score: 1,
          legend: {
            '0': { label: 'Harmless', examples: ['a typo'] },
            '1': ['Dangerous'],
          },
          probabilities: { '0': 0, '1': 1 },
          confidence: 1,
        },
      },
    ),
  ).not.toThrow();
});

test('fields the API does not name are passed over, in an answer and beside it', () => {
  expect(() =>
    assertAnswers(
      { software: noul({ instructions: 'Is this about software?' }) },
      {
        software: {
          type: 'noul',
          noul: 0.9,
          margin: 'wide',
          action: { act_probability: 1, kind: 7 },
        },
        extra: { type: 'noul', noul: 'yes' },
      },
    ),
  ).not.toThrow();
});

test('a noul is typed with no x_jev_confidence, so one of any type is passed over', () => {
  expect(() =>
    assertAnswers(
      { refund: noul({ instructions: 'Does this ask for a refund?' }) },
      { refund: { type: 'noul', noul: 0.5, x_jev_confidence: 'n/a' } },
    ),
  ).not.toThrow();
});

test.each([
  ['a list', 'The decision model returned no answers', []],
  [
    'an answer missing',
    'The decision model\'s answer to "tier" is missing',
    { risk: { type: 'noul', noul: 1 } },
  ],
  [
    'an answer of another kind',
    'The decision model\'s answer to "tier" is not a choice',
    { tier: { type: 'noul', noul: 1 } },
  ],
  [
    'a choice that is no option',
    'The decision model\'s answer to "tier" chooses no option of the question',
    {
      tier: {
        type: 'choice',
        choice: 'huge',
        probabilities: { quick: 0.5, deep: 0.5 },
        confidence: 1,
      },
    },
  ],
  [
    'a probability above one',
    'The decision model\'s answer to "tier" lacks a probability for each option',
    {
      tier: {
        type: 'choice',
        choice: 'deep',
        probabilities: { quick: 0, deep: 90 },
        confidence: 1,
      },
    },
  ],
  [
    'a choice without confidence',
    'The decision model\'s answer to "tier" has no confidence',
    {
      tier: {
        type: 'choice',
        choice: 'deep',
        probabilities: { quick: 0, deep: 1 },
      },
    },
  ],
])('answers with %s are InvalidOutput', (_what, message, answers) => {
  const questions = {
    tier: choice({
      instructions: 'How much reasoning does this need?',
      criteria: { quick: 'A short question', deep: 'Needs a plan' },
    }),
  };

  expect(() => assertAnswers(questions, answers)).toThrow(
    new InvalidOutput(message),
  );
});

test.each([
  [
    'no probability for one of its levels',
    'lacks a probability for each level',
    {
      type: 'score',
      score: 1,
      probabilities: { '1': 1 },
      legend: { '0': 'Low', '1': 'High' },
      confidence: 1,
    },
  ],
  [
    'its score above the highest level',
    'has a score outside the levels of the question',
    {
      type: 'score',
      score: 7,
      probabilities: { '0': 0, '1': 1 },
      legend: { '0': 'Low', '1': 'High' },
      confidence: 1,
    },
  ],
  [
    'its score below the lowest level',
    'has a score outside the levels of the question',
    {
      type: 'score',
      score: -0.5,
      probabilities: { '0': 1, '1': 0 },
      legend: { '0': 'Low', '1': 'High' },
      confidence: 1,
    },
  ],
  [
    'no finite number as its score',
    'has no score',
    {
      type: 'score',
      score: Number.NaN,
      probabilities: { '0': 0, '1': 1 },
      legend: { '0': 'Low', '1': 'High' },
      confidence: 1,
    },
  ],
  [
    'no legend',
    'has no legend',
    {
      type: 'score',
      score: 1,
      probabilities: { '0': 0, '1': 1 },
      confidence: 1,
    },
  ],
  [
    'a legend entry that is neither text nor structured',
    'has no legend',
    {
      type: 'score',
      score: 1,
      probabilities: { '0': 0, '1': 1 },
      legend: { '0': 7 },
      confidence: 1,
    },
  ],
  [
    'no finite number as its confidence',
    'has no confidence',
    {
      type: 'score',
      score: 1,
      probabilities: { '0': 0, '1': 1 },
      legend: { '0': 'Low', '1': 'High' },
      confidence: Number.POSITIVE_INFINITY,
    },
  ],
])('a score with %s is InvalidOutput', (_what, mistake, risk) => {
  const questions = {
    risk: score({
      instructions: 'How risky is this change?',
      criteria: ['Harmless', 'Dangerous'],
    }),
  };

  expect(() => assertAnswers(questions, { risk })).toThrow(
    new InvalidOutput(`The decision model's answer to "risk" ${mistake}`),
  );
});

test('a noul that is no probability is InvalidOutput', () => {
  const questions = { software: noul({ instructions: 'Software?' }) };

  expect(() =>
    assertAnswers(questions, { software: { type: 'noul', noul: 'yes' } }),
  ).toThrow(
    new InvalidOutput(
      'The decision model\'s answer to "software" has no probability',
    ),
  );
});

test('an answer from Laya with a confidence gate one answer fell below passes', () => {
  expect(() =>
    assertAnswers(
      {
        topic: choice({
          instructions: 'What is this about?',
          criteria: { billing: null, technical: null, other: null },
        }),
        urgency: score({
          instructions: 'How urgent is this?',
          criteria: ['not urgent', 'soon', 'blocking'],
        }),
        refund: noul({ instructions: 'Does this ask for a refund?' }),
      },
      {
        topic: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.9968, technical: 0.0001, other: 0.003 },
          confidence: 0.9799,
          answer_confidence: 0.9968,
          action: { act_probability: 1 },
          abstention: 'passed',
          abstention_threshold: 0.9,
          x_jev_confidence: 0.9953,
        },
        urgency: {
          type: 'score',
          score: 1.8101,
          legend: { '0': 'not urgent', '1': 'soon', '2': 'blocking' },
          probabilities: { '0': 0.0208, '1': 0.1483, '2': 0.8309 },
          confidence: 0.529,
          answer_confidence: 0.8309,
          action: { act_probability: 1 },
          low_confidence: true,
          abstention: 'abstained',
          abstention_threshold: 0.9,
          x_jev_confidence: 0.7151,
        },
        refund: {
          type: 'noul',
          noul: 0.9372,
          confidence: 0.9372,
          answer_confidence: 0.9372,
          action: { act_probability: 1 },
          abstention: 'passed',
          abstention_threshold: 0.9,
        },
      },
    ),
  ).not.toThrow();
});

test.each([
  ['topic', 'answer_confidence', 'high'],
  ['topic', 'x_jev_confidence', '0.98'],
  ['topic', 'action', {}],
  ['topic', 'low_confidence', false],
  ['topic', 'abstention', 'skipped'],
  ['topic', 'abstention_threshold', '0.9'],
  ['refund', 'confidence', 'high'],
])(
  'a field Laya adds that is there and of another type is InvalidOutput: in %s, %s as %p',
  (id, field, value) => {
    expect(() =>
      assertAnswers(
        {
          topic: choice({
            instructions: 'What is this about?',
            criteria: { billing: null, other: null },
          }),
          refund: noul({ instructions: 'A refund?' }),
        },
        {
          topic: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.6, other: 0.4 },
            confidence: 0.03,
            ...(id === 'topic' && { [field]: value }),
          },
          refund: {
            type: 'noul',
            noul: 0.879,
            ...(id === 'refund' && { [field]: value }),
          },
        },
      ),
    ).toThrow(
      new InvalidOutput(
        `The decision model's answer to "${id}" has the wrong type of ${field}`,
      ),
    );
  },
);
