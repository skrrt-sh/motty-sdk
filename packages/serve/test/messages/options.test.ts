import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import { optionsOf, optionsTo } from '../../src/messages/options.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('the limit, stop sequences and sampling are neutral options', () => {
  expect(
    optionsOf({
      max_tokens: 1024,
      stop_sequences: ['\n\nHuman:', 'END'],
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
    }),
  ).toEqual({
    options: {
      maxTokens: 1024,
      stop: ['\n\nHuman:', 'END'],
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
    },
    shown: false,
  });
});

test('metadata names the user and is kept as a hint', () => {
  const { options } = optionsOf({
    max_tokens: 64,
    metadata: { user_id: 'user-13803d75' },
  });
  expect(options).toEqual({
    maxTokens: 64,
    user: 'user-13803d75',
    hints: { anthropic: { metadata: { user_id: 'user-13803d75' } } },
  });
});

test('a JSON schema format is the requested output', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  };
  expect(
    optionsOf({
      max_tokens: 64,
      output_config: { format: { type: 'json_schema', schema } },
    }).output,
  ).toEqual({ schema, strict: true });
  expect(
    optionsOf({
      max_tokens: 64,
      output_format: { type: 'json_schema', schema },
    }).output,
  ).toEqual({ schema, strict: true });
});

test('thinking and effort become reasoning, and say if progress shows', () => {
  expect(
    optionsOf({
      max_tokens: 16000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    }),
  ).toEqual({
    options: {
      maxTokens: 16000,
      reasoning: { effort: 'high' },
      hints: {
        anthropic: { thinking: { type: 'adaptive', display: 'summarized' } },
      },
    },
    shown: true,
  });
});

test('what only this family reads is split by whether it may be dropped', () => {
  const { options } = optionsOf({
    max_tokens: 64,
    cache_control: { type: 'ephemeral' },
    service_tier: 'auto',
    container: 'container_011C',
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    output_config: { task_budget: { type: 'tokens', total: 20000 } },
    thinking: { type: 'between_tools' },
  });
  expect(options).toEqual({
    maxTokens: 64,
    provider: {
      anthropic: {
        container: 'container_011C',
        context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
        thinking: { type: 'between_tools' },
        output_config: { task_budget: { type: 'tokens', total: 20000 } },
      },
    },
    hints: {
      anthropic: {
        cache_control: { type: 'ephemeral' },
        service_tier: 'auto',
      },
    },
  });
});

test('malformed settings are rejected', () => {
  expect(() => optionsOf({})).toThrow(InvalidRequest);
  expect(() => optionsOf({ max_tokens: '1024' })).toThrow(InvalidRequest);
  expect(() => optionsOf({ max_tokens: 1, temperature: 'hot' })).toThrow(
    InvalidRequest,
  );
  expect(() => optionsOf({ max_tokens: 1, stop_sequences: 'END' })).toThrow(
    InvalidRequest,
  );
  expect(() => optionsOf({ max_tokens: 1, stop_sequences: [1] })).toThrow(
    InvalidRequest,
  );
  expect(() => optionsOf({ max_tokens: 1, output_config: 'json' })).toThrow(
    InvalidRequest,
  );
  expect(() =>
    optionsOf({
      max_tokens: 1,
      output_config: { format: { type: 'json_object' } },
    }),
  ).toThrow(InvalidRequest);
});

test("neutral options are written as this API's fields", () => {
  expect(
    optionsTo(
      leaving('messages'),
      {
        maxTokens: 512,
        stop: ['END'],
        temperature: 0,
        topP: 0.5,
        topK: 5,
        user: 'user-1',
        toolChoice: 'required',
        reasoning: { effort: 'minimal' },
        seed: 7,
        frequencyPenalty: 0,
      },
      { schema: { type: 'object' }, name: 'answer', strict: true },
    ),
  ).toEqual({
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    },
    fields: {
      max_tokens: 512,
      stop_sequences: ['END'],
      temperature: 0,
      top_p: 0.5,
      top_k: 5,
      metadata: { user_id: 'user-1' },
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
      tool_choice: { type: 'any' },
    },
  });
});

