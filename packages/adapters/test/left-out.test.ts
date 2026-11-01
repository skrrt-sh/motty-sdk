import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import {
  adapted,
  type ModelAdapter,
  type Options,
  type Report,
} from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { dashscope } from '../src/dashscope.ts';
import { deepseek } from '../src/deepseek.ts';
import { fireworks } from '../src/fireworks.ts';
import { groq } from '../src/groq.ts';
import { local } from '../src/local.ts';
import { minimax } from '../src/minimax.ts';
import { mistral } from '../src/mistral.ts';
import { moonshot } from '../src/moonshot.ts';
import { ollama } from '../src/ollama.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';
import { together } from '../src/together.ts';
import { zai } from '../src/zai.ts';

test('a seed and a reasoning budget the Responses API has no field for reach the report from a Chat Completions caller', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `event: response.created
data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-5","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello there"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('openai/gpt-5').complete(prompt),
    ),
    () => ({
      models: [openai({ key: 'sk-host', address: `${upstream.url}v1` })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        seed: 7,
        reasoning: { max_tokens: 2048 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  const answer = await reply.json();
  await served.close();

  expect(reply.status).toBe(200);
  expect(answer).toMatchObject({
    choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }],
  });
  expect(seen).toMatchObject([{ model: 'gpt-5', stream: true }]);
  expect(seen[0]).not.toHaveProperty('seed');
  expect(JSON.stringify(seen[0])).not.toContain('2048');
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.calls[0]?.warnings).toEqual([
    { setting: 'seed', detail: 'The Responses API has no field for a seed' },
    {
      setting: 'reasoning.budgetTokens',
      detail: 'The Responses API has no field for a reasoning budget in tokens',
    },
  ]);
  expect(reports[0]).not.toHaveProperty('warnings');
});

const key = 'sk-host';

const reply = (path: string) =>
  new Response(
    path.endsWith('/responses')
      ? `event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}

`
      : path.endsWith('/messages')
        ? `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"m","stop_reason":null,"usage":{"input_tokens":9,"output_tokens":0}}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`
        : `data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}

data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]

`,
    { headers: { 'content-type': 'text/event-stream' } },
  );

// A motty served over the one adapter, and what each call sent the upstream.
function relaying(
  connected: (address: string) => ModelAdapter,
  wanted: string,
) {
  const seen: Record<string, unknown>[] = [];
  const upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(JSON.parse(await request.text()));
      return reply(new URL(request.url).pathname);
    },
  });
  const reports: Report[] = [];
  let authored: Options = {};
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model(wanted).complete({
        ...prompt,
        options: { ...prompt.options, ...authored },
      }),
    ),
    () => ({
      models: [connected(`${upstream.url}v1`)],
      report: (report) => reports.push(report),
    }),
  );
  return {
    asked: async (path: string, said: object, options: Options = {}) => {
      authored = options;
      const answer = await served.fetch(
        new Request(`http://localhost/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'relay', ...said }),
        }),
      );
      await answer.text();
      expect(answer.status).toBe(200);
      const { model: _, stream: __, messages, ...rest } = seen.at(-1) ?? {};
      return {
        rest,
        messages,
        warnings: reports.at(-1)?.calls[0]?.warnings ?? [],
      };
    },
    [Symbol.asyncDispose]: async () => {
      await served.close();
      await upstream.stop(true);
    },
  };
}

