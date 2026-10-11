import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { adapted, type Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import * as entry from '../src/openrouter.ts';
import { openrouter } from '../src/openrouter.ts';

test('it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = openrouter({ key: 'sk-or-host' });

  expect(adapter.serves('openrouter/deepseek/deepseek-chat')).toBe(true);
  expect(adapter.serves('openai/gpt-5')).toBe(false);
  expect(openrouter({ key: 'k', prefix: 'or' }).serves('or/x/y')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => openrouter({ key: undefined })).toThrow(
    'The openrouter adapter was given no key',
  );
  expect(() => openrouter({ key: '' })).toThrow();
  expect(() => openrouter({ key: ' \t' })).toThrow(
    'The openrouter adapter was given no key',
  );
});

test('a call goes to Chat Completions with the key and the name OpenRouter knows the model by', async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
        body: await request.json(),
      });
      return new Response(
        `data: {"id":"gen-1","model":"deepseek/deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":"pong"},"finish_reason":null}]}

data: {"id":"gen-1","model":"deepseek/deepseek-chat","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/deepseek/deepseek-chat',
      {
        messages: [{ role: 'user', text: 'ping' }],
        options: { maxTokens: 40 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      path: '/api/v1/chat/completions',
      key: 'Bearer sk-or-host',
      body: {
        max_completion_tokens: 40,
        model: 'deepseek/deepseek-chat',
        messages: [{ role: 'user', content: 'ping' }],
        stream: true,
        stream_options: { include_usage: true },
      },
    },
  ]);
  expect(events).toMatchObject([
    { type: 'text', text: 'pong' },
    { type: 'finish', reason: 'stop', usage: { input: 9, output: 1 } },
  ]);
});

test('an effort and a mute, or a budget, go upstream in the reasoning object', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
  ]);

  const muted = await Array.fromAsync(
    models(
      'openrouter/openai/gpt-5-nano',
      {
        messages: [{ role: 'user', text: '17*23?' }],
        options: { reasoning: { effort: 'high', exclude: true } },
      },
      AbortSignal.timeout(5000),
    ),
  );
  const budgeted = await Array.fromAsync(
    models(
      'openrouter/anthropic/claude-haiku-5.5',
      {
        messages: [{ role: 'user', text: '17*23?' }],
        options: { reasoning: { budgetTokens: 1024 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning: { effort: 'high', exclude: true },
      model: 'openai/gpt-5-nano',
      messages: [{ role: 'user', content: '17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
    {
      reasoning: { max_tokens: 1024 },
      model: 'anthropic/claude-haiku-5.5',
      messages: [{ role: 'user', content: '17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(muted.at(-1)).not.toHaveProperty('warnings');
  expect(budgeted.at(-1)).not.toHaveProperty('warnings');
});

test('a signature that comes in the details reaches a Chat Completions caller, who sends it back on the next turn', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"id":"gen-1","model":"anthropic/claude-haiku-5.5","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"Paris is ","reasoning_details":[{"type":"reasoning.text","text":"Paris is ","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}

data: {"id":"gen-1","model":"anthropic/claude-haiku-5.5","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"north.","reasoning_details":[{"type":"reasoning.text","text":"north.","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}

data: {"id":"gen-1","model":"anthropic/claude-haiku-5.5","choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning_details":[{"type":"reasoning.text","signature":"EqQBCkYIBxgC","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}

data: {"id":"gen-1","model":"anthropic/claude-haiku-5.5","choices":[{"index":0,"delta":{"content":null,"role":"assistant","tool_calls":[{"index":0,"id":"toolu_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}]},"finish_reason":null}]}

data: {"id":"gen-1","model":"anthropic/claude-haiku-5.5","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":30,"total_tokens":50}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
    ),
    () => ({
      models: [
        openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
      ],
      report: (report) => reports.push(report),
    }),
  );

  const first = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'Weather further north?' }],
      }),
    }),
  );
  const answer = await first.json();
  const second = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        reasoning_effort: 'high',
        messages: [
          { role: 'user', content: 'Weather further north?' },
          {
            role: 'assistant',
            content: null,
            reasoning: 'Paris is north.',
            reasoning_content: 'Paris is north.',
            reasoning_details: [
              {
                type: 'reasoning.text',
                text: 'Paris is north.',
                signature: 'EqQBCkYIBxgC',
                format: 'anthropic-claude-v1',
                index: 0,
              },
            ],
            tool_calls: [
              {
                id: 'toolu_1',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"city":"Paris"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'toolu_1', content: 'Sunny' },
        ],
      }),
    }),
  );
  await second.text();
  await served.close();

  expect(answer).toMatchObject({
    choices: [
      {
        message: {
          content: null,
          reasoning: 'Paris is north.',
          reasoning_details: [
            {
              type: 'reasoning.text',
              text: 'Paris is north.',
              signature: 'EqQBCkYIBxgC',
              format: 'anthropic-claude-v1',
              index: 0,
            },
          ],
          tool_calls: [{ id: 'toolu_1' }],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
  expect(seen[1]).toEqual({
    reasoning: { effort: 'high' },
    model: 'anthropic/claude-haiku-5.5',
    messages: [
      { role: 'user', content: 'Weather further north?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
        reasoning_details: [
          {
            type: 'reasoning.text',
            text: 'Paris is north.',
            signature: 'EqQBCkYIBxgC',
            format: 'anthropic-claude-v1',
            index: 0,
          },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Sunny' },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(reports).toMatchObject([
    { outcome: 'completed' },
    { outcome: 'completed' },
  ]);
  expect(reports[0]).not.toHaveProperty('warnings');
  expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
});

test('plain reasoning text goes back on the assistant turn of a tool loop', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"Sunny."},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/deepseek/deepseek-v4-flash',
      {
        messages: [
          { role: 'user', text: 'Weather in Paris?' },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'I need the tool.' },
              {
                type: 'tool_call',
                id: 'call_1',
                name: 'get_weather',
                input: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            parts: [{ type: 'tool_result', id: 'call_1', text: 'Sunny' }],
          },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        { role: 'user' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1' }],
          reasoning: 'I need the tool.',
        },
        { role: 'tool' },
      ],
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a budget from an Anthropic Messages caller turns thinking on, and the details it cannot hold are reported', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"17*23 is 391.","reasoning_details":[{"type":"reasoning.text","text":"17*23 is 391.","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning_details":[{"type":"reasoning.text","signature":"EqQBCkYIBxgC","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"391","role":"assistant"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
    ),
    () => ({
      models: [
        openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
      ],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'relay',
        max_tokens: 1400,
        thinking: { type: 'enabled', budget_tokens: 1024 },
        messages: [{ role: 'user', content: 'What is 17*23?' }],
      }),
    }),
  );
  const answer = await reply.json();
  await served.close();

  expect(seen).toMatchObject([
    { reasoning: { max_tokens: 1024 }, max_completion_tokens: 1400 },
  ]);
  expect(answer).toMatchObject({
    content: [
      { type: 'thinking', thinking: '17*23 is 391.' },
      { type: 'text', text: '391' },
    ],
  });
  expect(JSON.stringify(answer)).not.toContain('EqQBCkYIBxgC');
  expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  expect(reports[0]?.warnings).toEqual([
    {
      setting: 'reasoning',
      detail:
        'Anthropic Messages has no form for what a model goes on from its reasoning with',
    },
  ]);
});

test('a failure is recorded under OpenRouter`s name', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { message: 'No auth credentials found', code: 401 } },
        { status: 401 },
      ),
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/openai/gpt-5-nano',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'upstream_refused',
        provider: { openrouter: { status: 401 } },
        upstream: true,
      },
    },
  ]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/openrouter.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['openrouter']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test('media goes upstream in OpenRouter`s forms, and a picture the model made comes back as a file', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0="},"index":0}]},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/google/gemini-image',
      {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'file', url: 'https://x.test/a.pdf', name: 'a.pdf' },
              {
                type: 'file',
                url: 'https://x.test/a.mp4',
                mediaType: 'video/mp4',
              },
              { type: 'audio', data: 'ZkxhQw==', mediaType: 'audio/flac' },
            ],
          },
          {
            role: 'assistant',
            parts: [
              { type: 'image', data: 'iVBORw0=', mediaType: 'image/png' },
              { type: 'tool_call', id: 'call_1', name: 'plot', input: {} },
            ],
          },
          {
            role: 'tool',
            parts: [
              {
                type: 'tool_result',
                id: 'call_1',
                parts: [{ type: 'image', url: 'https://x.test/chart.png' }],
              },
            ],
          },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: { file_data: 'https://x.test/a.pdf', filename: 'a.pdf' },
            },
            { type: 'video_url', video_url: { url: 'https://x.test/a.mp4' } },
            {
              type: 'input_audio',
              input_audio: { data: 'ZkxhQw==', format: 'flac' },
            },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1' }],
          images: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0=' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://x.test/chart.png' },
            },
          ],
        },
      ],
    },
  ]);
  expect(events).toMatchObject([
    {
      type: 'file',
      data: 'iVBORw0=',
      mediaType: 'image/png',
      provider: { 'openai.chat': { type: 'image_url', index: 0 } },
    },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('a request the credits cannot pay for is a spent quota, in the words seen live without the link into the account', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message:
              "This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128. To increase, visit https://openrouter.ai/workspaces/default/keys/0f3a9c41d7 and adjust the key's total limit",
            code: 402,
            metadata: {
              limit_source: 'openrouter_credits',
              remedy_hint:
                'Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining balance.',
              provider_name: null,
            },
          },
          user_id: 'user_2zQmadeup',
        },
        { status: 402 },
      ),
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/openai/gpt-chat-latest',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'quota_exceeded',
        message:
          'This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128.',
        provider: {
          openrouter: {
            status: 402,
            metadata: { limit_source: 'openrouter_credits' },
          },
        },
        upstream: true,
      },
    },
  ]);
  expect(events[0]).not.toHaveProperty('error.retryable');
});

