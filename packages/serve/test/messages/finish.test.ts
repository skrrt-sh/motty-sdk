import { expect, test } from 'bun:test';
import {
  countsOf,
  countsTo,
  merged,
  reasonOf,
  stopOf,
} from '../../src/messages/finish.ts';

test('every stop reason has a finish reason, and comes back as itself', () => {
  for (const [stop, reason] of [
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['tool_use', 'tool_calls'],
    ['pause_turn', 'pause'],
    ['refusal', 'content_filter'],
  ] as const) {
    expect(reasonOf(stop)).toBe(reason);
    expect(stopOf({ type: 'finish', reason, rawReason: stop })).toBe(stop);
  }
  expect(reasonOf('something_new')).toBe('other');
  expect(reasonOf(null)).toBe('other');
});

test('a finish of another family is written by its neutral reason', () => {
  for (const [reason, stop] of [
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['pause', 'pause_turn'],
    ['content_filter', 'refusal'],
    ['other', 'end_turn'],
  ] as const) {
    expect(stopOf({ type: 'finish', reason })).toBe(stop);
  }
  expect(stopOf({ type: 'finish', reason: 'stop', rawReason: 'stop' })).toBe(
    'end_turn',
  );
  expect(
    stopOf({ type: 'finish', reason: 'length', rawReason: 'end_turn' }),
  ).toBe('max_tokens');
});

test('neutral input counts the cached and cache-writing tokens too', () => {
  expect(
    countsOf({
      input_tokens: 21,
      cache_creation_input_tokens: 188086,
      cache_read_input_tokens: 1200,
      output_tokens: 393,
    }),
  ).toEqual({ input: 189307, output: 393, cached: 1200, cacheWrite: 188086 });
});

test('a count the upstream did not report is absent', () => {
  expect(countsOf({ output_tokens: 5 })).toEqual({ output: 5 });
  expect(countsOf({})).toEqual({});
});

test('usage is written with the cache counts beside the input', () => {
  expect(
    countsTo({ input: 189307, output: 393, cached: 1200, cacheWrite: 188086 }),
  ).toEqual({
    input_tokens: 21,
    cache_creation_input_tokens: 188086,
    cache_read_input_tokens: 1200,
    output_tokens: 393,
  });
  expect(countsTo({ input: 10, output: 2 })).toEqual({
    input_tokens: 10,
    output_tokens: 2,
  });
  expect(countsTo(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
});

test('the cost a router reports is read, and written back under its name', () => {
  expect(
    countsOf({
      input_tokens: 20,
      output_tokens: 5,
      cost: 0.0000045,
      is_byok: false,
      cost_details: { upstream_inference_cost: 0.0000045 },
    }),
  ).toEqual({ input: 20, output: 5, cost: 0.0000045 });
  expect(countsTo({ input: 20, output: 5, cost: 0.0000045 })).toEqual({
    input_tokens: 20,
    output_tokens: 5,
    cost: 0.0000045,
  });
});

test('a cost nobody reported is neither read nor written', () => {
  expect(countsOf({ output_tokens: 5, cost: null })).toEqual({ output: 5 });
  expect(countsTo({ input: 20, output: 5 })).not.toHaveProperty('cost');
});

test('a later value replaces an earlier one and a null does not', () => {
  expect(
    merged(
      { input_tokens: 25, output_tokens: 1, stop_reason: 'tool_use' },
      { input_tokens: null, output_tokens: 15, stop_reason: null },
    ),
  ).toEqual({ input_tokens: 25, output_tokens: 15, stop_reason: 'tool_use' });
});

test('the tokens spent thinking are the reasoning count, both ways', () => {
  expect(
    countsOf({
      input_tokens: 10,
      output_tokens: 503,
      output_tokens_details: { thinking_tokens: 480 },
    }),
  ).toEqual({ input: 10, output: 503, reasoning: 480 });
  expect(countsTo({ input: 10, output: 503, reasoning: 480 })).toEqual({
    input_tokens: 10,
    output_tokens: 503,
    output_tokens_details: { thinking_tokens: 480 },
  });
});