test('only this wire`s own headers are sent and a foreign hint dropped', () => {
  expect(
    optionsTo(
      leaving('messages'),
      {
        hints: {
          anthropic: { service_tier: 'auto' },
          'openai.chat': { store: true },
        },
      },
      undefined,
    ),
  ).toEqual({
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    },
    fields: { max_tokens: 64000, service_tier: 'auto' },
  });
});

test('a header that says what the body may hold is a hint, and is sent back as a header', () => {
  const { options } = optionsOf(
    { max_tokens: 64 },
    { 'anthropic-beta': 'context-management-2025-06-27' },
  );
  expect(options).toEqual({
    maxTokens: 64,
    hints: { anthropic: { 'anthropic-beta': 'context-management-2025-06-27' } },
  });
  expect(optionsTo(leaving('messages'), options, undefined)).toEqual({
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'context-management-2025-06-27',
    },
    fields: { max_tokens: 64 },
  });
});

test('such a header said as an option replaces the hint whole', () => {
  expect(
    optionsTo(
      leaving('messages'),
      {
        hints: { anthropic: { 'anthropic-beta': 'effort-2025-11-24' } },
        provider: { anthropic: { 'anthropic-beta': 'files-api-2025-04-14' } },
      },
      undefined,
    ).headers,
  ).toEqual({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'files-api-2025-04-14',
  });
});

test('what this wire cannot say fails the call', () => {
  expect(() => optionsTo(leaving('messages'), {}, {})).toThrow(Unsupported);
  expect(() =>
    optionsTo(
      leaving('messages'),
      { provider: { 'openai.chat': { logit_bias: {} } } },
      undefined,
    ),
  ).toThrow(Unsupported);
});

test('sampling is sent with thinking on or off: which model takes it is the upstream to say', () => {
  expect(
    optionsTo(
      leaving('messages'),
      { temperature: 0.2, topP: 0.5, topK: 5, reasoning: { effort: 'high' } },
      undefined,
    ).fields,
  ).toMatchObject({ temperature: 0.2, top_p: 0.5, top_k: 5 });
  expect(
    optionsTo(
      leaving('messages'),
      {
        temperature: 0.2,
        topP: 0.5,
        topK: 5,
        reasoning: { budgetTokens: 2048 },
      },
      undefined,
    ).fields,
  ).toMatchObject({
    temperature: 0.2,
    top_p: 0.5,
    top_k: 5,
    thinking: { type: 'enabled', budget_tokens: 2048 },
  });
  expect(
    optionsTo(
      leaving('messages'),
      {
        temperature: 0.2,
        reasoning: {},
        hints: { anthropic: { thinking: { type: 'adaptive' } } },
      },
      undefined,
    ).fields,
  ).toMatchObject({ temperature: 0.2, thinking: { type: 'adaptive' } });
});

test('an effort in the author`s own words wins over the neutral one, which is reported', () => {
  const left = leaving('messages');
  expect(
    optionsTo(
      left,
      {
        reasoning: { effort: 'high' },
        provider: { anthropic: { output_config: { effort: 'max' } } },
      },
      undefined,
    ).fields,
  ).toEqual({
    max_tokens: 64000,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'max' },
  });
  expect(left.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.own',
  ]);
});

test('a penalty is left out and reported', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { presencePenalty: 0.5, frequencyPenalty: -1 },
    undefined,
  );

  expect(fields).toEqual({ max_tokens: 64000 });
  expect(left.leftOut()).toEqual([
    {
      setting: 'presencePenalty',
      detail: 'Anthropic Messages has no field for a presence penalty',
    },
    {
      setting: 'frequencyPenalty',
      detail: 'Anthropic Messages has no field for a frequency penalty',
    },
  ]);
});

