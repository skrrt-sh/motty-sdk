import { expect, test } from 'bun:test';
import {
  answer,
  type ChatRequest,
  InvalidOutput,
  type Motty,
  motty,
  UnknownModel,
} from '@mottyjs/core';
import {
  type EventStream,
  type Host,
  type Json,
  mark,
  type RequestRecord,
} from '@mottyjs/core/host';
import * as entry from '../src/index.ts';
import { decision, noul } from '../src/index.ts';

function ask(): ChatRequest {
  return {
    id: 'req_1',
    model: 'motty/coder',
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers: new Headers(),
  };
}

async function* unserved(): EventStream {
  yield {
    type: 'error',
    error: { code: 'unknown_model', status: 404, message: 'No model' },
  };
}

async function ran(served: Motty, rest: Partial<Host> = {}) {
  const record = Promise.withResolvers<RequestRecord>();
  const events = await Array.fromAsync(
    served[mark].run(ask(), {
      models: unserved,
      signal: new AbortController().signal,
      record: record.resolve,
      ...rest,
    }),
  );
  return { events, record: await record.promise };
}

// Answers every call with the same output and lists what it was asked.
function deciding(output: Json) {
  const asked: unknown[][] = [];
  const decisions: NonNullable<Host['decisions']> = async (...given) => {
    asked.push(given);
    return output;
  };
  return { decisions, asked };
}

test('decide sends the name beside the state and the questions, under a signal, and resolves with the answers', async () => {
  const { decisions, asked } = deciding({
    model: 'jev-2',
    answers: { software: { type: 'noul', noul: 0.97 } },
    usage: { input_tokens: 41, output_tokens: 1 },
  });
  const decided: unknown[] = [];

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      const { software } = await decision('typesafe/jev-latest').decide(
        'What does git stash do?',
        { software: noul({ instructions: 'Is this about software?' }) },
      );
      decided.push(software.noul);
      return answer('Hi');
    }),
    { decisions },
  );

  expect(asked).toEqual([
    [
      'typesafe/jev-latest',
      {
        state: 'What does git stash do?',
        questions: {
          software: { type: 'noul', instructions: 'Is this about software?' },
        },
      },
      expect.any(AbortSignal),
    ],
  ]);
  expect(decided).toEqual([0.97]);
});

test('a cost reported with the usage of a decision call is counted with it', async () => {
  const { record } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      const jev = decision('typesafe/jev');
      const questions = { software: noul({ instructions: 'Software?' }) };
      await jev.decide('What does git stash do?', questions);
      await jev.decide('And git pop?', questions);
      return answer('Hi');
    }),
    deciding({
      answers: { software: { type: 'noul', noul: 0.97 } },
      usage: { input_tokens: 41, output_tokens: 1, cost: 0.002 },
    }),
  );

  expect(record.calls).toMatchObject([
    { input: 41, output: 1, cost: 0.002 },
    { input: 41, output: 1, cost: 0.002 },
  ]);
  expect(record.usage).toEqual({ input: 82, output: 2, cost: 0.004 });
});

test('a decision with no question is refused before any call is made or counted', async () => {
  const { decisions, asked } = deciding({ answers: {} });
  const caught: unknown[] = [];

  const { record } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      await decision('typesafe/jev')
        .decide('What does git stash do?', {})
        .catch((thrown: unknown) => {
          caught.push(thrown);
        });
      return answer('Hi');
    }),
    { decisions, limits: { calls: 0 } },
  );

  expect(caught).toEqual([
    new Error('A decision has at least one question, and this one has 0'),
  ]);
  expect(asked).toEqual([]);
  expect(record.calls).toEqual([]);
});

test('a host with no decision call fails only that call, with UnknownModel, and the motty goes on', async () => {
  const caught: unknown[] = [];

  const { events, record } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      await decision('typesafe/jev')
        .decide('What does git stash do?', {
          software: noul({ instructions: 'Software?' }),
        })
        .catch((thrown: unknown) => {
          caught.push(thrown);
        });
      return answer('Hi');
    }),
  );

  expect(caught).toEqual([expect.any(UnknownModel)]);
  expect(events[0]).toEqual({ type: 'text', text: 'Hi' });
  expect(record.outcome).toBe('completed');
  expect(record.calls).toEqual([
    {
      model: 'typesafe/jev',
      code: 'unknown_model',
      message:
        'The host serves no decision model, so none is named typesafe/jev',
      time: { total: expect.any(Number) },
    },
  ]);
});

test('a decision model is a name and decide, nothing a chat model has', () => {
  const jev = decision('typesafe/jev-latest');

  expect(jev.name).toBe('typesafe/jev-latest');
  expect(Object.keys(jev)).toEqual(['name', 'decide']);
  expect(Object.isFrozen(jev)).toBe(true);
  // Never called: what the types refuse here would throw when run.
  () => {
    // @ts-expect-error
    jev.complete({ messages: [] });
    // @ts-expect-error
    jev({ messages: [] });
    // @ts-expect-error
    jev.name = 'typesafe/jev-2';
  };
});

test('an output with no answers is InvalidOutput, and its usage is still counted', async () => {
  const caught: unknown[] = [];

  const { record } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      await decision('typesafe/jev')
        .decide('What does git stash do?', {
          software: noul({ instructions: 'Software?' }),
        })
        .catch((thrown: unknown) => {
          caught.push(thrown);
        });
      return answer('Hi');
    }),
    deciding({ model: 'jev', usage: { input_tokens: 7, output_tokens: 1 } }),
  );

  expect(caught).toEqual([expect.any(InvalidOutput)]);
  expect(caught).toEqual([
    expect.objectContaining({
      message: 'The decision model returned no answers',
    }),
  ]);
  expect(record.usage).toEqual({ input: 7, output: 1 });
});

test('the entry exports exactly the held values', () => {
  expect(Object.keys(entry).sort()).toEqual([
    'choice',
    'decision',
    'noul',
    'score',
  ]);
});

test('the entry exports exactly the held types', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(
    [
      ...[...text.matchAll(/export type \{([^}]*)\}/g)].flatMap(
        ([, names = '']) => names.split(',').map((name) => name.trim()),
      ),
      ...[...text.matchAll(/export type (\w+)/g)].map(([, name]) => name),
    ]
      .filter((name) => name !== '')
      .sort(),
  ).toEqual([
    'Answer',
    'AnswerTo',
    'Answers',
    'ChoiceAnswer',
    'ChoiceQuestion',
    'DecisionInput',
    'DecisionModel',
    'DecisionOutput',
    'NoulAnswer',
    'NoulQuestion',
    'Question',
    'Questions',
    'ScoreAnswer',
    'ScoreQuestion',
    'State',
    'Structured',
  ]);
});
