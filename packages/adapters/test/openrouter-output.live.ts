import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { openrouter } from '../src/openrouter.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { OPENROUTER_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')(
  'structured output, tool calls and endings against OpenRouter',
  () => {
    test("an Anthropic Messages caller's JSON schema is kept by an OpenAI model, streamed", async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-4.1-nano').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
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
            stream: true,
            max_tokens: 80,
            output_config: {
              format: {
                type: 'json_schema',
                schema: {
                  type: 'object',
                  properties: {
                    city: { type: 'string' },
                    country: { type: 'string' },
                  },
                  required: ['city', 'country'],
                  additionalProperties: false,
                },
              },
            },
            messages: [
              { role: 'user', content: 'Give the capital of France as JSON.' },
            ],
          }),
        }),
      );
      const text = await reply.text();
      await served.close();

      expect(reply.status).toBe(200);
      // The object comes in pieces, each a JSON string inside its event.
      const written = [
        ...text.matchAll(/"type":"text_delta","text":("(?:[^"\\]|\\.)*")/g),
      ]
        .map(([, piece = '""']) => JSON.parse(piece))
        .join('');
      expect(JSON.parse(written)).toEqual({ city: 'Paris', country: 'France' });
      expect(text).toContain('"stop_reason":"end_turn"');
    });

    test("a Chat Completions caller's strict JSON schema is kept by Claude over Anthropic Messages, and its name is reported left out", async () => {
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
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 300,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'capital',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    city: { type: 'string' },
                    country: { type: 'string' },
                  },
                  required: ['city', 'country'],
                  additionalProperties: false,
                },
              },
            },
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
                /^\s*\{\s*"city"\s*:\s*"Paris"\s*,\s*"country"\s*:\s*"France"\s*\}\s*$/,
              ),
            },
            finish_reason: 'stop',
          },
        ],
      });
      expect(reports).toMatchObject([
        {
          outcome: 'completed',
          calls: [{ warnings: [{ setting: 'output.name' }] }],
        },
      ]);
    });

    test('two tool calls made in one turn reach a Responses caller, and both results go back', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-4.1-nano').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
          report: (report) => reports.push(report),
        }),
      );

      const first = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_output_tokens: 200,
            tools: [
              {
                type: 'function',
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
            input: [
              {
                role: 'user',
                content:
                  'What is the weather in Paris and in Tokyo? Call get_weather once per city, both calls in this one turn.',
              },
            ],
          }),
        }),
      );
      const asked = await first.json();
      const items =
        typeof asked === 'object' &&
        asked !== null &&
        'output' in asked &&
        Array.isArray(asked.output)
          ? asked.output
          : [];
      const second = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_output_tokens: 120,
            tools: [
              {
                type: 'function',
                name: 'get_weather',
                description: 'Get the weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
            input: [
              {
                role: 'user',
                content:
                  'What is the weather in Paris and in Tokyo? Call get_weather once per city, both calls in this one turn.',
              },
              ...items,
              ...items.flatMap((item) =>
                typeof item === 'object' &&
                item !== null &&
                'call_id' in item &&
                'arguments' in item &&
                typeof item.arguments === 'string'
                  ? [
                      {
                        type: 'function_call_output',
                        call_id: item.call_id,
                        output: item.arguments.includes('Paris')
                          ? '{"temp_c":11}'
                          : '{"temp_c":29}',
                      },
                    ]
                  : [],
              ),
            ],
          }),
        }),
      );
      const answer = await second.json();
      await served.close();

      expect(first.status).toBe(200);
      expect(asked).toMatchObject({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: expect.any(String),
            name: 'get_weather',
            arguments: expect.stringContaining('Paris'),
          },
          {
            type: 'function_call',
            call_id: expect.any(String),
            name: 'get_weather',
            arguments: expect.stringContaining('Tokyo'),
          },
        ],
      });
      expect(second.status).toBe(200);
      expect(answer).toMatchObject({
        output: [
          {
            type: 'message',
            content: [
              { text: expect.stringMatching(/11[\s\S]*29|29[\s\S]*11/) },
            ],
          },
        ],
      });
      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
      expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
    });

    test("a named tool is called, its arguments streamed to an Anthropic Messages caller as one block's fragments", async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-4.1-nano').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
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
            stream: true,
            max_tokens: 120,
            tool_choice: { type: 'tool', name: 'get_weather' },
            tools: [
              {
                name: 'get_weather',
                description: 'Get the weather for a city',
                input_schema: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                  required: ['city'],
                },
              },
            ],
            messages: [{ role: 'user', content: 'Say hello to Paris.' }],
          }),
        }),
      );
      const text = await reply.text();
      await served.close();

      expect(reply.status).toBe(200);
      const events = text
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line): unknown => JSON.parse(line.slice(6)));
      expect(events).toContainEqual({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: expect.any(String),
          name: 'get_weather',
          input: {},
        },
      });
      expect(events).toContainEqual({ type: 'content_block_stop', index: 0 });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'message_delta',
          delta: expect.objectContaining({ stop_reason: 'tool_use' }),
        }),
      );
      const written = [
        ...text.matchAll(
          /"index":0,"delta":\{"type":"input_json_delta","partial_json":("(?:[^"\\]|\\.)*")/g,
        ),
      ]
        .map(([, piece = '""']) => JSON.parse(piece))
        .join('');
      expect(JSON.parse(written)).toEqual({ city: expect.any(String) });
    });

    test('an output limit met inside reasoning leaves a Responses caller the reasoning so far, marked incomplete', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/deepseek/deepseek-v4-flash').complete(prompt),
        ),
        () => ({
          models: [
            // This provider answers past the limit it was sent.
            openrouter({
              key,
              body: { provider: { ignore: ['SiliconFlow'] } },
            }),
          ],
          report: (report) => reports.push(report),
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_output_tokens: 40,
            reasoning: { effort: 'high', summary: 'auto' },
            input:
              'Prove that there are infinitely many primes, thinking very carefully first.',
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        // Some of the router's providers send a blank text before they reason.
        output: expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', status: 'incomplete' }),
        ]),
      });
      expect(reports).toMatchObject([
        {
          outcome: 'completed',
          calls: [
            { output: expect.any(Number), reasoning: expect.any(Number) },
          ],
        },
      ]);
    });

    // OpenRouter says `stop` for both endings and names the sequence only in
    // `native_finish_reason`.
    test("a stop sequence an Anthropic Messages caller set is the reason it is given over OpenRouter's Chat Completions", async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
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
            stop_sequences: ['gamma'],
            messages: [
              {
                role: 'user',
                content: 'Write exactly: alpha beta gamma delta epsilon',
              },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('beta') }],
        stop_reason: 'stop_sequence',
      });
    });
  },
);
