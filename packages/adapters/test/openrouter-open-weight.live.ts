import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { run } from '@mottyjs/test';
import { openrouter } from '../src/openrouter.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { OPENROUTER_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')(
  'open-weight models through OpenRouter',
  () => {
    test('the reasoning of DeepSeek V3.2 comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/deepseek/deepseek-v3.2').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    // One of the router's providers writes this model's tool call into the text when it reasons, so the case names a provider that does not.
    test('a tool call of DeepSeek V3.2 is read whole, and its result is taken back with the reasoning that came before it', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/deepseek/deepseek-v3.2').complete(prompt),
        ),
        () => ({
          models: [
            openrouter({ key, body: { provider: { only: ['siliconflow'] } } }),
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
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
              },
            ],
          }),
        }),
      );
      const called = await first.json();
      const message =
        typeof called === 'object' &&
        called !== null &&
        'choices' in called &&
        Array.isArray(called.choices)
          ? called.choices[0]?.message
          : undefined;
      const second = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
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
      await second.text();
      await served.close();

      expect(first.status).toBe(200);
      expect(message).toMatchObject({
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
      });
      expect(
        JSON.parse(message?.tool_calls?.[0]?.function?.arguments),
      ).toMatchObject({ city: expect.any(String) });
      expect(String(message?.content ?? '')).not.toMatch(/<\/?think/);
      expect(second.status).toBe(200);
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
    });

    test('DeepSeek V3.2 told not to reason answers with no reasoning', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/deepseek/deepseek-v3.2').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());

      expect(chunks.filter(({ type }) => type === 'reasoning')).toEqual([]);
      expect(await answer.text()).toMatch(/\S/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('the reasoning of Kimi K2.6 comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/moonshotai/kimi-k2.6').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('a tool call of Kimi K2.6 is read whole, and its result is taken back with the reasoning that came before it', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/moonshotai/kimi-k2.6').complete(prompt),
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
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
              },
            ],
          }),
        }),
      );
      const called = await first.json();
      const message =
        typeof called === 'object' &&
        called !== null &&
        'choices' in called &&
        Array.isArray(called.choices)
          ? called.choices[0]?.message
          : undefined;
      const second = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
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
      await second.text();
      await served.close();

      expect(first.status).toBe(200);
      expect(message).toMatchObject({
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
      });
      expect(
        JSON.parse(message?.tool_calls?.[0]?.function?.arguments),
      ).toMatchObject({ city: expect.any(String) });
      expect(String(message?.content ?? '')).not.toMatch(/<\/?think/);
      expect(second.status).toBe(200);
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
    });

    test('Kimi K2.6 told not to reason answers with no reasoning', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/moonshotai/kimi-k2.6').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());

      expect(chunks.filter(({ type }) => type === 'reasoning')).toEqual([]);
      expect(await answer.text()).toMatch(/\S/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('the reasoning of GLM 4.6 comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/z-ai/glm-4.6').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('a tool call of GLM 4.6 is read whole, and its result is taken back with the reasoning that came before it', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/z-ai/glm-4.6').complete(prompt),
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
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
              },
            ],
          }),
        }),
      );
      const called = await first.json();
      const message =
        typeof called === 'object' &&
        called !== null &&
        'choices' in called &&
        Array.isArray(called.choices)
          ? called.choices[0]?.message
          : undefined;
      const second = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
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
      await second.text();
      await served.close();

      expect(first.status).toBe(200);
      expect(message).toMatchObject({
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
      });
      expect(
        JSON.parse(message?.tool_calls?.[0]?.function?.arguments),
      ).toMatchObject({ city: expect.any(String) });
      expect(String(message?.content ?? '')).not.toMatch(/<\/?think/);
      expect(second.status).toBe(200);
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
    });

    test('GLM 4.6 told not to reason answers with no reasoning', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/z-ai/glm-4.6').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());

      expect(chunks.filter(({ type }) => type === 'reasoning')).toEqual([]);
      expect(await answer.text()).toMatch(/\S/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('the reasoning of Qwen 3.7 Plus comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/qwen/qwen3.7-plus').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('a tool call of Qwen 3.7 Plus is read whole, and its result is taken back with the reasoning that came before it', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/qwen/qwen3.7-plus').complete(prompt),
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
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
              },
            ],
          }),
        }),
      );
      const called = await first.json();
      const message =
        typeof called === 'object' &&
        called !== null &&
        'choices' in called &&
        Array.isArray(called.choices)
          ? called.choices[0]?.message
          : undefined;
      const second = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
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
      await second.text();
      await served.close();

      expect(first.status).toBe(200);
      expect(message).toMatchObject({
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
      });
      expect(
        JSON.parse(message?.tool_calls?.[0]?.function?.arguments),
      ).toMatchObject({ city: expect.any(String) });
      expect(String(message?.content ?? '')).not.toMatch(/<\/?think/);
      expect(second.status).toBe(200);
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
    });

    test('Qwen 3.7 Plus told not to reason answers with no reasoning', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/qwen/qwen3.7-plus').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());

      expect(chunks.filter(({ type }) => type === 'reasoning')).toEqual([]);
      expect(await answer.text()).toMatch(/\S/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('the reasoning of MiniMax M2.7 comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/minimax/minimax-m2.7').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('a tool call of MiniMax M2.7 is read whole, and its result is taken back with the reasoning that came before it', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/minimax/minimax-m2.7').complete(prompt),
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
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
              },
            ],
          }),
        }),
      );
      const called = await first.json();
      const message =
        typeof called === 'object' &&
        called !== null &&
        'choices' in called &&
        Array.isArray(called.choices)
          ? called.choices[0]?.message
          : undefined;
      const second = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
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
      await second.text();
      await served.close();

      expect(first.status).toBe(200);
      expect(message).toMatchObject({
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
      });
      expect(
        JSON.parse(message?.tool_calls?.[0]?.function?.arguments),
      ).toMatchObject({ city: expect.any(String) });
      expect(String(message?.content ?? '')).not.toMatch(/<\/?think/);
      expect(second.status).toBe(200);
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
    });

    test("MiniMax M2.7 always reasons, so an order not to reason fails as unsupported in the router's own words", async () => {
      const ran = run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/minimax/minimax-m2.7').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );

      await expect(ran).rejects.toMatchObject({
        code: 'unsupported',
        status: 400,
        message:
          'Reasoning is mandatory for this endpoint and cannot be disabled.',
        retryable: false,
        upstream: true,
      });
    });

    test('the reasoning of gpt-oss-120b comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-oss-120b').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test('a tool call of gpt-oss-120b is read whole, and its result is taken back with the reasoning that came before it', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-oss-120b').complete(prompt),
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
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
              },
            ],
          }),
        }),
      );
      const called = await first.json();
      const message =
        typeof called === 'object' &&
        called !== null &&
        'choices' in called &&
        Array.isArray(called.choices)
          ? called.choices[0]?.message
          : undefined;
      const second = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 1500,
            reasoning_effort: 'low',
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
                  'What is the weather in Paris right now? Call the tool to find out.',
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
      await second.text();
      await served.close();

      expect(first.status).toBe(200);
      expect(message).toMatchObject({
        tool_calls: [
          {
            id: expect.any(String),
            type: 'function',
            function: { name: 'get_weather' },
          },
        ],
      });
      expect(
        JSON.parse(message?.tool_calls?.[0]?.function?.arguments),
      ).toMatchObject({ city: expect.any(String) });
      expect(String(message?.content ?? '')).not.toMatch(/<\/?think/);
      expect(second.status).toBe(200);
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
    });

    test("gpt-oss-120b always reasons, so an order not to reason fails as unsupported in the router's own words", async () => {
      const ran = run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-oss-120b').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );

      await expect(ran).rejects.toMatchObject({
        code: 'unsupported',
        status: 400,
        message:
          'Reasoning is mandatory for this endpoint and cannot be disabled.',
        retryable: false,
        upstream: true,
      });
    });

    test('the reasoning of DeepSeek R1 comes as reasoning and none of it in the text, counted with a cost', async () => {
      const { answer, calls } = await run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/deepseek/deepseek-r1-0528').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
          options: { maxTokens: 1500, reasoning: { effort: 'low' } },
        },
        { models: [openrouter({ key })] },
      );
      const chunks = await Array.fromAsync(answer.chunks());
      const thought = chunks
        .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
        .join('');

      expect(thought).toMatch(/\S/);
      expect(thought).not.toMatch(/<\/?think/);
      expect(await answer.text()).not.toMatch(/<\/?think/);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toBeGreaterThan(0);
      expect(calls[0]?.output).toBeGreaterThan(0);
      expect(calls[0]?.cost).toBeGreaterThan(0);
      expect(calls[0]).not.toHaveProperty('code');
    });

    test("DeepSeek R1 always reasons, so an order not to reason fails as unsupported in the router's own words", async () => {
      const ran = run(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/deepseek/deepseek-r1-0528').complete(prompt),
        ),
        {
          text: 'What is 17 * 23? Answer in one short sentence.',
          options: { maxTokens: 300, reasoning: { effort: 'none' } },
        },
        { models: [openrouter({ key })] },
      );

      await expect(ran).rejects.toMatchObject({
        code: 'unsupported',
        status: 400,
        message:
          'Reasoning is mandatory for this endpoint and cannot be disabled.',
        retryable: false,
        upstream: true,
      });
    });
  },
);
