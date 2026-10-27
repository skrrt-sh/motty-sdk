import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { openai } from '../src/openai.ts';

const answered = `event: response.created
data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-5","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":" there"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}

`;

test('an api it does not speak fails when made, in words that name the option', () => {
  // @ts-expect-error the two it speaks are the type
  expect(() => openai({ key: 'sk-host', api: 'completions' })).toThrow(
    /^The openai adapter was given an api that is none: it takes 'responses' or 'chat-completions'$/,
  );
});

test('a call goes to the Responses API with the key and the provider name', async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
        body: await request.json(),
      });
      return new Response(answered, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const { models } = adapted([
    openai({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openai/gpt-5',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      path: '/v1/responses',
      key: 'Bearer sk-host',
      body: { model: 'gpt-5', stream: true },
    },
  ]);
  expect(events).toMatchObject([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 9, output: 2 },
      id: 'resp_1',
      model: 'gpt-5',
    },
  ]);
});

test.each([
  [
    'OpenAI`s breakpoint, which has no lifetime',
    { breakpoints: true },
    { prompt_cache_breakpoint: { mode: 'explicit' } },
    ['cache.ttl'],
  ],
  ['nothing, as OpenAI`s own models take none', {}, {}, ['cache.ttl', 'cache']],
] as const)(
  'a cache marker is written as %s, where the host says so',
  async (_, marks, written, leftOut) => {
    for (const api of ['responses', 'chat-completions'] as const) {
      const sent: unknown[] = [];
      using upstream = Bun.serve({
        port: 0,
        fetch: async (request) => {
          sent.push(await request.json());
          return new Response(
            api === 'responses'
              ? answered
              : 'data: {"id":"chatcmpl-1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      const { models } = adapted([
        openai({ key: 'sk-host', address: `${upstream.url}v1`, api, ...marks }),
      ]);

      const events = await Array.fromAsync(
        models(
          'openai/gpt-5',
          {
            messages: [
              {
                role: 'user',
                parts: [
                  { type: 'text', text: 'Stable', cache: { ttl: '1h' } },
                  { type: 'text', text: 'hi' },
                ],
              },
            ],
          },
          AbortSignal.timeout(5000),
        ),
      );

      const text = api === 'responses' ? 'input_text' : 'text';
      const said = [
        {
          role: 'user',
          content: [
            { type: text, text: 'Stable', ...written },
            { type: text, text: 'hi' },
          ],
        },
      ];
      expect(sent).toEqual([
        expect.objectContaining(
          api === 'responses'
            ? { input: [{ type: 'message', ...said[0] }] }
            : { messages: said },
        ),
      ]);
      const finish = events.at(-1);
      if (finish?.type !== 'finish') throw new Error('The call did not finish');
      expect((finish.warnings ?? []).map(({ setting }) => setting)).toEqual([
        ...leftOut,
      ]);
    }
  },
);

test('what names the host`s account is cut from a Responses failure the caller is told, and kept for the host', async () => {
  const said =
    'Rate limit reached for gpt-4o in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s. Visit https://platform.openai.com/account/rate-limits to learn more.';
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { message: said, code: 'rate_limit_exceeded' } },
        { status: 429 },
      ),
  });
  const { models } = adapted([
    openai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openai/gpt-4o',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        message:
          'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s.',
        provider: { 'openai.responses': { message: said } },
      },
    },
  ]);
});

test('a Chat Completions upstream`s failure is cut the same, in a body and inside a stream', async () => {
  const error = {
    message:
      'Rate limit reached for gpt-4o in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on requests per min (RPM): Limit 500, Used 500, Requested 1.',
    code: 'rate_limit_exceeded',
  };
  let asked = 0;
  using upstream = Bun.serve({
    port: 0,
    fetch: () => {
      asked += 1;
      return asked === 1
        ? Response.json({ error }, { status: 429 })
        : new Response(`data: ${JSON.stringify({ error })}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
    },
  });
  const { models } = adapted([
    openai({
      key: 'sk-host',
      address: upstream.url.origin,
      api: 'chat-completions',
    }),
  ]);

  for (const _ of ['a body', 'a stream']) {
    const events = await Array.fromAsync(
      models(
        'openai/gpt-4o',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'rate_limited',
        message:
          'Rate limit reached for gpt-4o on requests per min (RPM): Limit 500, Used 500, Requested 1.',
        provider: { 'openai.chat': { message: error.message } },
      },
    });
  }
});