// What each adapter and codec of Chat Completions takes and under what name,
// from its own reference, each option by the name an author says it. `penalties`
// is a model's rule leaving those out first, `marks` the marker a key implies,
// `also` what the adapter adds itself.
const every = [
  {
    name: 'openai chat',
    connected: (address: string) =>
      openai({ key, address, api: 'chat-completions' }),
    wanted: 'openai/gpt-5',
    takes:
      'metadata store serviceTier safetyIdentifier cacheKey cacheOptions cacheRetention prediction verbosity seed user presencePenalty frequencyPenalty streamOptions maxTokens',
  },
  {
    name: 'openrouter',
    connected: (address: string) => openrouter({ key, address }),
    wanted: 'openrouter/meta/llama-5',
    takes:
      'metadata store serviceTier safetyIdentifier cacheKey cacheOptions cacheRetention prediction verbosity seed user presencePenalty frequencyPenalty streamOptions maxTokens',
    marks: true,
  },
  {
    name: 'fireworks',
    connected: (address: string) => fireworks({ key, address }),
    wanted: 'fireworks/accounts/fireworks/models/glm-5',
    takes:
      'metadata serviceTier cacheKey prediction seed user presencePenalty frequencyPenalty streamOptions maxTokens',
  },
  {
    name: 'fireworks bound',
    connected: (address: string) => fireworks({ key, address }),
    wanted: 'fireworks/accounts/fireworks/models/gpt-oss-120b',
    takes:
      'metadata serviceTier cacheKey prediction seed user presencePenalty frequencyPenalty streamOptions maxTokens',
  },
  {
    name: 'mistral',
    connected: (address: string) => mistral({ key, address }),
    wanted: 'mistral/mistral-large-latest',
    takes:
      'metadata serviceTier cacheKey prediction seed presencePenalty frequencyPenalty maxTokens',
    as: { seed: 'random_seed', maxTokens: 'max_tokens' },
  },
  {
    name: 'moonshot newest',
    connected: (address: string) => moonshot({ key, address }),
    wanted: 'moonshot/kimi-k3',
    takes:
      'safetyIdentifier cacheKey cacheOptions prediction streamOptions maxTokens',
    penalties: true,
  },
  {
    name: 'moonshot K2',
    connected: (address: string) => moonshot({ key, address }),
    wanted: 'moonshot/kimi-k2-thinking',
    takes:
      'safetyIdentifier cacheKey cacheOptions prediction streamOptions maxTokens',
    penalties: true,
  },
  {
    name: 'moonshot v1',
    connected: (address: string) => moonshot({ key, address }),
    wanted: 'moonshot/moonshot-v1-8k',
    takes:
      'safetyIdentifier cacheKey cacheOptions prediction streamOptions maxTokens',
  },
  {
    name: 'groq',
    connected: (address: string) => groq({ key, address }),
    wanted: 'groq/qwen/qwen3-32b',
    takes: 'serviceTier seed user streamOptions maxTokens',
  },
  {
    name: 'deepseek',
    connected: (address: string) => deepseek({ key, address }),
    wanted: 'deepseek/deepseek-v4',
    takes: 'streamOptions maxTokens',
    as: { maxTokens: 'max_tokens' },
  },
  {
    name: 'minimax',
    connected: (address: string) => minimax({ key, address }),
    wanted: 'minimax/MiniMax-M3',
    takes: 'serviceTier streamOptions maxTokens',
    penalties: true,
  },
  {
    name: 'dashscope',
    connected: (address: string) => dashscope({ key, address }),
    wanted: 'dashscope/qwen3.6-plus',
    takes: 'seed presencePenalty streamOptions maxTokens',
    marks: true,
  },
  {
    name: 'zai',
    connected: (address: string) => zai({ key, address }),
    wanted: 'zai/glm-5',
    takes: 'streamOptions maxTokens',
    as: { maxTokens: 'max_tokens' },
    penalties: true,
    also: { tool_stream: true },
  },
  {
    name: 'ollama',
    connected: (address: string) => ollama({ address }),
    wanted: 'ollama/qwen3',
    takes: 'seed presencePenalty frequencyPenalty streamOptions maxTokens',
    as: { maxTokens: 'max_tokens' },
  },
  {
    name: 'local',
    connected: (address: string) => local({ address }),
    wanted: 'local/qwen3',
    takes: 'seed user presencePenalty frequencyPenalty streamOptions maxTokens',
  },
  {
    name: 'local said to',
    connected: (address: string) =>
      local({
        address,
        fields: {
          cacheKey: true,
          streamOptions: true,
          maxTokens: 'max_tokens',
        },
      }),
    wanted: 'local/qwen3',
    takes: 'cacheKey streamOptions maxTokens',
    as: { maxTokens: 'max_tokens' },
  },
  ...[
    ['together', 'meta-llama/llama-5'],
    ['together contented', 'zai-org/GLM-5'],
    ['together leveled', 'openai/gpt-oss-120b'],
    ['together tagged', 'deepseek-ai/DeepSeek-R1'],
  ].map(([name = '', wanted]) => ({
    name,
    connected: (address: string) => together({ key, address }),
    wanted: `together/${wanted}`,
    takes:
      'cacheKey seed presencePenalty frequencyPenalty streamOptions maxTokens',
    as: { maxTokens: 'max_tokens' },
  })),
];

