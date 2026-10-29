import { expect, test } from 'bun:test';
import { leaving } from '../../src/wire/fieldless.ts';
import {
  effortless,
  reasons,
  sampling,
  unsampled,
} from '../../src/wire/taken.ts';

test('with no rule every sampling setting is sent as given', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      undefined,
      {
        temperature: 3,
        topP: 0.4,
        topK: 40,
        presencePenalty: 0.5,
        frequencyPenalty: -1,
      },
      {},
    ),
  ).toEqual({
    temperature: 3,
    top_p: 0.4,
    top_k: 40,
    presence_penalty: 0.5,
    frequency_penalty: -1,
  });
  expect(left.leftOut()).toEqual([]);
});

test('a setting inside the range the model takes is sent as given', () => {
  const left = leaving('chat');

  expect(
    sampling(
      left,
      {
        temperature: [0, 2],
        topP: [0, 1],
        topK: true,
        presencePenalty: true,
        frequencyPenalty: true,
        together: true,
        effort: true,
      },
      { temperature: 0, topP: 1, topK: 40, presencePenalty: 0.5 },
      {},
    ),
  ).toEqual({ temperature: 0, top_p: 1, top_k: 40, presence_penalty: 0.5 });
  expect(left.leftOut()).toEqual([]);
});

test('a temperature above the range is sent as the highest inside it, not rescaled, and reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        presencePenalty: true,
        frequencyPenalty: true,
        together: true,
        effort: true,
      },
      { temperature: 1.5 },
      {},
    ),
  ).toEqual({ temperature: 1 });
  expect(left.leftOut()).toEqual([
    {
      setting: 'temperature.range',
      detail:
        "Anthropic Messages has no field for a temperature outside the model's range, sent as the nearest inside",
    },
  ]);
});

test('top-p below the range is sent as the lowest inside it and reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: [0.95, 1],
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { topP: 0.5 },
      {},
    ),
  ).toEqual({ top_p: 0.95 });
  expect(left.leftOut()).toEqual([
    {
      setting: 'topP.range',
      detail:
        "Anthropic Messages has no field for top-p sampling outside the model's range, sent as the nearest inside",
    },
  ]);
});

test('the one value a model allows is neither sent nor reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: 0.99,
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { temperature: 1, topP: 0.99 },
      {},
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([]);
});

test('any other value than the one a model allows is left out and reported', () => {
  const left = leaving('responses');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: 1,
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: true,
        effort: true,
      },
      { temperature: 0, topP: 0.9 },
      {},
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([
    {
      setting: 'temperature.model',
      detail:
        'The Responses API has no field for a temperature the model does not take',
    },
    {
      setting: 'topP.model',
      detail:
        'The Responses API has no field for top-p sampling the model does not take',
    },
  ]);
});

test('where the two may not go together the temperature goes and top-p is left out and reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { temperature: 0.5, topP: 0.9 },
      {},
    ),
  ).toEqual({ temperature: 0.5 });
  expect(left.leftOut()).toEqual([
    {
      setting: 'topP.temperature',
      detail:
        'Anthropic Messages has no field for top-p sampling beside a temperature, which the model does not take together',
    },
  ]);
});

test('top-p goes where the temperature beside it is not sent', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: [0.95, 1],
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { temperature: 1, topP: 0.97 },
      {},
    ),
  ).toEqual({ top_p: 0.97 });
  expect(left.leftOut()).toEqual([]);
});

test('top-k the model does not take is left out and reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: 0.99,
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { topK: 40 },
      {},
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([
    {
      setting: 'topK.model',
      detail:
        'Anthropic Messages has no field for top-k sampling the model does not take',
    },
  ]);
});

test('a penalty the model does not take is left out and reported, and one of zero asks for nothing', () => {
  const left = leaving('chat');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: 1,
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: true,
        effort: true,
      },
      { presencePenalty: 0.5, frequencyPenalty: 0 },
      {},
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([
    {
      setting: 'presencePenalty.model',
      detail:
        'Chat Completions has no field for a presence penalty the model does not take',
    },
  ]);
});

test('a setting said in the API`s own words is outside the rule: the neutral one is not written and is reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: 1,
        topP: 0.99,
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { temperature: 0.5, topK: 40 },
      { temperature: 0.2, top_k: 5 },
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([
    {
      setting: 'sampling.own',
      detail:
        "Anthropic Messages has no field for a sampling setting the request also states in the API's own words",
    },
  ]);
});