test('an options map with an entry for each family is sent this one`s own', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    {
      provider: {
        'openai.chat': { logit_bias: { '50256': -100 } },
        anthropic: { container: 'c_1' },
      },
    },
    undefined,
  );

  expect(fields).toEqual({ container: 'c_1', max_tokens: 64000 });
  expect(left.leftOut()).toEqual([]);
});

test('sampling the model does not take is left out and reported', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { temperature: 0.2, topP: 0.99, topK: 40 },
    undefined,
    {},
    () => ({
      temperature: 1,
      topP: 0.99,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    }),
  );

  expect(fields).toEqual({ max_tokens: 64000 });
  expect(left.leftOut().map(({ setting }) => setting)).toEqual([
    'temperature.model',
    'topK.model',
  ]);
});

test('a temperature goes without the top-p the model does not take beside it', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { temperature: 0.2, topP: 0.9, topK: 40 },
    undefined,
    {},
    () => ({
      temperature: [0, 1],
      topP: [0, 1],
      topK: true,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    }),
  );

  expect(fields).toEqual({ max_tokens: 64000, temperature: 0.2, top_k: 40 });
  expect(left.leftOut().map(({ setting }) => setting)).toEqual([
    'topP.temperature',
  ]);
});

test('a sampling setting in the API`s own words is sent as said to a model the rule refuses it for', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { provider: { anthropic: { temperature: 0.2, top_k: 5 } } },
    undefined,
    {},
    () => ({
      temperature: 1,
      topP: 0.99,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    }),
  );

  expect(fields).toEqual({ max_tokens: 64000, temperature: 0.2, top_k: 5 });
  expect(left.leftOut()).toEqual([]);
});

test('an effort the model does not take is left out with the adaptive thinking it would turn on, and reported', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { reasoning: { effort: 'high' } },
    undefined,
    {},
    () => ({
      temperature: [0, 1],
      topP: [0, 1],
      topK: true,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: false,
    }),
  );

  expect(fields).toEqual({ max_tokens: 64000 });
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning.model',
      detail:
        'Anthropic Messages has no field for a reasoning effort the model does not take',
    },
  ]);
});

const budgeted = {
  temperature: [0, 1],
  topP: [0, 1],
  topK: true,
  presencePenalty: false,
  frequencyPenalty: false,
  together: false,
  adaptive: false,
} as const;

test('an effort goes with no thinking to a model that thinks only on a budget, and that is reported', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { reasoning: { effort: 'high' } },
    undefined,
    {},
    () => ({ ...budgeted, effort: true }),
  );

  expect(fields).toEqual({
    max_tokens: 64000,
    output_config: { effort: 'high' },
  });
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning.adaptive',
      detail:
        'Anthropic Messages has no field for thinking with no budget, which the model does not take',
    },
  ]);
});

test('a budget is manual thinking beside the effort on a model that thinks only on a budget', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { reasoning: { effort: 'high', budgetTokens: 2000 } },
    undefined,
    {},
    () => ({ ...budgeted, effort: true }),
  );

  expect(fields).toEqual({
    max_tokens: 64000,
    thinking: { type: 'enabled', budget_tokens: 2000, display: 'summarized' },
    output_config: { effort: 'high' },
  });
  expect(left.leftOut()).toEqual([]);
});

test.each([true, false])(
  'adaptive thinking a caller hinted is left out for a model that thinks only on a budget, effort taken %s',
  (effort) => {
    const left = leaving('messages');

    const { fields } = optionsTo(
      left,
      {
        reasoning: {},
        hints: { anthropic: { thinking: { type: 'adaptive' } } },
      },
      undefined,
      {},
      () => ({ ...budgeted, effort }),
    );

    expect(fields).toEqual({ max_tokens: 64000 });
    expect(left.leftOut().map(({ setting }) => setting)).toEqual([
      'reasoning.adaptive',
    ]);
  },
);