// The two APIs that have no table, read the same way. `within` is a field that
// goes inside another, `silent` an option with no field that does what it asks
// some other way, and `told` the sentence for each one left out.
const untabled = [
  {
    name: 'openai responses',
    connected: (address: string) => openai({ key, address }),
    wanted: 'openai/gpt-5',
    takes:
      'metadata serviceTier safetyIdentifier cacheKey cacheOptions cacheRetention verbosity user presencePenalty frequencyPenalty maxTokens',
    as: { maxTokens: 'max_output_tokens' },
    within: { verbosity: 'text' },
    also: {
      store: false,
      input: [{ type: 'message', role: 'user', content: 'ping' }],
    },
    told: {
      seed: 'The Responses API has no field for a seed',
      prediction: 'The Responses API has no field for a prediction',
      store: 'The Responses API has no field for an order to keep the response',
    },
  },
  {
    name: 'anthropic',
    connected: (address: string) => anthropic({ key, address }),
    wanted: 'anthropic/claude-x',
    takes: 'user maxTokens',
    as: { user: 'user_id', maxTokens: 'max_tokens' },
    within: { user: 'metadata' },
    marks: true,
    silent: ['cacheKey'],
    told: {
      metadata: 'Anthropic Messages has no field for metadata',
      store:
        'Anthropic Messages has no field for an order to keep the response',
      serviceTier:
        "Anthropic Messages has no field for a service tier, whose values are each provider's own",
      safetyIdentifier: 'Anthropic Messages has no field for a safety name',
      cacheOptions: 'Anthropic Messages has no field for cache options',
      cacheRetention: 'Anthropic Messages has no field for a cache lifetime',
      prediction: 'Anthropic Messages has no field for a prediction',
      verbosity: 'Anthropic Messages has no field for a level of verbosity',
      seed: 'Anthropic Messages has no field for a seed',
      presencePenalty: 'Anthropic Messages has no field for a presence penalty',
      frequencyPenalty:
        'Anthropic Messages has no field for a frequency penalty',
    },
  },
];

test.each([...every, ...untabled])(
  'every option an author or a caller says to $name goes under the name its table gives, and each of the others is told left out by name, with the marker a key implied kept',
  async (row) => {
    const { name, connected, wanted, takes, as, also } = row;
    const { penalties, marks } = { penalties: false, marks: false, ...row };
    const {
      within,
      silent,
      told: worded,
    } = {
      within: {},
      silent: [],
      told: {},
      ...row,
    };
    await using relay = relaying(connected, wanted);
    const taken = takes.split(' ');
    const renamed: { [option: string]: string } = as ?? {};
    const inside: { [option: string]: string } = within;
    const sentences: { [option: string]: string } = worded;
    const quiet: string[] = silent;
    // OpenAI's name for each option, which is how a caller says it.
    const wire: { [option: string]: string } = {
      serviceTier: 'service_tier',
      safetyIdentifier: 'safety_identifier',
      cacheKey: 'prompt_cache_key',
      cacheOptions: 'prompt_cache_options',
      cacheRetention: 'prompt_cache_retention',
      presencePenalty: 'presence_penalty',
      frequencyPenalty: 'frequency_penalty',
      maxTokens: 'max_completion_tokens',
    };
    const told = (option: string) => {
      if (penalties && option.endsWith('Penalty')) {
        const said = option.replace('Penalty', '');
        return {
          setting: `${option}.model`,
          detail: `Chat Completions has no field for a ${said} penalty the model does not take`,
        };
      }
      return {
        setting: option,
        detail:
          sentences[option] ??
          `${name.split(' ')[0]} has no field for ${option}`,
      };
    };
    const bySetting = (one: { setting: string }, other: { setting: string }) =>
      one.setting.localeCompare(other.setting);
    const sent = (said: { [option: string]: unknown }) => {
      const body: { [field: string]: unknown } = { ...also };
      for (const [option, value] of Object.entries(said)) {
        if (!taken.includes(option)) continue;
        const field = renamed[option] ?? wire[option] ?? option;
        const holder = inside[option];
        if (holder === undefined) body[field] = value;
        else body[holder] = { [field]: value };
      }
      return body;
    };
    const both = {
      serviceTier: 'secret-tier',
      safetyIdentifier: 'secret-identifier',
      cacheKey: 'secret-key',
      cacheOptions: { mode: 'secret-mode' },
      cacheRetention: 'secret-retention',
      metadata: { ticket: 'secret-ticket' },
      user: 'secret-user',
      presencePenalty: 0.5,
      frequencyPenalty: 0.25,
      maxTokens: 64,
    };
    const whole = {
      ...both,
      verbosity: 'secret-verbosity',
      store: true,
      prediction: { type: 'content', content: 'secret-prediction' },
      seed: 7,
    };
    const wired = (said: { [option: string]: unknown }) =>
      Object.fromEntries(
        Object.entries(said).map(([option, value]) => [
          wire[option] ?? option,
          value,
        ]),
      );
    const messages = [{ role: 'user', content: 'ping' }];
    const legs = [
      {
        path: 'chat/completions',
        said: { ...wired(whole), stream_options: { include_usage: true } },
        options: {},
        reaching: whole,
        extra: { messages },
      },
      // A seed or a prediction is no field of the Responses API and a store is
      // held by nobody here, so all else its caller says crosses by the table.
      {
        path: 'responses',
        said: {
          ...wired({ ...both, maxTokens: undefined }),
          max_output_tokens: 64,
          store: false,
          text: { verbosity: 'secret-verbosity' },
          stream_options: { include_usage: true },
        },
        options: {},
        reaching: { ...both, verbosity: 'secret-verbosity' },
        extra: { input: 'ping' },
      },
      {
        path: 'chat/completions',
        said: {},
        options: whole,
        reaching: whole,
        extra: { messages },
      },
    ];

    for (const { path, said, options, reaching, extra } of legs) {
      const reached = await relay.asked(path, { ...said, ...extra }, options);

      expect(reached.rest).toEqual({
        ...sent(reaching),
        // The SDK's own ask for usage, so a table that drops it tells nobody.
        ...(taken.includes('streamOptions')
          ? { stream_options: { include_usage: true } }
          : {}),
      });
      expect(
        JSON.stringify(reached.messages ?? '').includes('cache_control'),
      ).toBe(marks);
      expect([...reached.warnings].sort(bySetting)).toEqual(
        Object.keys(reaching)
          .filter(
            (option) => !taken.includes(option) && !quiet.includes(option),
          )
          .map(told)
          .sort(bySetting),
      );
      expect(JSON.stringify(reached.warnings)).not.toContain('secret');
    }
  },
);