test('a budget held by requests still in flight is a limit a wait meets, by its reference', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message: 'Insufficient budget while other requests are in flight',
            code: 402,
            metadata: { reason: 'in_flight_budget_exhausted' },
          },
        },
        { status: 402 },
      ),
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/openai/gpt-chat-latest',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'rate_limited',
        message: 'Insufficient budget while other requests are in flight',
        retryable: true,
        upstream: true,
      },
    },
  ]);
});

test('a path the router does not have is the host`s address to mend, in the words seen live, and no model is said to be unknown', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { message: 'Not Found', code: 404 } },
        { status: 404 },
      ),
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v2` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openrouter/openai/gpt-5-nano',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'Not Found',
        retryable: false,
        upstream: true,
      },
    },
  ]);
});

test.each([
  {
    status: 402,
    told: 'a key at its limit',
    from: 'by its reference',
    error: {
      message: 'Key limit exceeded',
      code: 402,
      metadata: { limit_source: 'openrouter_key_limit' },
    },
    kind: 'quota_exceeded',
  },
  {
    status: 403,
    told: 'an input the moderation flagged',
    from: 'by its reference',
    error: {
      message: 'Your input was flagged',
      code: 403,
      metadata: {
        reasons: ['violence'],
        flagged_input: 'How do I...',
        provider_name: 'OpenAI',
        model_slug: 'openai/gpt-5-nano',
      },
    },
    kind: 'blocked',
  },
  {
    status: 403,
    told: 'an input a guardrail matched',
    from: 'by its reference',
    error: {
      message: 'Request blocked by a guardrail',
      code: 403,
      metadata: { patterns: ['ssn'] },
    },
    kind: 'blocked',
  },
  {
    status: 400,
    told: 'a content policy violation',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: {
        error_type: 'content_policy_violation',
        provider_name: 'Azure',
      },
    },
    kind: 'blocked',
  },
  {
    status: 400,
    told: 'a refusal',
    from: 'by its reference',
    error: {
      message: 'The provider refused the request',
      code: 400,
      error_type: 'refusal',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    told: 'context_length_exceeded',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: { error_type: 'context_length_exceeded' },
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    told: 'token_limit_exceeded',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: { error_type: 'token_limit_exceeded' },
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    told: 'max_tokens_exceeded',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: { error_type: 'max_tokens_exceeded' },
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    told: 'a prompt past the endpoint`s context',
    from: 'seen live',
    error: {
      message:
        "This endpoint's maximum context length is 131072 tokens. However, you requested about 100000003 tokens (3 of text input, 100000000 in the output). Please reduce the length of either one, or use the context-compression plugin to compress your prompt automatically.",
      code: 400,
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    told: 'a model the router does not know',
    from: 'seen live',
    error: {
      message: 'nobody/no-such-model is not a valid model ID',
      code: 400,
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    told: 'not_found',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 400,
      metadata: { error_type: 'not_found' },
    },
    kind: 'unknown_model',
  },
  {
    status: 502,
    told: 'provider_overloaded',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 502,
      metadata: { error_type: 'provider_overloaded' },
    },
    kind: 'overloaded',
  },
  {
    status: 503,
    told: 'provider_unavailable',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 503,
      metadata: { error_type: 'provider_unavailable' },
    },
    kind: 'upstream_failed',
  },
  {
    status: 502,
    told: 'timeout',
    from: 'by its reference',
    error: {
      message: 'Provider returned error',
      code: 502,
      metadata: { error_type: 'timeout' },
    },
    kind: 'timed_out',
  },
  {
    status: 400,
    told: 'an order not to reason the endpoint cannot follow',
    from: 'seen live',
    error: {
      message:
        'Reasoning is mandatory for this endpoint and cannot be disabled.',
      code: 400,
      metadata: { provider_name: null },
    },
    kind: 'unsupported',
  },
  {
    status: 402,
    told: 'a payment nothing more is said of',
    from: 'by its reference',
    error: { message: 'Insufficient credits', code: 402 },
    kind: 'quota_exceeded',
  },
])(
  '$told told as $status is $kind, in the upstream`s words, $from',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      openrouter({ key: 'sk-or-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openrouter/minimax/minimax-m2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: { code: kind, message: error.message, upstream: true },
      },
    ]);
  },
);

