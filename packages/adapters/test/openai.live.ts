import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { openai } from '../src/openai.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { OPENAI_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')('against OpenAI', () => {
  test('the Responses API answers a streaming Chat Completions caller and its usage is in the record', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          max_completion_tokens: 60,
          reasoning_effort: 'minimal',
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
            model: 'openai/gpt-5-nano',
            input: expect.any(Number),
            output: expect.any(Number),
            cached: 0,
            reasoning: 0,
          },
        ],
      },
    ]);
  });

  test('Chat Completions answers an Anthropic Messages caller and its usage is told the Anthropic way', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          thinking: { type: 'disabled' },
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
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: expect.stringMatching(/pong/i) }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: expect.any(Number),
        output_tokens: expect.any(Number),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        calls: [{ model: 'openai/gpt-6-luna', input: expect.any(Number) }],
      },
    ]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('the Responses API calls two tools at once for an Anthropic Messages caller', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
                'What is the weather in Paris and in Tokyo? Call the tool for both cities at once, in parallel.',
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
        {
          type: 'tool_use',
          id: expect.any(String),
          name: 'get_weather',
          input: { city: 'Paris' },
        },
        {
          type: 'tool_use',
          id: expect.any(String),
          name: 'get_weather',
          input: { city: 'Tokyo' },
        },
      ],
      stop_reason: 'tool_use',
    });
  });

  test('an encrypted reasoning item comes back unasked, with its summary, and is taken on the next turn', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
        report: (report) => reports.push(report),
      }),
    );

    const first = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          store: false,
          max_output_tokens: 1200,
          reasoning: { effort: 'high', summary: 'auto' },
          input: [
            {
              role: 'user',
              content:
                'A farmer has 17 rows of 23 trees and cuts 9 trees. How many are left? Reason it through carefully.',
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
          store: false,
          max_output_tokens: 1200,
          reasoning: { effort: 'high', summary: 'auto' },
          input: [
            {
              role: 'user',
              content:
                'A farmer has 17 rows of 23 trees and cuts 9 trees. How many are left? Reason it through carefully.',
            },
            ...items,
            { role: 'user', content: 'Now add 18 to it. Only the number.' },
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
        summary: expect.arrayContaining([
          expect.objectContaining({ type: 'summary_text' }),
        ]),
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
      { outcome: 'completed', calls: [{ reasoning: expect.any(Number) }] },
      { outcome: 'completed' },
    ]);
    expect(reports[1]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('a JSON schema from an Anthropic Messages caller shapes the answer of the Responses API', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(200);
    expect(answer).toMatchObject({
      content: [{ type: 'text', text: '{"city":"Paris","country":"France"}' }],
      stop_reason: 'end_turn',
    });
  });

  test('a marked prefix is written to the cache and then read, and the record counts both', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          text: `Run ${Date.now()}. ${'The archive shelf holds one more ledger. '.repeat(400)}`,
          cache_control: { type: 'ephemeral' },
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
    await first.text();
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
    const answer = await second.json();
    await served.close();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(reports[0]?.calls[0]?.cacheWrite).toBeGreaterThan(1000);
    expect(reports[1]?.calls[0]?.cached).toBeGreaterThan(1000);
    expect(answer).toMatchObject({
      usage: { cache_read_input_tokens: reports[1]?.calls[0]?.cached },
    });
  });

  test('an inline image from an Anthropic Messages caller is seen over Chat Completions', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          max_tokens: 200,
          thinking: { type: 'disabled' },
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    // 64 by 64: the left half red, the right half blue.
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nO3aSwoAMAxCQe9/aXMKF4GBrgOlnxh9aTJd4/Jdl7cBJ+AKecR+Id+oRqYTkxLEHDVKThtoTGRGSkM9V4KtwtjizLEWmbvcafa6gENCI2IS8kkpxayCbkk91ADsgVaB2wCeEFuQM9AfahF2CXxF7kKPwd/5T68fuOzw4mlC0SMAAAAASUVORK5CYII=',
                  },
                },
                {
                  type: 'text',
                  text: 'Which two colours are in this picture? Answer in three words.',
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
      content: [
        {
          type: 'text',
          text: expect.stringMatching(/red.*blue|blue.*red/is),
        },
      ],
    });
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test("a model OpenAI does not know is its 404, told in the caller's format", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/no-such-model-xyz').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(404);
    expect(answer).toMatchObject({
      type: 'error',
      error: { type: 'not_found_error' },
    });
    expect(reports).toMatchObject([
      { outcome: 'failed', error: { code: 'unknown_model', status: 404 } },
    ]);
  });

  // Written as prompt_cache_breakpoint, the marker is refused by every model but the newest with a 400, so it is left out.
  test('a cache marker from an Anthropic Messages caller does not fail a model that has no explicit caching', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          max_tokens: 30,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Say ok.',
                  cache_control: { type: 'ephemeral' },
                },
              ],
            },
          ],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
  });

  // Chat Completions takes a schema loosely unless told strict, the Responses API strictly unless told not, so it is told.
  test('a loose JSON schema from a Chat Completions caller stays loose over the Responses API', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 60,
          reasoning_effort: 'minimal',
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'capital',
              schema: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                  population: { type: 'integer', minimum: 0 },
                },
                required: ['city'],
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
      choices: [{ message: { content: expect.stringContaining('Paris') } }],
    });
  });

  // The Responses API has presence_penalty and frequency_penalty now.
  test('a presence penalty from a Chat Completions caller reaches the Responses API', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 30,
          presence_penalty: 0.5,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
  });

  // OpenAI refuses file data that comes with no filename, and an Anthropic document has none to give, so one is made.
  test('a PDF from an Anthropic Messages caller is read over the Responses API', async () => {
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
                    type: 'base64',
                    media_type: 'application/pdf',
                    // One page that says: The secret word is zebra.
                    data: 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMTQ0XSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NSA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDgwIFRkIChUaGUgc2VjcmV0IHdvcmQgaXMgemVicmEuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM0NiAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQxNgolJUVPRgo=',
                  },
                },
                {
                  type: 'text',
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
      content: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/zebra/i) }),
      ]),
    });
  });

  test("a key the Responses API turns down is told in the SDK's words, whole and streamed, and nothing of it is kept", async () => {
    const secret = 'Qm4vT9xLr2ZbN7cKwE5hYd8JpA3uFs6GtR1oXi0VnMzB';
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key: `sk-proj-${secret}` })],
        report: (report) => reports.push(report),
      }),
    );

    const whole = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_output_tokens: 20,
          input: 'hi',
        }),
      }),
    );
    const streamed = await served.fetch(
      new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          stream: true,
          max_output_tokens: 20,
          input: 'hi',
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
          provider: {
            'openai.responses': { status: 401, code: 'invalid_api_key' },
          },
          upstream: true,
        },
      },
      {
        outcome: 'failed',
        error: {
          code: 'upstream_refused',
          provider: {
            'openai.responses': { status: 401, code: 'invalid_api_key' },
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

  test("a key Chat Completions turns down is told in the SDK's words, whole and streamed, and nothing of it is kept", async () => {
    const secret = 'Qm4vT9xLr2ZbN7cKwE5hYd8JpA3uFs6GtR1oXi0VnMzB';
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key: `sk-proj-${secret}`, api: 'chat-completions' })],
        report: (report) => reports.push(report),
      }),
    );

    const whole = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 20,
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
          max_completion_tokens: 20,
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
          provider: { 'openai.chat': { status: 401, code: 'invalid_api_key' } },
          upstream: true,
        },
      },
      {
        outcome: 'failed',
        error: {
          code: 'upstream_refused',
          provider: { 'openai.chat': { status: 401, code: 'invalid_api_key' } },
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

  test("an author's schema with an optional key, no strictness said, is answered over the Responses API", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete({
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
        models: [openai({ key })],
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
          reasoning_effort: 'minimal',
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

  test("an author's schema with an optional key, no strictness said, is answered over Chat Completions", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete({
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
        models: [openai({ key, api: 'chat-completions' })],
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
          reasoning_effort: 'minimal',
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

  test("the same schema an author calls strict is the Responses API's own 400, told in its words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete({
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
        models: [openai({ key })],
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

  test("the same schema an author calls strict is Chat Completions' own 400, told in its words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete({
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
        models: [openai({ key, api: 'chat-completions' })],
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

  test('a temperature reaches a model that samples over the Responses API, and nothing is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('a reasoning model that never samples answers over the Responses API with the temperature left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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

  test('a model that samples only when it does not reason takes the temperature over the Responses API beside an order not to reason', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.4-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          reasoning_effort: 'none',
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

  test('the same model told to reason answers over the Responses API with the temperature left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.4-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          reasoning_effort: 'low',
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

  test('a temperature above the range is sent over the Responses API as the highest the model takes, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          temperature: 2.5,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['temperature.range']);
  });

  test('an effort asked over the Responses API of a model that cannot reason is left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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

  test('a model that samples unless it reasons takes the temperature over the Responses API from a request that says nothing of reasoning', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.4-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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

  test('a model of the newest behaviour answers over the Responses API with the temperature left out when the request says nothing of reasoning, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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

  test('the same model takes the temperature and both penalties over the Responses API beside an order not to reason', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          reasoning_effort: 'none',
          temperature: 0.2,
          presence_penalty: 0.5,
          frequency_penalty: 0.5,
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

  test.each(['gpt-5.2-pro', 'gpt-5.4-pro', 'gpt-6.1-sol'])(
    '%s, which never samples, answers over the Responses API with every sampling setting left out, and the record says so',
    async (name) => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model(`openai/${name}`).complete(prompt),
        ),
        () => ({
          models: [openai({ key })],
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
            temperature: 0.2,
            top_p: 0.9,
            presence_penalty: 0.5,
            frequency_penalty: 0.5,
            messages: [{ role: 'user', content: 'Say ok.' }],
          }),
        }),
      );
      await reply.text();
      await served.close();

      expect(reply.status).toBe(200);
      expect(
        reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
      ).toEqual([
        'temperature.model',
        'topP.model',
        'presencePenalty.model',
        'frequencyPenalty.model',
      ]);
    },
  );

  test("a model the Responses API does not know is named so in OpenAI's own words, and is not tried again", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/no-such-model-xyz').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(404);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      error: {
        code: 'model_not_found',
        message: expect.stringContaining('no-such-model-xyz'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unknown_model',
          message: expect.stringContaining('does not exist'),
          provider: {
            'openai.responses': { status: 404, code: 'model_not_found' },
          },
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("a prompt longer than the model's window is named so over the Responses API, in OpenAI's own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key })],
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
          messages: [{ role: 'user', content: 'hello '.repeat(260_000) }],
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
        message: expect.stringMatching(/context (?:window|length)/),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'context_too_long',
          message: expect.stringMatching(/context (?:window|length)/),
          provider: {
            'openai.responses': { code: 'context_length_exceeded' },
          },
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("an effort an author states in the words of the Responses API is refused by a model that cannot reason as unsupported, in OpenAI's own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete({
          ...prompt,
          options: {
            ...prompt.options,
            provider: { 'openai.responses': { reasoning: { effort: 'low' } } },
          },
        }),
      ),
      () => ({
        models: [openai({ key })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
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
        code: 'unsupported',
        message: expect.stringContaining('reasoning.effort'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unsupported',
          message: expect.stringContaining('reasoning.effort'),
          provider: { 'openai.responses': { status: 400 } },
          upstream: true,
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test('a temperature an author states in the words of the Responses API is refused by a reasoning model as unsupported, though OpenAI gives it no code', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete({
          ...prompt,
          options: {
            ...prompt.options,
            provider: { 'openai.responses': { temperature: 0.5 } },
          },
        }),
      ),
      () => ({
        models: [openai({ key })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
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
        code: 'unsupported',
        message: expect.stringContaining('temperature'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unsupported',
          message: expect.stringContaining('temperature'),
          provider: {
            'openai.responses': {
              status: 400,
              code: null,
              param: 'temperature',
            },
          },
          upstream: true,
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("an address OpenAI has no API at is the host's setup over the Responses API: a failed upstream that is not tried again", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key, address: 'https://api.openai.com/v0' })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(502);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      error: { type: 'server_error', code: 'upstream_failed' },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'upstream_failed',
          retryable: false,
          provider: { 'openai.responses': { status: 404 } },
        },
      },
    ]);
  });

  test('a temperature reaches a model that samples over Chat Completions, and nothing is reported', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
  });

  test('a reasoning model that never samples answers over Chat Completions with the temperature left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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

  test('a model that samples only when it does not reason takes the temperature over Chat Completions beside an order not to reason', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.4-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          reasoning_effort: 'none',
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

  test('the same model told to reason answers over Chat Completions with the temperature left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.4-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          reasoning_effort: 'low',
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

  test('a temperature above the range is sent over Chat Completions as the highest the model takes, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          temperature: 2.5,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['temperature.range']);
  });

  test('an effort asked over Chat Completions of a model that cannot reason is left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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

  test('a model that samples unless it reasons takes the temperature over Chat Completions from a request that says nothing of reasoning', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.4-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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

  test('a model of the newest behaviour answers over Chat Completions with the temperature left out when the request says nothing of reasoning, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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

  test('the same model takes the temperature and both penalties over Chat Completions beside an order not to reason', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5.6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          reasoning_effort: 'none',
          temperature: 0.2,
          presence_penalty: 0.5,
          frequency_penalty: 0.5,
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

  test('a top-p of zero is sent over Chat Completions as the lowest a model that can reason takes, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-6-luna').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          reasoning_effort: 'none',
          top_p: 0,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    await reply.text();
    await served.close();

    expect(reply.status).toBe(200);
    expect(
      reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
    ).toEqual(['topP.range']);
  });

  test('a search model answers over Chat Completions with the temperature and the effort left out, and the record says so', async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-search-api').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
    ).toEqual(['reasoning.model', 'temperature.model']);
  });

  test("a model Chat Completions does not know is named so in OpenAI's own words, and is not tried again", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/no-such-model-xyz').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(404);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      error: {
        code: 'model_not_found',
        message: expect.stringContaining('no-such-model-xyz'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unknown_model',
          message: expect.stringContaining('does not exist'),
          provider: { 'openai.chat': { status: 404, code: 'model_not_found' } },
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("a prompt longer than the model's window is named so over Chat Completions, in OpenAI's own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4o-mini').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          messages: [{ role: 'user', content: 'hello '.repeat(260_000) }],
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
        message: expect.stringMatching(/context (?:window|length)/),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'context_too_long',
          message: expect.stringMatching(/context (?:window|length)/),
          provider: {
            'openai.chat': { status: 400, code: 'context_length_exceeded' },
          },
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("a temperature an author states in the words of Chat Completions is refused by a reasoning model as unsupported, in OpenAI's own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete({
          ...prompt,
          options: {
            ...prompt.options,
            provider: { 'openai.chat': { temperature: 0.5 } },
          },
        }),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
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
          messages: [{ role: 'user', content: 'Say ok.' }],
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
        code: 'unsupported',
        message: expect.stringContaining('temperature'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'unsupported',
          message: expect.stringContaining('temperature'),
          provider: { 'openai.chat': { status: 400 } },
          upstream: true,
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });

  test("an address OpenAI has no API at is the host's setup over Chat Completions: a failed upstream that is not tried again", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [
          openai({
            key,
            address: 'https://api.openai.com/v0',
            api: 'chat-completions',
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
          max_completion_tokens: 20,
          messages: [{ role: 'user', content: 'Say ok.' }],
        }),
      }),
    );
    const answer = await reply.json();
    await served.close();

    expect(reply.status).toBe(502);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(answer).toMatchObject({
      error: { type: 'server_error', code: 'upstream_failed' },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'upstream_failed',
          retryable: false,
          provider: { 'openai.chat': { status: 404 } },
        },
      },
    ]);
  });

  test("an output limit above the model's own is an invalid request over Chat Completions, in OpenAI's own words", async () => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-5-nano').complete(prompt),
      ),
      () => ({
        models: [openai({ key, api: 'chat-completions' })],
        report: (report) => reports.push(report),
      }),
    );

    const reply = await served.fetch(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'relay',
          max_completion_tokens: 10_000_000,
          messages: [{ role: 'user', content: 'Say ok.' }],
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
        code: 'invalid_request',
        message: expect.stringContaining('at most 128000 completion tokens'),
      },
    });
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'invalid_request',
          status: 400,
          message: expect.stringContaining('at most 128000 completion tokens'),
          provider: { 'openai.chat': { status: 400, code: 'invalid_value' } },
        },
      },
    ]);
    expect(reports[0]?.error?.retryable).not.toBe(true);
  });
});