test.each(every)(
  'an order about parallel tool calls reaches $name beside a tool, as dropped it would hand a caller several calls a turn',
  async ({ connected, wanted }) => {
    await using relay = relaying(connected, wanted);

    const { rest, warnings } = await relay.asked('chat/completions', {
      parallel_tool_calls: false,
      tools: [
        {
          type: 'function',
          function: { name: 'weather', parameters: { type: 'object' } },
        },
      ],
      messages: [{ role: 'user', content: 'ping' }],
    });

    expect(rest).toMatchObject({ parallel_tool_calls: false });
    expect(warnings).toEqual([]);
  },
);

test.each(every)(
  'a covered option nobody said warns $name of nothing, nor does a null, an empty object or a penalty of zero',
  async ({ connected, wanted, takes, also }) => {
    await using relay = relaying(connected, wanted);

    const bare = await relay.asked('chat/completions', {
      messages: [{ role: 'user', content: 'ping' }],
    });
    const empty = await relay.asked('chat/completions', {
      metadata: null,
      presence_penalty: 0,
      frequency_penalty: 0,
      messages: [{ role: 'user', content: 'ping' }],
    });
    const zeroed = await relay.asked(
      'chat/completions',
      { messages: [{ role: 'user', content: 'ping' }] },
      { metadata: {}, presencePenalty: 0, frequencyPenalty: 0 },
    );

    expect(bare.rest).toEqual({
      ...also,
      ...(takes.includes('streamOptions')
        ? { stream_options: { include_usage: true } }
        : {}),
    });
    expect(bare.warnings).toEqual([]);
    expect(empty.warnings).toEqual([]);
    expect(zeroed.warnings).toEqual([]);
  },
);

test('the Responses API, which has no table, is sent what it has a field for from either caller, and a seed is told left out', async () => {
  await using relay = relaying(
    (address) => openai({ key, address }),
    'openai/gpt-5',
  );
  const both = {
    prompt_cache_key: 'session-1',
    user: 'user-1',
    presence_penalty: 0.5,
    frequency_penalty: 0.25,
    parallel_tool_calls: false,
  };

  const chat = await relay.asked('chat/completions', {
    ...both,
    max_completion_tokens: 64,
    seed: 7,
    messages: [{ role: 'user', content: 'ping' }],
  });
  const said = {
    ...both,
    max_output_tokens: 64,
    metadata: { ticket: 'T-1' },
    client_metadata: { client: 'C-1' },
    service_tier: 'flex',
    safety_identifier: 'person-1',
    prompt_cache_options: { mode: 'implicit' },
    prompt_cache_retention: '24h',
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
    input: 'ping',
  };
  const responses = await relay.asked('responses', said);

  expect(chat.rest).toMatchObject({ ...both, max_output_tokens: 64 });
  expect(chat.warnings).toEqual([
    { setting: 'seed', detail: 'The Responses API has no field for a seed' },
  ]);
  expect(responses.rest).toEqual({
    ...said,
    input: [{ type: 'message', role: 'user', content: 'ping' }],
    store: false,
  });
  expect(responses.warnings).toEqual([]);
});

