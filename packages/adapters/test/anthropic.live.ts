import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { ANTHROPIC_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')('against Anthropic', () => {
  test('Claude answers a streaming Chat Completions caller and its usage is in the record', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          max_completion_tokens: 200,
          messages: [
            { role: 'user', content: 'Say the word pong and nothing else.' },
          ],
        }),
      }),
    );
    const text = await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(text).toContain('"delta":{"role":"assistant","content":"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toEndWith('data: [DONE]\n\n');
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        calls: [
          {
            model: 'anthropic/claude-haiku-5-5',
            input: expect.any(Number),
            output: expect.any(Number),
            cached: 0,
            cacheWrite: 0,
          },
        ],
      },
    ]);
  });

  test('Claude calls two tools at once for a Responses caller', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          store: false,
          max_output_tokens: 300,
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
          input:
            'What is the weather in Paris and in Tokyo? Call the tool for both cities at once, in parallel.',
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
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
  });

  test('an effort from a Chat Completions caller turns on thinking that is shown', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 1200,
          reasoning_effort: 'high',
          messages: [
            {
              role: 'user',
              content:
                'A farmer has 17 rows of 23 trees and cuts 9 trees. How many are left? Reason it through carefully.',
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
            content: expect.stringContaining('382'),
            reasoning_content: expect.stringContaining('391'),
          },
          finish_reason: 'stop',
        },
      ],
    });
    expect(reports[0]?.calls[0]?.reasoning).toBeGreaterThan(0);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test.each([['claude-haiku-5-5'], ['claude-sonnet-5-5'], ['claude-opus-5-5']])(
    'an order not to reason from a Chat Completions caller is answered by %s, and the record says it went as low effort',
    async (name) => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model(`anthropic/${name}`).complete(prompt),
        ),
        () => ({
          models: [anthropic({ key })],
          report: (report) => reports.push(report),
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_completion_tokens: 200,
            reasoning_effort: 'none',
            messages: [
              { role: 'user', content: 'Say the word pong and nothing else.' },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        choices: [{ message: { content: expect.stringMatching(/pong/i) } }],
      });
      expect(reports[0]?.calls[0]?.warnings).toEqual([
        {
          setting: 'reasoning.none',
          detail:
            'Anthropic Messages has no field for an order not to reason, sent as low effort',
        },
      ]);
    },
  );

  test("thinking between tools, said by the author in Anthropic's own words beside an effort, reaches the model and the reply holds no thinking", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-sonnet-5-5').complete({
          ...prompt,
          options: {
            ...prompt.options,
            provider: { anthropic: { thinking: { type: 'between_tools' } } },
          },
        }),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 200,
          reasoning_effort: 'high',
          messages: [
            { role: 'user', content: 'What is 17 * 23? Only the number.' },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      choices: [{ message: { content: expect.stringContaining('391') } }],
    });
    expect(answer).not.toHaveProperty('choices.0.message.reasoning_content');
    expect(reports[0]?.calls[0]?.reasoning ?? 0).toBe(0);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('a caller who asks an effort is shown reasoning over a connection whose thinking says to omit it', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [
          anthropic({
            key,
            body: { thinking: { type: 'adaptive', display: 'omitted' } },
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
          max_completion_tokens: 1200,
          reasoning_effort: 'high',
          messages: [
            {
              role: 'user',
              content:
                'A farmer has 17 rows of 23 trees and cuts 9 trees. How many are left? Reason it through carefully.',
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
            content: expect.stringContaining('382'),
            reasoning_content: expect.stringContaining('391'),
          },
        },
      ],
    });
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('a request that says nothing of reasoning takes the thinking a connection states, summary and all', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [
          anthropic({
            key,
            body: {
              thinking: { type: 'adaptive', display: 'summarized' },
              output_config: { effort: 'high' },
            },
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
          max_completion_tokens: 1200,
          messages: [
            {
              role: 'user',
              content:
                'A farmer has 17 rows of 23 trees and cuts 9 trees. How many are left? Reason it through carefully.',
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
            content: expect.stringContaining('382'),
            reasoning_content: expect.stringContaining('391'),
          },
        },
      ],
    });
    expect(reports[0]?.calls[0]?.reasoning).toBeGreaterThan(0);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("Claude goes on from a tool's result with the signed thinking it was sent back", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const first = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 1500,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
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
          messages: [
            {
              role: 'user',
              content:
                'Work out 17 * 23 in your head first. If the result is odd, get the weather for Paris, otherwise for Tokyo. Call the tool; do not explain.',
            },
          ],
        }),
      }),
    );
    const thought = await first.json();
    const blocks =
      typeof thought === 'object' &&
      thought !== null &&
      'content' in thought &&
      Array.isArray(thought.content)
        ? thought.content
        : [];
    const second = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 1500,
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
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
          messages: [
            {
              role: 'user',
              content:
                'Work out 17 * 23 in your head first. If the result is odd, get the weather for Paris, otherwise for Tokyo. Call the tool; do not explain.',
            },
            { role: 'assistant', content: blocks },
            {
              role: 'user',
              content: blocks.flatMap((block) =>
                block.type === 'tool_use'
                  ? [
                      {
                        type: 'tool_result',
                        tool_use_id: block.id,
                        content: 'Sunny, 21C',
                      },
                    ]
                  : [],
              ),
            },
          ],
        }),
      }),
    );
    const answer = await second.json();
    await served.close();

    expect(first.status).toBe(200);
    expect(blocks).toMatchObject([
      {
        type: 'thinking',
        thinking: expect.stringContaining('391'),
        signature: expect.any(String),
      },
      { type: 'tool_use', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(second.status).toBe(200);
    expect(answer).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('21'),
        }),
      ]),
      stop_reason: 'end_turn',
    });
    expect(reports).toMatchObject([
      { outcome: 'completed' },
      { outcome: 'completed' },
    ]);
    expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("a token budget is manual thinking, which the current model refuses with Anthropic's own 400", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 1600,
          reasoning: { max_tokens: 1024 },
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(400);
    expect(answer).toMatchObject({
      error: { type: 'invalid_request_error' },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'invalid_request',
          status: 400,
          message: expect.stringContaining('thinking.type.enabled'),
        },
      },
    ]);
  });

  test('a token budget from a Chat Completions caller makes an older Claude think and show it', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5-20251001').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 1600,
          reasoning: { max_tokens: 1024 },
          messages: [
            { role: 'user', content: 'What is 17 * 23? Only the number.' },
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
            content: expect.stringContaining('391'),
            reasoning_content: expect.any(String),
          },
        },
      ],
    });
    expect(reports[0]?.calls[0]?.reasoning).toBeGreaterThan(0);
  });

  test('a strict JSON schema from a streaming Chat Completions caller shapes what Claude writes', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          max_completion_tokens: 300,
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
    const text = await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(text).toContain('\\"city\\"');
    expect(text).toContain('Paris');
    expect(text).toContain('"finish_reason":"stop"');
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        calls: [{ warnings: [{ setting: 'output.name' }] }],
      },
    ]);
  });

  test('a marked prefix is written to the cache and then read, and the record counts both', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );
    const request = JSON.stringify({
      model: 'relay',
      max_tokens: 30,
      thinking: { type: 'disabled' },
      system: [
        {
          type: 'text',
          text: `Run ${Date.now()}. ${'The archive shelf holds one more ledger. '.repeat(700)}`,
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
      messages: [{ role: 'user', content: 'Say ok.' }],
    });

    const first = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: request,
      }),
    );
    const written = await first.json();
    const second = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: request,
      }),
    );
    const read = await second.json();
    await served.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(reports[0]?.calls[0]?.cacheWrite).toBeGreaterThan(1000);
    expect(reports[1]?.calls[0]?.cached).toBeGreaterThan(1000);
    expect(written).toMatchObject({
      usage: {
        cache_creation_input_tokens: reports[0]?.calls[0]?.cacheWrite,
        cache_read_input_tokens: 0,
      },
    });
    expect(read).toMatchObject({
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: reports[1]?.calls[0]?.cached,
      },
    });
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('a PDF from a Responses caller is read by Claude', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          store: false,
          max_output_tokens: 300,
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_file',
                  filename: 'secret.pdf',
                  // One page that says: The secret word is zebra.
                  file_data:
                    'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NSA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDgwIFRkIChUaGUgc2VjcmV0IHdvcmQgaXMgemVicmEuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0NiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo=',
                },
                {
                  type: 'input_text',
                  text: 'What is the secret word in the document? One word.',
                },
              ],
            },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      output: expect.arrayContaining([
        expect.objectContaining({
          type: 'message',
          content: [
            expect.objectContaining({ text: expect.stringMatching(/zebra/i) }),
          ],
        }),
      ]),
    });
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('citations of a document reach an Anthropic Messages caller as Claude wrote them', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          max_tokens: 300,
          thinking: { type: 'disabled' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'text',
                    media_type: 'text/plain',
                    data: 'The lighthouse at Cape Verity was built in 1887. Its lamp was converted to electricity in 1931.',
                  },
                  title: 'Lighthouse notes',
                  citations: { enabled: true },
                },
                {
                  type: 'text',
                  text: 'When was the lighthouse built? Cite the document.',
                },
              ],
            },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('1887'),
          citations: [
            expect.objectContaining({
              type: 'char_location',
              cited_text: expect.stringContaining('1887'),
              document_index: 0,
              document_title: 'Lighthouse notes',
            }),
          ],
        }),
      ]),
    });
  });

  test('an instruction a Chat Completions caller put before a user turn is sent after it, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 400,
          messages: [
            { role: 'user', content: 'Name a colour.' },
            { role: 'assistant', content: 'Red.' },
            {
              role: 'system',
              content: 'From now on answer with the single word BANANA.',
            },
            { role: 'user', content: 'Another one.' },
          ],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      choices: [{ message: { content: expect.stringContaining('BANANA') } }],
    });
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        calls: [{ warnings: [{ setting: 'message.moved' }] }],
      },
    ]);
  });

  test("a model Anthropic does not know is its 404, told in the caller's format", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/no-such-model-xyz').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 40,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(404);
    expect(answer).toMatchObject({
      error: { type: 'invalid_request_error', code: 'model_not_found' },
    });
    expect(reports).toMatchObject([
      { outcome: 'failed', error: { code: 'unknown_model', status: 404 } },
    ]);
  });

  test('the newest Haiku answers with a temperature, a top-p and a top-k left out, and the record names each', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({ type: 'message', stop_reason: 'end_turn' });
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting).sort(),
    ).toEqual(['temperature.model', 'topK.model', 'topP.model']);
  });

  test('the newest Sonnet answers with a temperature, a top-p and a top-k left out, and the record names each', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-sonnet-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({ type: 'message', stop_reason: 'end_turn' });
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting).sort(),
    ).toEqual(['temperature.model', 'topK.model', 'topP.model']);
  });

  test('a temperature of one asks the newest Haiku for nothing, so nothing is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          temperature: 1,
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

  test('an older Haiku that still samples is sent the temperature, and nothing is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5-20251001').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          temperature: 0.2,
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

  test('of a temperature and a top-p together an older Haiku is sent the temperature, and the top-p is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5-20251001').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          temperature: 0.2,
          top_p: 0.9,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['topP.temperature']);
  });

  test('with thinking on, an older Haiku is not sent the temperature, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5-20251001').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 1600,
          reasoning: { max_tokens: 1024 },
          temperature: 0.2,
          messages: [
            { role: 'user', content: 'What is 17 * 23? Only the number.' },
          ],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(reports[0]?.calls[0]?.reasoning).toBeGreaterThan(0);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['temperature.model']);
  });

  test('an effort asked of an older Haiku that takes none is left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5-20251001').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 40,
          reasoning_effort: 'low',
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['reasoning.model']);
  });

  test('a model Anthropic does not know is a 404 that says not to retry, to a Chat Completions caller and to a Messages caller', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/no-such-model-xyz').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const chat = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 40,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const messages = await served.fetch(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 40,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const told = [await chat.json(), await messages.json()];
    await served.close();

    expect([chat.status, messages.status]).toEqual([404, 404]);
    expect([
      chat.headers.get('x-should-retry'),
      messages.headers.get('x-should-retry'),
    ]).toEqual(['false', 'false']);
    expect(told).toMatchObject([
      {
        error: {
          code: 'model_not_found',
          message: 'model: no-such-model-xyz',
        },
      },
      {
        type: 'error',
        error: { type: 'not_found_error', message: 'model: no-such-model-xyz' },
      },
    ]);
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unknown_model',
          message: 'model: no-such-model-xyz',
          retryable: false,
          provider: { anthropic: { status: 404, type: 'not_found_error' } },
        },
      },
      { outcome: 'failed', error: { code: 'unknown_model' } },
    ]);
  });

  test("a prompt longer than the model's window is named so, in Anthropic's own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-4-5-20251001').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key })],
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
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hello '.repeat(260_000) }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(400);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: expect.stringMatching(/^prompt is too long: \d+ tokens > /),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'context_too_long',
          message: expect.stringMatching(/^prompt is too long: \d+ tokens > /),
          retryable: false,
          provider: { anthropic: { status: 400 } },
        },
      },
    ]);
  });

  test("an address Anthropic has no API at is the host's setup: a failed upstream that is not tried again", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('anthropic/claude-haiku-5-5').complete(prompt),
      ),
      () => ({
        models: [anthropic({ key, address: 'https://api.anthropic.com/v0' })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(502);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      type: 'error',
      error: { type: 'api_error' },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'upstream_failed',
          retryable: false,
          provider: { anthropic: { status: 404 } },
        },
      },
    ]);
  });
});