test('own words beside no neutral setting are no report', () => {
  const left = leaving('chat');

  expect(sampling(left, undefined, {}, { temperature: 0.2 })).toEqual({});
  expect(left.leftOut()).toEqual([]);
});

test('an effort the model does not take is left out and reported, and the rest of the reasoning stays', () => {
  const left = leaving('messages');

  expect(
    effortless(
      left,
      {
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: false,
      },
      { effort: 'high', budgetTokens: 2000 },
    ),
  ).toEqual({ budgetTokens: 2000 });
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning.model',
      detail:
        'Anthropic Messages has no field for a reasoning effort the model does not take',
    },
  ]);
});

test('reasoning that was an effort alone is no reasoning once the effort is left out', () => {
  expect(
    effortless(
      leaving('chat'),
      {
        temperature: [0, 2],
        topP: [0, 1],
        topK: false,
        presencePenalty: true,
        frequencyPenalty: true,
        together: true,
        effort: false,
      },
      { effort: 'low' },
    ),
  ).toBeUndefined();
});

test('an effort the model takes, and one under no rule, stay', () => {
  const left = leaving('chat');

  expect(
    effortless(
      left,
      {
        temperature: 1,
        topP: 1,
        topK: false,
        presencePenalty: false,
        frequencyPenalty: false,
        together: true,
        effort: true,
      },
      { effort: 'high' },
    ),
  ).toEqual({ effort: 'high' });
  expect(effortless(left, undefined, { effort: 'high' })).toEqual({
    effort: 'high',
  });
  expect(left.leftOut()).toEqual([]);
});

test('reasoning with no effort is not reported to a model that takes none', () => {
  const left = leaving('chat');

  expect(
    effortless(
      left,
      {
        temperature: [0, 2],
        topP: [0, 1],
        topK: false,
        presencePenalty: true,
        frequencyPenalty: true,
        together: true,
        effort: false,
      },
      { exclude: true },
    ),
  ).toEqual({ exclude: true });
  expect(left.leftOut()).toEqual([]);
});

test('an order not to reason says the request does not reason', () => {
  expect(reasons('none')).toBe(false);
});

test('an effort or a budget says the request reasons', () => {
  expect(reasons('low')).toBe(true);
  expect(reasons(undefined, 2000)).toBe(true);
});

test('neither an effort nor a budget says nothing of reasoning', () => {
  expect(reasons(undefined)).toBeUndefined();
});

test('where the two may not go together a temperature said in own words stands, and the neutral top-p is left out and reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { topP: 0.9 },
      { temperature: 0.5 },
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([
    {
      setting: 'topP.temperature',
      detail:
        'Anthropic Messages has no field for top-p sampling beside a temperature, which the model does not take together',
    },
  ]);
});

test('where the two may not go together top-p said in own words stands, and the neutral temperature is left out and reported', () => {
  const left = leaving('messages');

  expect(
    sampling(
      left,
      {
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        presencePenalty: false,
        frequencyPenalty: false,
        together: false,
        effort: true,
      },
      { temperature: 0.5 },
      { top_p: 0.9 },
    ),
  ).toEqual({});
  expect(left.leftOut()).toEqual([
    {
      setting: 'temperature.topP',
      detail:
        'Anthropic Messages has no field for a temperature beside top-p sampling, which the model does not take together',
    },
  ]);
});

test('where the two go together own words for one leave the neutral other as given', () => {
  const left = leaving('chat');

  expect(
    sampling(
      left,
      {
        temperature: [0, 2],
        topP: [0, 1],
        topK: false,
        presencePenalty: true,
        frequencyPenalty: true,
        together: true,
        effort: true,
      },
      { topP: 0.9 },
      { temperature: 0.5 },
    ),
  ).toEqual({ top_p: 0.9 });
  expect(left.leftOut()).toEqual([]);
});

test('a connection`s sampling field goes where the request states the option of the same meaning, and no other does', () => {
  expect(
    unsampled(
      {
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        presence_penalty: 0.1,
        frequency_penalty: 0.1,
        seed: 7,
      },
      { temperature: 0.7, topK: 20, frequencyPenalty: 0 },
    ),
  ).toEqual({ top_p: 0.9, presence_penalty: 0.1, seed: 7 });
});