test.each([
  {
    told: 'a provider out of capacity',
    error: {
      code: 502,
      message: 'Provider returned error',
      metadata: { error_type: 'provider_overloaded', provider_name: 'Minimax' },
    },
    kind: 'overloaded',
  },
  {
    told: 'a prompt past the endpoint`s context',
    error: {
      code: 400,
      message:
        "This endpoint's maximum context length is 131072 tokens. However, you requested about 140000 tokens.",
    },
    kind: 'context_too_long',
  },
  {
    told: 'a rate limit only the number names',
    error: { code: 429, message: 'Rate limit exceeded' },
    kind: 'rate_limited',
  },
])(
  '$told told inside a reply that began well, with its status a number in the error, is $kind, by its reference',
  async ({ error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: {"id":"gen-1791633316","provider":"Minimax","model":"minimax/minimax-m2.7","choices":[{"index":0,"delta":{"role":"assistant","content":"39"},"finish_reason":null}]}

data: ${JSON.stringify({ id: 'gen-1791633316', provider: 'Minimax', model: 'minimax/minimax-m2.7', error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })}

`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const { models } = adapted([
      openrouter({ key: 'sk-or-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openrouter/minimax/minimax-m2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      { type: 'text', text: '39' },
      {
        type: 'error',
        error: {
          code: kind,
          message: error.message,
          provider: { openrouter: { code: error.code } },
          upstream: true,
        },
      },
    ]);
  },
);

test('a model no provider serves with what the request asks is known and the request unsupported, in the words seen live', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message:
              'No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection',
            code: 404,
            metadata: { failed_routing_step: 'Filter by Parameters' },
          },
        },
        { status: 404 },
      ),
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: upstream.url.origin }),
  ]);

  expect(
    await Array.fromAsync(
      models(
        'openrouter/anthropic/claude-opus-4.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'unsupported',
        message:
          'No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection',
        provider: {
          openrouter: {
            status: 404,
            code: 404,
            metadata: { failed_routing_step: 'Filter by Parameters' },
          },
        },
        upstream: true,
      },
    },
  ]);
});

test('a model the host`s data policy shuts out is the host`s setup to mend, by its reference', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message:
              'No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy',
            code: 404,
          },
        },
        { status: 404 },
      ),
  });
  const { models } = adapted([
    openrouter({ key: 'sk-or-host', address: upstream.url.origin }),
  ]);

  expect(
    await Array.fromAsync(
      models(
        'openrouter/openai/gpt-oss-20b:free',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_refused',
        message: "The upstream refused the host's credentials or account",
        provider: {
          openrouter: {
            status: 404,
            code: 404,
            message:
              'No endpoints found matching your data policy (Free model publication). Configure: https://openrouter.ai/settings/privacy',
          },
        },
        upstream: true,
      },
    },
  ]);
});

test.each([
  {
    from: 'OpenAI',
    status: 429,
    said: 'Rate limit reached for gpt-4o in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s. Visit https://platform.openai.com/account/rate-limits to learn more.',
    told: 'Provider returned error: Rate limit reached for gpt-4o on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s.',
  },
  {
    from: 'Anthropic',
    status: 429,
    said: "This request would exceed your organization's rate limit of 30,000 input tokens per minute (org: 3a68180d-2011-422d-afea-f25a64613009, model: claude-sonnet-4-20250514). Please reduce the prompt length.",
    told: "Provider returned error: This request would exceed your organization's rate limit of 30,000 input tokens per minute (model: claude-sonnet-4-20250514). Please reduce the prompt length.",
  },
  {
    from: 'Groq',
    status: 429,
    said: 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01m17c8ntqe9ba25dtdms847wq` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
    told: 'Provider returned error: Rate limit reached for model `openai/gpt-oss-120b` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s.',
  },
  {
    from: 'Moonshot',
    status: 429,
    said: 'Your account org-0123456789abcdef0123456789abcdef<ak-a1b2c3d4e5f6g7h8i9j0> request reached organization max RPM: 3, please try again after 1 seconds',
    told: 'Provider returned error: Your account request reached organization max RPM: 3, please try again after 1 seconds',
  },
  {
    from: 'DeepSeek',
    status: 502,
    said: 'Server Error (request_id: fb642953-7c1e-4b0a-9d55-0e2f6a1b3c4d)',
    told: 'Provider returned error: Server Error',
  },
  {
    from: 'Google',
    status: 502,
    said: 'Generative Language API has not been used in project 542708778979 before or it is disabled.',
    told: 'Provider returned error: Generative Language API has not been used in project before or it is disabled.',
  },
  {
    from: 'a provider that said more than is told',
    status: 502,
    said: `${'x'.repeat(290)} in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on tokens per min`,
    told: `Provider returned error: ${'x'.repeat(290)} on tokens`,
  },
])(
  'what $from said beside the router`s error is told without the account it names, the record holds what was said, and the router`s own id for the host reaches nobody',
  async ({ status, said, told }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            error: {
              message: 'Provider returned error',
              code: status,
              metadata: {
                raw: JSON.stringify({ error: { message: said } }),
                provider_name: 'A provider',
              },
            },
            user_id: 'user_2z4xQ9mK7pL3vB8nR5tY1wHc6dF',
          },
          { status },
        ),
    });
    const { models } = adapted([
      openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openrouter/openai/gpt-5-nano',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          message: told,
          provider: {
            openrouter: {
              message: `Provider returned error: ${said.slice(0, 300)}`,
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('user_2z4x');
  },
);

test.each([
  {
    status: 403,
    said: 'Generative Language API has not been used in project 542708778979 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/generativelanguage.googleapis.com/overview?project=542708778979 then retry.',
    told: "The upstream refused the host's credentials or account",
  },
  {
    status: 429,
    said: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro-tts',
    told: 'Provider returned error: Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro-tts',
  },
  {
    status: 400,
    said: 'invalid request error trace_id: 9ca63e68a57e69c0c49712a4efdf620b',
    told: 'Provider returned error: invalid request error trace_id: 9ca63e68a57e69c0c49712a4efdf620b',
  },
  {
    status: 400,
    said: "Invalid 'tools[0].function.name': string 'org-abcdefghijklmnopqrstuvwx' is bad",
    told: "Provider returned error: Invalid 'tools[0].function.name': string 'org-abcdefghijklmnopqrstuvwx' is bad",
  },
])(
  'what a provider said beside the router`s $status that names no account is told as the kind is told: $told',
  async ({ status, said, told }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            error: {
              message: 'Provider returned error',
              code: status,
              metadata: { raw: said, provider_name: 'A provider' },
            },
          },
          { status },
        ),
    });
    const { models } = adapted([
      openrouter({ key: 'sk-or-host', address: `${upstream.url}api/v1` }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openrouter/openai/gpt-5-nano',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([{ type: 'error', error: { message: told } }]);
  },
);