test('a Responses caller who says seed or a prediction fails on an upstream of Chat Completions, so a fallback moves on, where its own API carries both', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return reply(new URL(request.url).pathname);
    },
  });
  const asking = async (
    connected: ModelAdapter,
    wanted: string,
    said: object,
  ) => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model(wanted).complete(prompt),
      ),
      () => ({ models: [connected] }),
    );
    const answer = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'relay', input: 'ping', ...said }),
      }),
    );
    const text = await answer.text();
    await served.close();
    return { status: answer.status, text };
  };
  const address = `${upstream.url}v1`;
  const prediction = { type: 'content', content: 'ping' };

  for (const said of [{ seed: 7 }, { prediction }]) {
    const refused = await asking(
      openrouter({ key, address }),
      'openrouter/meta/llama-5',
      said,
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(seen).toEqual([]);
  }
  await asking(openai({ key, address }), 'openai/gpt-5', {
    seed: 7,
    prediction,
  });

  expect(seen).toMatchObject([{ seed: 7, prediction }]);
});

test('a field a table leaves out goes as said where an author names it, in an option or on the connection, under the name it was said by', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return reply(new URL(request.url).pathname);
    },
  });
  const { models } = adapted([
    mistral({ key, address: upstream.url.origin, body: { store: true } }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-large-latest',
      {
        messages: [{ role: 'user', text: 'ping' }],
        options: {
          provider: {
            'openai.chat': {
              user: 'user-1',
              seed: 7,
              verbosity: 'low',
              stream_options: { include_usage: false },
            },
          },
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      store: true,
      user: 'user-1',
      seed: 7,
      verbosity: 'low',
      stream_options: { include_usage: false },
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a hint takes the same rule as a typed field: renamed, or left out and told by name, and one the rule does not cover goes', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return reply(new URL(request.url).pathname);
    },
  });
  const { models } = adapted([mistral({ key, address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-large-latest',
      {
        messages: [{ role: 'user', text: 'ping' }],
        options: {
          hints: {
            openai: {
              seed: 7,
              max_completion_tokens: 9,
              metadata: { ticket: 'T-1' },
              user: 'user-1',
              store: false,
              stream_options: { include_usage: false },
              verbosity: null,
              prompt_cache_options: {},
              top_logprobs: 3,
            },
          },
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      random_seed: 7,
      max_tokens: 9,
      metadata: { ticket: 'T-1' },
      top_logprobs: 3,
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    warnings: [
      { setting: 'user', detail: 'mistral has no field for user' },
      { setting: 'store', detail: 'mistral has no field for store' },
      {
        setting: 'streamOptions',
        detail: 'mistral has no field for streamOptions',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 3);
});

test('a typed option wins a clash against a hint and against an option in the upstream`s own names, and a field left out is told once', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return reply(new URL(request.url).pathname);
    },
  });
  const { models } = adapted([
    mistral({ key, address: upstream.url.origin }),
    groq({ key, address: upstream.url.origin }),
  ]);
  const options = {
    serviceTier: 'flex',
    metadata: { ticket: 'typed' },
    hints: {
      openai: { service_tier: 'hinted', metadata: { ticket: 'hinted' } },
    },
  };

  await Array.fromAsync(
    models(
      'mistral/mistral-large-latest',
      {
        messages: [{ role: 'user', text: 'ping' }],
        options: {
          ...options,
          provider: { 'openai.chat': { service_tier: 'own' } },
        },
      },
      AbortSignal.timeout(5000),
    ),
  );
  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      { messages: [{ role: 'user', text: 'ping' }], options },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen[0]).toMatchObject({
    service_tier: 'flex',
    metadata: { ticket: 'typed' },
  });
  expect(seen[1]).toMatchObject({ service_tier: 'flex' });
  expect(seen[1]).not.toHaveProperty('metadata');
  expect(events.at(-1)).toMatchObject({
    warnings: [
      { setting: 'metadata', detail: 'groq has no field for metadata' },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});
