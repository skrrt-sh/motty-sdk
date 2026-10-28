import { expect, test } from 'bun:test';
import {
  usageField,
  usageRead,
  usageWritten,
} from '../../src/chat-completions/usage.ts';

test('the cost a router reports is read, and written back under its name', () => {
  expect(
    usageRead({
      prompt_tokens: 15,
      completion_tokens: 2,
      total_tokens: 17,
      cost: 0.0000023,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.0000023 },
    }),
  ).toEqual({ input: 15, output: 2, cost: 0.0000023 });
  expect(usageWritten({ input: 15, output: 2, cost: 0.0000023 })).toEqual({
    prompt_tokens: 15,
    completion_tokens: 2,
    total_tokens: 17,
    cost: 0.0000023,
  });
});

test('a count the upstream did not report is absent, a zero is a zero', () => {
  expect(
    usageRead({
      prompt_tokens: 7,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    }),
  ).toEqual({ input: 7, output: 0, cached: 0 });
  expect(usageRead({ prompt_tokens: '7', completion_tokens: null })).toEqual(
    {},
  );
});

test('cached tokens at the top of usage are read only where the dialect says a model sends them so', () => {
  expect(usageRead({ prompt_tokens: 3417, cached_tokens: 3327 }, true)).toEqual(
    { input: 3417, cached: 3327 },
  );
  expect(usageRead({ prompt_tokens: 3417, cached_tokens: 3327 })).toEqual({
    input: 3417,
  });
});

test('cached tokens in the details outrank a count at the top of usage', () => {
  expect(
    usageRead(
      {
        prompt_tokens: 3417,
        cached_tokens: 9,
        prompt_tokens_details: { cached_tokens: 3327 },
      },
      true,
    ),
  ).toEqual({ input: 3417, cached: 3327 });
});

test('DeepSeek`s count of hits is read where the details have none, and outranks one at the top', () => {
  expect(
    usageRead({
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    }),
  ).toEqual({ input: 1000, cached: 800 });
  expect(
    usageRead(
      {
        prompt_tokens: 1000,
        cached_tokens: 9,
        prompt_cache_hit_tokens: 800,
        prompt_tokens_details: { cached_tokens: 700 },
      },
      true,
    ),
  ).toEqual({ input: 1000, cached: 700 });
  expect(
    usageRead(
      { prompt_tokens: 1000, cached_tokens: 9, prompt_cache_hit_tokens: 800 },
      true,
    ),
  ).toEqual({ input: 1000, cached: 800 });
});

test('a cache write is read under either name an upstream gives it', () => {
  expect(
    usageRead({
      prompt_tokens: 1000,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_creation_input_tokens: 900,
      },
    }),
  ).toEqual({ input: 1000, cached: 0, cacheWrite: 900 });
  expect(
    usageRead({
      prompt_tokens: 1000,
      prompt_tokens_details: { cache_write_tokens: 256 },
    }),
  ).toEqual({ input: 1000, cacheWrite: 256 });
});

test('usage is written without a breakdown nobody reported', () => {
  expect(usageWritten({ output: 3 })).toEqual({
    prompt_tokens: 0,
    completion_tokens: 3,
    total_tokens: 3,
  });
  expect(usageWritten({ input: 5, output: 1, cached: 0 })).toEqual({
    prompt_tokens: 5,
    completion_tokens: 1,
    total_tokens: 6,
    prompt_tokens_details: { cached_tokens: 0 },
  });
});

test('usage written and read again is the same usage', () => {
  const usage = { input: 9, output: 4, cached: 2, cacheWrite: 1, reasoning: 3 };

  expect(usageRead(usageWritten(usage))).toEqual(usage);
});

test('usage of which nothing was reported is left out, and a reported zero is written', () => {
  expect(usageField(undefined)).toEqual({});
  expect(usageField({})).toEqual({});
  expect(usageField({ output: 0 })).toEqual({
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
});
