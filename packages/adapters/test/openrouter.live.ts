import { describe, expect, test } from 'bun:test';
import { fallback, model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { run } from '@mottyjs/test';
import { anthropic } from '../src/anthropic.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { OPENROUTER_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')('against OpenRouter', () => {
  test('DeepSeek answers a streaming Chat Completions caller and its usage is in the record', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/deepseek/deepseek-chat').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 40,
          messages: [
            { role: 'user', content: 'Say the word pong and nothing else.' },
          ],
        }),
      }),
    );
    const text = await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    // The word may come split over several chunks.
    expect(text).toContain('"delta":{"role":"assistant","content":"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toEndWith('data: [DONE]\n\n');
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        calls: [
          {
            model: 'openrouter/deepseek/deepseek-chat',
            input: expect.any(Number),
            output: expect.any(Number),
          },
        ],
      },
    ]);
  });

  test('an open-source model calls a function tool over Chat Completions', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/mistralai/mistral-nemo').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 120,
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content: 'What is the weather in Paris? Use the tool.',
            },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: expect.any(String),
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: expect.stringContaining('Paris'),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  });

  test("an open-source model goes on from a tool's result over Chat Completions", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/mistralai/mistral-nemo').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 60,
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content: 'What is the weather in Paris? Use the tool.',
            },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_7Qm2xLp9A',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_7Qm2xLp9A',
              content: '{"temp_c":21,"sky":"sunny"}',
            },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      choices: [
        {
          message: { content: expect.stringContaining('21') },
          finish_reason: 'stop',
        },
      ],
    });
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("DeepSeek's reasoning over Chat Completions reaches an Anthropic Messages caller as thinking", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/deepseek/deepseek-v4-flash').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
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
          max_tokens: 400,
          thinking: { type: 'enabled', budget_tokens: 1024 },
          messages: [
            {
              role: 'user',
              content:
                'What is 17*23? Think briefly, then answer with the number.',
            },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      content: [
        { type: 'thinking', thinking: expect.stringContaining('17') },
        { type: 'text', text: expect.stringContaining('391') },
      ],
      stop_reason: 'end_turn',
    });
    expect(reports).toMatchObject([
      { outcome: 'completed', calls: [{ reasoning: expect.any(Number) }] },
    ]);
  });

  test('encrypted reasoning from the Responses API comes back and is taken on the next turn', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [
          openai({
            key,
            address: 'https://openrouter.ai/api/v1',
            prefix: 'openrouter',
          }),
        ],
        report: (report) => reports.push(report),
      }),
    );

    const first = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_output_tokens: 700,
          reasoning: { effort: 'low', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          input: [
            {
              role: 'user',
              content: 'What is 17*23? Think, then answer with the number.',
            },
          ],
        }),
      }),
    );
    const thought = await first.json();
    const items =
      typeof thought === 'object' &&
      thought !== null &&
      'output' in thought &&
      Array.isArray(thought.output)
        ? thought.output
        : [];
    const second = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_output_tokens: 700,
          reasoning: { effort: 'low', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          input: [
            {
              role: 'user',
              content: 'What is 17*23? Think, then answer with the number.',
            },
            ...items,
            { role: 'user', content: 'Now add 9 to it. Only the number.' },
          ],
        }),
      }),
    );
    const answer = await second.json();
    await served.close();

    expect(first.status).toBe(200);
    expect(items).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        encrypted_content: expect.any(String),
      }),
    );
    expect(second.status).toBe(200);
    expect(answer).toMatchObject({
      output: expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          content: [
            expect.objectContaining({ text: expect.stringContaining('400') }),
          ],
        }),
      ]),
    });
    expect(reports).toMatchObject([
      { outcome: 'completed' },
      { outcome: 'completed' },
    ]);
    expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("Claude answers a streaming caller through OpenRouter's Anthropic Messages endpoint", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [
          anthropic({
            key,
            address: 'https://openrouter.ai/api/v1',
            prefix: 'openrouter',
          }),
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
          max_tokens: 40,
          stream: true,
          messages: [
            { role: 'user', content: 'Say the word pong and nothing else.' },
          ],
        }),
      }),
    );
    const text = await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    // The word may come split over several deltas.
    expect(text).toContain('"delta":{"type":"text_delta","text":"');
    expect(text).toContain('"stop_reason":"end_turn"');
    expect(text).toEndWith(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        calls: [{ input: expect.any(Number), output: expect.any(Number) }],
      },
    ]);
  });

  test("a model id OpenRouter does not know, told as a 400, is an unknown model in the caller's format, with its words in the record", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/nobody/no-such-model').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
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
          max_tokens: 20,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(404);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toEqual({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'nobody/no-such-model is not a valid model ID',
      },
      request_id: reply.headers.get('request-id'),
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unknown_model',
          status: 404,
          message: 'nobody/no-such-model is not a valid model ID',
          provider: { openrouter: { status: 400, code: 400 } },
          upstream: true,
        },
        calls: [
          { model: 'openrouter/nobody/no-such-model', code: 'unknown_model' },
        ],
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("a key OpenRouter turns down is told in the SDK's words, whole and streamed, and nothing of it is kept", async () => {
    const secret =
      '7c2e9a4f1b8d3065e7a2c9f4b1d80356a7e2c4f9b1d3806e5a7c2f4b9d1e8036';
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/openai/gpt-4.1-nano').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key: `sk-or-v1-${secret}` })],
        report: (report) => reports.push(report),
      }),
    );

    const whole = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const streamed = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const told = [await whole.text(), await streamed.text()];
    await served.close();

    expect([whole.status, streamed.status]).toEqual([502, 502]);
    expect(told.map((text) => JSON.parse(text))).toEqual([
      {
        error: {
          message: "The upstream refused the host's credentials or account",
          type: 'server_error',
          param: null,
          code: 'upstream_refused',
        },
      },
      {
        error: {
          message: "The upstream refused the host's credentials or account",
          type: 'server_error',
          param: null,
          code: 'upstream_refused',
        },
      },
    ]);
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'upstream_refused',
          status: 502,
          provider: { openrouter: { status: 401, code: 401 } },
          upstream: true,
        },
      },
      {
        outcome: 'failed',
        error: {
          code: 'upstream_refused',
          provider: { openrouter: { status: 401, code: 401 } },
        },
      },
    ]);
    const kept = `${told.join()}${JSON.stringify(reports)}`;
    expect(
      Array.from({ length: secret.length - 3 }, (_, at) =>
        secret.slice(at, at + 4),
      ).filter((run) => kept.includes(run)),
    ).toEqual([]);
  });

  test("a key Anthropic turns down is told in the SDK's words, whole and streamed, and nothing of it is kept", async () => {
    const secret =
      'Hx7Kq2Wm9Tz4Lp6Rv1Yc8Nb3Gd5Fs0Jt-Ue7Ao2Xi9Qw4Zr6Mk1Pv8Lc3Hn5By0AA';
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key: `sk-ant-api03-${secret}` })],
        report: (report) => reports.push(report),
      }),
    );

    const whole = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const streamed = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const told = [await whole.text(), await streamed.text()];
    await served.close();

    expect([whole.status, streamed.status]).toEqual([502, 502]);
    expect(told.map((text) => JSON.parse(text))).toEqual([
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: "The upstream refused the host's credentials or account",
        },
        request_id: whole.headers.get('request-id'),
      },
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: "The upstream refused the host's credentials or account",
        },
        request_id: streamed.headers.get('request-id'),
      },
    ]);
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'upstream_refused',
          status: 502,
          provider: {
            anthropic: { status: 401, type: 'authentication_error' },
          },
          upstream: true,
        },
      },
      {
        outcome: 'failed',
        error: {
          code: 'upstream_refused',
          provider: {
            anthropic: { status: 401, type: 'authentication_error' },
          },
        },
      },
    ]);
    const kept = `${told.join()}${JSON.stringify(reports)}`;
    expect(
      Array.from({ length: secret.length - 3 }, (_, at) =>
        secret.slice(at, at + 4),
      ).filter((run) => kept.includes(run)),
    ).toEqual([]);
  });

  test("the signature of Claude's thinking over Chat Completions reaches a Chat Completions caller", async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 1400,
          reasoning_effort: 'high',
          messages: [
            {
              role: 'user',
              content:
                'Think step by step about which is further north, Paris or Lyon. Then name it.',
            },
          ],
        }),
      }),
    );
    const text = await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(text).toContain('"signature":"');
  });

  test('a reasoning budget from an Anthropic Messages caller turns thinking on over Chat Completions', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
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
          messages: [
            {
              role: 'user',
              content:
                'Think step by step about which is further north, Paris or Lyon. Then name it.',
            },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      content: [
        { type: 'thinking', thinking: expect.stringContaining('Paris') },
        { type: 'text', text: expect.stringContaining('Paris') },
      ],
      stop_reason: 'end_turn',
    });
    expect(reports).toMatchObject([
      { outcome: 'completed', calls: [{ reasoning: expect.any(Number) }] },
    ]);
    // The budget had a field, so the call reports nothing left out; the
    // signature has no form for this caller, and the edge says so.
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
    expect(reports[0]?.warnings).toEqual([
      {
        setting: 'reasoning',
        detail:
          'Anthropic Messages has no form for what a model goes on from its reasoning with',
      },
    ]);
  });

  test("Claude goes on from a tool's result with the reasoning details it was sent back", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const first = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 1400,
          reasoning_effort: 'high',
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content:
                'Think step by step about which is further north, Paris or Lyon. Then get the weather for that city with the tool.',
            },
          ],
        }),
      }),
    );
    const thought = await first.json();
    const message =
      typeof thought === 'object' &&
      thought !== null &&
      'choices' in thought &&
      Array.isArray(thought.choices)
        ? thought.choices[0]?.message
        : undefined;
    const second = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 1400,
          reasoning_effort: 'high',
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            },
          ],
          messages: [
            {
              role: 'user',
              content:
                'Think step by step about which is further north, Paris or Lyon. Then get the weather for that city with the tool.',
            },
            message,
            {
              role: 'tool',
              tool_call_id: message?.tool_calls?.[0]?.id,
              content: '{"temp_c":21,"sky":"sunny"}',
            },
          ],
        }),
      }),
    );
    const answer = await second.json();
    await served.close();

    expect(first.status).toBe(200);
    expect(message).toMatchObject({
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: expect.stringContaining('Paris'),
          signature: expect.any(String),
        },
      ],
      tool_calls: [{ function: { name: 'get_weather' } }],
    });
    expect(second.status).toBe(200);
    expect(answer).toMatchObject({
      choices: [{ message: { content: expect.stringContaining('21') } }],
    });
    expect(reports).toMatchObject([
      { outcome: 'completed' },
      { outcome: 'completed' },
    ]);
    expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("DeepSeek's reasoning reaches a streaming Chat Completions caller as text and as details", async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/deepseek/deepseek-v4-flash').complete(prompt),
      ),
      () => ({ models: [openrouter({ key })] }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          max_tokens: 300,
          reasoning: { effort: 'low' },
          messages: [
            {
              role: 'user',
              content:
                'What is 17*23? Think briefly, then answer with the number.',
            },
          ],
        }),
      }),
    );
    const text = await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(text).toContain('"reasoning":"');
    expect(text).toContain('"reasoning_details":[{"type":"reasoning.text"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toEndWith('data: [DONE]\n\n');
  });

  // The encoder keeps a reasoning item only for its `encrypted_content`; OpenRouter signs Claude's with `signature`.
  test("Claude's signed reasoning item from the Responses API is sent back on the next turn", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [
          openai({
            key,
            address: 'https://openrouter.ai/api/v1',
            prefix: 'openrouter',
          }),
        ],
        report: (report) => reports.push(report),
      }),
    );

    const first = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_output_tokens: 900,
          reasoning: { effort: 'high', summary: 'auto' },
          input: [
            {
              role: 'user',
              content:
                'Think step by step about which is further north, Paris or Lyon. Then name it.',
            },
          ],
        }),
      }),
    );
    const thought = await first.json();
    const items =
      typeof thought === 'object' &&
      thought !== null &&
      'output' in thought &&
      Array.isArray(thought.output)
        ? thought.output
        : [];
    const second = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_output_tokens: 900,
          reasoning: { effort: 'high', summary: 'auto' },
          input: [
            {
              role: 'user',
              content:
                'Think step by step about which is further north, Paris or Lyon. Then name it.',
            },
            ...items,
            { role: 'user', content: 'And which is further south?' },
          ],
        }),
      }),
    );
    await second.text();
    await served.close();

    expect(items).toContainEqual(
      expect.objectContaining({
        type: 'reasoning',
        signature: expect.any(String),
      }),
    );
    expect(second.status).toBe(200);
    expect(reports).toHaveLength(2);
    expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("an author's schema with an optional key, no strictness said, is answered by an OpenAI model", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/openai/gpt-4.1-nano').complete({
          ...prompt,
          output: {
            schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
                nickname: { type: 'string' },
              },
              required: ['city'],
              additionalProperties: false,
            },
          },
        }),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 60,
          messages: [
            { role: 'user', content: 'Give the capital of France as JSON.' },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      choices: [
        {
          message: {
            content: expect.stringMatching(
              /^\{\s*"city":\s*"Paris"\s*(,\s*"nickname":\s*"[^"]*"\s*)?\}$/,
            ),
          },
        },
      ],
    });
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
  });

  test("the same schema an author calls strict is OpenAI's own 400, told in its words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/openai/gpt-4.1-nano').complete({
          ...prompt,
          output: {
            schema: {
              type: 'object',
              properties: {
                city: { type: 'string' },
                nickname: { type: 'string' },
              },
              required: ['city'],
              additionalProperties: false,
            },
            strict: true,
          },
        }),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 60,
          messages: [
            { role: 'user', content: 'Give the capital of France as JSON.' },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(400);
    expect(answer).toMatchObject({
      error: {
        message: expect.stringContaining("Missing 'nickname'"),
        type: 'invalid_request_error',
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: { code: 'invalid_request', status: 400, upstream: true },
      },
    ]);
  });

  test('the cost OpenRouter reports is written to a streaming caller of each API, the figure in the record', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/mistralai/mistral-nemo').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const chat = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          stream_options: { include_usage: true },
          max_completion_tokens: 20,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const chatText = await chat.text();
    const messages = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const messagesText = await messages.text();
    const responses = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          max_output_tokens: 20,
          input: 'Say ok.',
        }),
      }),
    );
    const responsesText = await responses.text();
    await served.close();

    expect([chat.status, messages.status, responses.status]).toEqual([
      200, 200, 200,
    ]);
    const written = [chatText, messagesText, responsesText].map((text) =>
      [...text.matchAll(/"cost":([0-9.e-]+)/g)].map(([, cost]) => Number(cost)),
    );
    expect(written).toEqual(reports.map(({ usage }) => [usage.cost ?? 0]));
    for (const [cost = 0] of written) expect(cost).toBeGreaterThan(0);
  });

  test('a motty that calls a model twice is written the sum of both costs, each in the record', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'twice' }).handle(async ({ prompt }) => {
        const first = await model('openrouter/mistralai/mistral-nemo').complete(
          prompt,
        );
        await first.text();
        return model('openrouter/mistralai/mistral-nemo').complete(prompt);
      }),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'twice',
          max_completion_tokens: 20,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    const [one = 0, other = 0] =
      reports[0]?.calls.map(({ cost }) => cost ?? 0) ?? [];
    expect(reply.status).toBe(200);
    expect(reports[0]?.calls).toHaveLength(2);
    expect(one).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
    expect(reports[0]?.usage.cost).toBeCloseTo(one + other, 12);
    expect(answer).toMatchObject({ usage: { cost: reports[0]?.usage.cost } });
  });

  test("the newest Haiku through the router is held to Anthropic's rule: the temperature is left out, and the record says so", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 20,
          temperature: 0.2,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['temperature.model']);
  });

  test("an OpenAI reasoning model through the router is held to OpenAI's rule: the temperature is left out, and the record says so", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 300,
          temperature: 0.2,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['temperature.model']);
  });

  test('a model of a provider the router has no rule for is sent a temperature, a top-p and a top-k, and nothing is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/google/gemini-2.5-flash-lite').complete({
          ...prompt,
          options: { ...prompt.options, topK: 40 },
        }),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 20,
          temperature: 0.2,
          top_p: 0.9,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("a request longer than the model's window, which OpenRouter tells as a plain 400, is named so in its own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/mistralai/mistral-nemo').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 16,
          messages: [{ role: 'user', content: 'hello '.repeat(200_000) }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(400);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      error: {
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
        message: expect.stringContaining('maximum context length is'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'context_too_long',
          message: expect.stringContaining('maximum context length is'),
          provider: { openrouter: { status: 400, code: 400 } },
          upstream: true,
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  // Holds while the key's credit is under what 128000 output tokens of this model cost.
  test("an output limit the key's credit cannot pay for is a spent quota, told in OpenRouter's words without its link", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-opus-5.5').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 128_000,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(429);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      error: {
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        message: expect.stringContaining('fewer max_tokens'),
      },
    });
    expect(JSON.stringify(answer)).not.toContain('http');
    expect(reports[0]?.error?.message).not.toContain('http');
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'quota_exceeded',
          message: expect.stringContaining('fewer max_tokens'),
          provider: { openrouter: { status: 402, code: 402 } },
          upstream: true,
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test('a cache marker with a lifetime of an hour is taken by Claude through the router, and nothing of it is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
      ),
      () => ({
        models: [openrouter({ key })],
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
          max_tokens: 20,
          system: [
            {
              type: 'text',
              text: `${crypto.randomUUID()} ${'The archive keeps every ledger of the harbour office in order. '.repeat(700)}`,
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]?.cacheWrite).toBeGreaterThan(0);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("a fallback past a name OpenRouter does not know is answered by the next model, which the answer names, at the host's price and not the router's cost", async () => {
    const named: (string | undefined)[] = [];
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(async ({ prompt }) => {
        const reply = await fallback(
          model('openrouter/nobody/no-such-model'),
          model('openrouter/mistralai/mistral-nemo'),
        ).complete(prompt);
        named.push(await reply.model());
        return reply;
      }),
      { text: 'Say ok.', options: { maxTokens: 20 } },
      {
        models: [openrouter({ key })],
        price: (_model, usage) => 1000 + (usage.input ?? 0),
      },
    );

    const [, answered] = calls;
    expect(await answer.finish()).toBe('stop');
    expect(named).toEqual(['openrouter/mistralai/mistral-nemo']);
    expect(calls.map(({ model: called, code }) => [called, code])).toEqual([
      ['openrouter/nobody/no-such-model', 'unknown_model'],
      ['openrouter/mistralai/mistral-nemo', undefined],
    ]);
    expect(answered?.input).toBeGreaterThan(0);
    expect(answered?.cost).toBe(1000 + (answered?.input ?? 0));
    expect(await answer.usage()).toMatchObject({ cost: answered?.cost });
  });
});