test('adaptive thinking in the API`s own words is sent as said to a model the rule refuses it for', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { provider: { anthropic: { thinking: { type: 'adaptive' } } } },
    undefined,
    {},
    () => ({ ...budgeted, effort: true }),
  );

  expect(fields).toEqual({ max_tokens: 64000, thinking: { type: 'adaptive' } });
  expect(left.leftOut()).toEqual([]);
});

test('a budget stays as manual thinking where the effort beside it is not taken', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { reasoning: { effort: 'high', budgetTokens: 2000 } },
    undefined,
    {},
    () => ({
      temperature: [0, 1],
      topP: [0, 1],
      topK: true,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: false,
    }),
  );

  expect(fields).toEqual({
    max_tokens: 64000,
    thinking: { type: 'enabled', budget_tokens: 2000, display: 'summarized' },
  });
  expect(left.leftOut().map(({ setting }) => setting)).toEqual([
    'reasoning.model',
  ]);
});

test('an effort in the API`s own words is sent as said to a model the rule refuses it for', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { provider: { anthropic: { output_config: { effort: 'low' } } } },
    undefined,
    {},
    () => ({
      temperature: [0, 1],
      topP: [0, 1],
      topK: true,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: false,
    }),
  );

  expect(fields).toEqual({
    max_tokens: 64000,
    output_config: { effort: 'low' },
  });
  expect(left.leftOut()).toEqual([]);
});

test('the rule is asked whether the model takes an effort, then whether the request thinks', () => {
  const said = (
    options: Parameters<typeof optionsTo>[1],
    defaults: Parameters<typeof optionsTo>[3] = {},
  ) => {
    const asked: (boolean | undefined)[] = [];
    optionsTo(leaving('messages'), options, undefined, defaults, (how) => {
      asked.push(how);
      return undefined;
    });
    return asked;
  };

  expect(said({})).toEqual([true, undefined]);
  expect(said({ reasoning: { budgetTokens: 2000 } })).toEqual([true, true]);
  expect(said({ reasoning: { effort: 'high' } })).toEqual([true, true]);
  expect(said({ reasoning: { effort: 'none' } })).toEqual([true, undefined]);
  expect(
    said({ provider: { anthropic: { thinking: { type: 'adaptive' } } } }),
  ).toEqual([true, true]);
  expect(
    said({ provider: { anthropic: { thinking: { type: 'disabled' } } } }),
  ).toEqual([true, false]);
  expect(
    said({}, { thinking: { type: 'enabled', budget_tokens: 4000 } }),
  ).toEqual([true, true]);
});

test('a request that thinks is held to what the model takes while thinking', () => {
  const left = leaving('messages');

  const { fields } = optionsTo(
    left,
    { temperature: 0.2, topP: 0.9, reasoning: { budgetTokens: 2000 } },
    undefined,
    {},
    (reasons) => ({
      temperature: reasons === true ? 1 : [0, 1],
      topP: reasons === true ? [0.95, 1] : [0, 1],
      topK: reasons !== true,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    }),
  );

  expect(fields).toMatchObject({ top_p: 0.95 });
  expect(fields).not.toHaveProperty('temperature');
  expect(left.leftOut().map(({ setting }) => setting)).toEqual([
    'temperature.model',
    'topP.range',
  ]);
});

test('the key two OpenAI APIs share is another family`s here: an option fails the call and a hint is dropped', () => {
  expect(() =>
    optionsTo(
      leaving('messages'),
      { provider: { openai: { service_tier: 'flex' } } },
      undefined,
    ),
  ).toThrow('Anthropic Messages cannot carry options of openai');
  expect(
    optionsTo(
      leaving('messages'),
      {
        provider: { anthropic: { thinking: { type: 'enabled' } }, openai: {} },
        hints: { openai: { service_tier: 'flex' } },
      },
      undefined,
    ).fields,
  ).toEqual({ max_tokens: 64000, thinking: { type: 'enabled' } });
});
