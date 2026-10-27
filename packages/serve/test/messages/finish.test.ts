import { expect, test } from 'bun:test';
import {
  counted,
  countsOf,
  countsTo,
  merged,
  reasonOf,
  stopOf,
} from '../../src/messages/finish.ts';
import { dict, parsed } from '../../src/wire/json.ts';

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

test('a count named as the prototype is a field, and no count is read through it', () => {
  const counts = merged(
    { input_tokens: 25 },
    dict(parsed('{"__proto__":{"output_tokens":999}}')),
  );

  expect(Object.keys(counts)).toEqual(['input_tokens', '__proto__']);
  expect(countsOf(counts)).toEqual({ input: 25 });
});

test('what usage holds beside the counts read here is kept apart, and no count is read twice', () => {
  const wire = {
    input_tokens: 25,
    output_tokens: 40,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 100,
    output_tokens_details: { thinking_tokens: 12 },
    cost: 0.0042,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 100,
    },
    server_tool_use: { web_search_requests: 1 },
    service_tier: 'standard',
    inference_geo: 'us',
    future_count: 3,
  };
  expect(counted(wire).rest).toEqual({
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 100,
    },
    server_tool_use: { web_search_requests: 1 },
    service_tier: 'standard',
    inference_geo: 'us',
    future_count: 3,
  });
  expect(countsOf(wire)).toEqual({
    input: 2125,
    output: 40,
    cached: 2000,
    cacheWrite: 100,
    reasoning: 12,
    cost: 0.0042,
  });
  expect(counted({ input_tokens: 25, output_tokens: 40 }).rest).toEqual({});
});

test('what the thinking details hold beside the count read here goes back beside it', () => {
  const wire = {
    input_tokens: 25,
    output_tokens: 40,
    output_tokens_details: { thinking_tokens: 2, future_tokens: 9 },
  };

  expect(counted(wire).rest).toEqual({
    output_tokens_details: { future_tokens: 9 },
  });
  expect(countsTo(countsOf(wire), counted(wire).rest)).toEqual(wire);
  expect(countsTo({ input: 25, output: 40 }, counted(wire).rest)).toEqual({
    input_tokens: 25,
    output_tokens: 40,
    output_tokens_details: { future_tokens: 9 },
  });
});

test('a count in a carried usage is never written in place of the neutral one', () => {
  expect(
    countsTo(
      { input: 25, output: 40 },
      {
        cache_read_input_tokens: 999,
        output_tokens_details: { thinking_tokens: 7 },
        cost: 5,
        service_tier: 'standard',
      },
    ),
  ).toEqual({ input_tokens: 25, output_tokens: 40, service_tier: 'standard' });
});
