import { expect, test } from 'bun:test';
import { Overloaded } from '@mottyjs/core';
import { decision } from '@mottyjs/decision';
import { type DecisionReply, fake, on, Unscripted } from '../src/index.ts';

const judge = decision('acme/judge');

test('a number answers a noul with the probability of yes', async () => {
  const models = fake(on(judge, { software: 0.97 }));

  const output = await models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        software: { type: 'noul', instructions: 'Is this about software?' },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toEqual({
    model: 'acme/judge',
    answers: { software: { type: 'noul', noul: 0.97 } },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
});

test('the options a script leaves out share what it leaves over, so a choice sums to one as the API has it', async () => {
  const models = fake(
    on(judge, {
      tier: { deep: 0.9 },
      topic: { billing: 0.6 },
      team: { payments: 0.7, mobile: 0.2, web: 0.1 },
    }),
  );

  const output = await models.decide(
    'acme/judge',
    {
      state: 'Why does this deadlock?',
      questions: {
        tier: {
          type: 'choice',
          instructions: 'How much reasoning does this need?',
          criteria: { quick: null, deep: null },
        },
        topic: {
          type: 'choice',
          instructions: 'What is this about?',
          criteria: { billing: null, technical: null, other: null },
        },
        team: {
          type: 'choice',
          instructions: 'Which team should take it?',
          criteria: { payments: null, mobile: null, web: null, support: null },
        },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toMatchObject({
    answers: {
      tier: {
        choice: 'deep',
        probabilities: { quick: expect.closeTo(0.1, 9), deep: 0.9 },
        confidence: expect.closeTo(0.8, 2),
      },
      topic: {
        choice: 'billing',
        probabilities: {
          billing: 0.6,
          technical: expect.closeTo(0.2, 9),
          other: expect.closeTo(0.2, 9),
        },
        confidence: expect.closeTo(0.4, 2),
      },
      // These three sum a floating error short of one, which is nobody's
      // chance.
      team: {
        choice: 'payments',
        probabilities: { payments: 0.7, mobile: 0.2, web: 0.1, support: 0 },
      },
    },
  });
});

test('a choice whose probabilities the API could not give is not scripted, and the error says why', async () => {
  const asked = (reply: DecisionReply) =>
    fake(on(judge, reply)).decide(
      'acme/judge',
      {
        state: 'My card was charged twice.',
        questions: {
          topic: {
            type: 'choice',
            instructions: 'What is this about?',
            criteria: { billing: null, technical: null, other: null },
          },
        },
      },
      AbortSignal.any([]),
    );

  // Laya's own answer to this question: it rounds each number on its own.
  await expect(
    asked({ topic: { billing: 0.9968, technical: 0.0001, other: 0.003 } }),
  ).resolves.toMatchObject({
    answers: { topic: { choice: 'billing', confidence: expect.any(Number) } },
  });
  await expect(
    asked({ topic: { billing: 0.9, technical: 0.9 } }),
  ).rejects.toBeInstanceOf(Unscripted);
  await expect(
    asked({ topic: { billing: 0.9, technical: 0.9 } }),
  ).rejects.toThrow(
    'No reply the decision API could give was scripted for the question topic asked of acme/judge: its probabilities sum to 1.8, not to one',
  );
  await expect(
    asked({ topic: { billing: 0.6, technical: 0.1, other: 0.1 } }),
  ).rejects.toThrow('its probabilities sum to 0.8, not to one');
  await expect(
    asked({ topic: { billing: 0, technical: 0, other: 0 } }),
  ).rejects.toThrow('its probabilities sum to 0, not to one');
});

test('a choice carries the confidence the API gives its probabilities', async () => {
  const models = fake(
    on(judge, {
      topic: { billing: 1, technical: 0, other: 0 },
      team: { payments: 0.69, mobile: 0.12, web: 0, support: 0.19 },
      mood: { happy: 0.36, unhappy: 0.64 },
    }),
  );

  const output = await models.decide(
    'acme/judge',
    {
      state: 'My card was charged twice.',
      questions: {
        topic: {
          type: 'choice',
          instructions: 'What is this about?',
          criteria: { billing: null, technical: null, other: null },
        },
        team: {
          type: 'choice',
          instructions: 'Which team should take it?',
          criteria: { payments: null, mobile: null, web: null, support: null },
        },
        mood: {
          type: 'choice',
          instructions: 'What is the mood?',
          criteria: { happy: null, unhappy: null },
        },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toMatchObject({
    answers: {
      topic: { choice: 'billing', confidence: 1 },
      team: { choice: 'payments', confidence: expect.closeTo(0.59, 2) },
      mood: { choice: 'unhappy', confidence: expect.closeTo(0.28, 2) },
    },
  });
});

test('a choice among one option is certain, as the API has it', async () => {
  const models = fake(on(judge, { mood: { happy: 1 } }));

  const output = await models.decide(
    'acme/judge',
    {
      state: 'It is fine.',
      questions: {
        mood: {
          type: 'choice',
          instructions: 'What is the mood?',
          criteria: { happy: null },
        },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toMatchObject({
    answers: {
      mood: { choice: 'happy', probabilities: { happy: 1 }, confidence: 1 },
    },
  });
});

test('a number answers a score with that level', async () => {
  const models = fake(on(judge, { effort: 1 }));

  const output = await models.decide(
    'acme/judge',
    {
      state: 'Why does this deadlock?',
      questions: {
        effort: {
          type: 'score',
          instructions: 'How hard is this?',
          criteria: ['Trivial', 'Ordinary', { needs: 'a plan' }],
        },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toMatchObject({
    answers: {
      effort: {
        type: 'score',
        score: 1,
        legend: { 0: 'Trivial', 1: 'Ordinary', 2: { needs: 'a plan' } },
        probabilities: { 0: 0, 1: 1, 2: 0 },
        confidence: 1,
      },
    },
  });
});

test('a number between two levels answers a score shared by them', async () => {
  // The API rounds each number on its own: beside the first probabilities
  // it gave 1.85, which they do not average to.
  const models = fake(on(judge, { severity: 1.86, spread: 0.94 }));

  const output = await models.decide(
    'acme/judge',
    {
      state: 'My card was charged twice.',
      questions: {
        severity: {
          type: 'score',
          instructions: 'How severe is this?',
          criteria: ['Cosmetic', 'Annoying', 'Blocks work'],
        },
        spread: {
          type: 'score',
          instructions: 'How far has this spread?',
          criteria: ['Cosmetic', 'Annoying', 'Blocks work', 'Outage'],
        },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toMatchObject({
    answers: {
      severity: {
        type: 'score',
        score: 1.86,
        probabilities: {
          0: 0,
          1: expect.closeTo(0.14, 2),
          2: expect.closeTo(0.86, 2),
        },
        confidence: expect.closeTo(0.79, 2),
      },
      spread: {
        type: 'score',
        score: 0.94,
        probabilities: {
          0: expect.closeTo(0.06, 2),
          1: expect.closeTo(0.94, 2),
          2: 0,
          3: 0,
        },
        confidence: expect.closeTo(0.94, 2),
      },
    },
  });
});

test('a score of one level is certain, as the API has it', async () => {
  const models = fake(on(judge, { severity: 0 }));

  const output = await models.decide(
    'acme/judge',
    {
      state: 'It is fine.',
      questions: {
        severity: {
          type: 'score',
          instructions: 'How severe is this?',
          criteria: ['Cosmetic'],
        },
      },
    },
    AbortSignal.any([]),
  );

  expect(output).toMatchObject({
    answers: {
      severity: { score: 0, probabilities: { 0: 1 }, confidence: 1 },
    },
  });
});

test('a score whose level the API would not take counts as not scripted', async () => {
  const models = fake(on(judge, { effort: 0 }));

  const asked = models.decide(
    'acme/judge',
    {
      state: 'Why does this deadlock?',
      questions: {
        effort: {
          type: 'score',
          instructions: 'How hard is this?',
          criteria: [1, 2],
        },
      },
    },
    AbortSignal.any([]),
  );

  await expect(asked).rejects.toThrow(Unscripted);
});

test('one reply answers only the questions a call asks', async () => {
  const models = fake(on(judge, { software: 0.97, small: 0.9 }));

  const first = await models.decide(
    'acme/judge',
    {
      state: 'Which files did we touch?',
      questions: {
        software: { type: 'noul', instructions: 'Is this about software?' },
      },
    },
    AbortSignal.any([]),
  );
  const second = await models.decide(
    'acme/judge',
    {
      state: 'Which files did we touch?',
      questions: {
        small: { type: 'noul', instructions: 'Can a small model fill it?' },
      },
    },
    AbortSignal.any([]),
  );

  expect(first).toMatchObject({
    answers: { software: { type: 'noul', noul: 0.97 } },
  });
  expect(second).toMatchObject({
    answers: { small: { type: 'noul', noul: 0.9 } },
  });
});

test('an SDK error fails the call with that error', async () => {
  const models = fake(on(judge, new Overloaded('busy')));

  const asked = models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        software: { type: 'noul', instructions: 'Is this about software?' },
      },
    },
    AbortSignal.any([]),
  );

  await expect(asked).rejects.toBeInstanceOf(Overloaded);
});

test('a question the reply does not name is not scripted', async () => {
  const models = fake(on(judge, { software: 0.97 }));

  const asked = models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        urgent: { type: 'noul', instructions: 'Is it urgent?' },
      },
    },
    AbortSignal.any([]),
  );

  await expect(asked).rejects.toBeInstanceOf(Unscripted);
  await expect(asked).rejects.toThrow(
    'No reply the decision API could give was scripted for the question urgent asked of acme/judge',
  );
});

test('a reply of the wrong kind for its question is not scripted', async () => {
  const models = fake(
    on(judge, { software: { yes: 1 } }),
    on(judge, { tier: 0.5 }),
    on(judge, { tier: { quick: 0.5, slow: 0.5 } }),
    on(judge, { effort: 3 }),
  );

  const options = models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        software: { type: 'noul', instructions: 'Is this about software?' },
      },
    },
    AbortSignal.any([]),
  );
  const number = models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        tier: {
          type: 'choice',
          instructions: 'How much reasoning does this need?',
          criteria: { quick: null, deep: null },
        },
      },
    },
    AbortSignal.any([]),
  );
  const unasked = models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        tier: {
          type: 'choice',
          instructions: 'How much reasoning does this need?',
          criteria: { quick: null, deep: null },
        },
      },
    },
    AbortSignal.any([]),
  );
  const pastTheLevels = models.decide(
    'acme/judge',
    {
      state: 'What does git stash do?',
      questions: {
        effort: {
          type: 'score',
          instructions: 'How hard is this?',
          criteria: ['Trivial', 'Ordinary'],
        },
      },
    },
    AbortSignal.any([]),
  );

  await expect(options).rejects.toBeInstanceOf(Unscripted);
  await expect(number).rejects.toBeInstanceOf(Unscripted);
  await expect(unasked).rejects.toBeInstanceOf(Unscripted);
  await expect(pastTheLevels).rejects.toBeInstanceOf(Unscripted);
});

test('a reply the decision API could not give is not scripted', async () => {
  const asked = (reply: DecisionReply) =>
    fake(on(judge, reply)).decide(
      'acme/judge',
      {
        state: 'What does git stash do?',
        questions: {
          software: { type: 'noul', instructions: 'Is this about software?' },
          tier: {
            type: 'choice',
            instructions: 'How much reasoning does this need?',
            criteria: { quick: null, deep: null },
          },
          effort: {
            type: 'score',
            instructions: 'How hard is this?',
            criteria: ['Trivial', 'Ordinary'],
          },
        },
      },
      AbortSignal.any([]),
    );
  const tier = { quick: 0.2, deep: 0.8 };

  await expect(asked({ software: 1, tier, effort: 1 })).resolves.toMatchObject({
    answers: { software: { noul: 1 } },
  });
  await expect(asked({ software: 1.5, tier, effort: 1 })).rejects.toThrow(
    'for the question software asked of acme/judge',
  );
  await expect(
    asked({ software: -0.1, tier, effort: 1 }),
  ).rejects.toBeInstanceOf(Unscripted);
  await expect(
    asked({ software: Number.NaN, tier, effort: 1 }),
  ).rejects.toBeInstanceOf(Unscripted);
  await expect(
    asked({ software: 0.5, tier: { quick: 1.2 }, effort: 1 }),
  ).rejects.toThrow('for the question tier asked of acme/judge');
  await expect(asked({ software: 0.5, tier: {}, effort: 1 })).rejects.toThrow(
    'for the question tier asked of acme/judge',
  );
  await expect(asked({ software: 0.5, tier, effort: 1.5 })).rejects.toThrow(
    'for the question effort asked of acme/judge',
  );
  await expect(asked({ software: 0.5, tier, effort: -0.5 })).rejects.toThrow(
    'for the question effort asked of acme/judge',
  );
  await expect(
    asked({ software: 0.5, tier, effort: Number.NaN }),
  ).rejects.toThrow('for the question effort asked of acme/judge');
});

test('a decision reply of another type is refused by the compiler', () => {
  // @ts-expect-error a decision model gives probabilities, not text
  on(judge, 'quick reply');
  // @ts-expect-error a question is answered with numbers
  on(judge, { software: 'yes' });
  // @ts-expect-error an option is given a probability
  on(judge, { tier: { quick: true } });
  // @ts-expect-error a decision reply is not worked out from a prompt
  on(judge, () => ({ software: 0.97 }));
  // @ts-expect-error an error that is not an SDK error has no facts to send
  on(judge, new Error('busy'));
});
