import { expect, test } from 'bun:test';
import {
  answer,
  MottyError,
  model,
  motty,
  Overloaded,
  RateLimited,
  think,
} from '@mottyjs/core';
import {
  hosted,
  type ModelAdapter,
  type Report,
  toFacts,
} from '@mottyjs/core/host';
import { fake, on } from '@mottyjs/test';
import { chatCompletions, messages, responses, serve } from '../src/index.ts';
import { parsed } from '../src/sse.ts';

const gpt = model('openai/gpt');

const coder = motty({ name: 'coder' }).handle(({ prompt }) =>
  gpt.complete(prompt),
);

class EmptyPrompt extends MottyError.define('empty_prompt', 422) {}

function ask(
  path: string,
  stream: boolean,
  headers: { [name: string]: string } = {},
): Request {
  const messages = [{ role: 'user', content: 'Why does this deadlock?' }];
  return new Request(`http://motty.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(
      path === '/v1/responses'
        ? { model: 'coder', stream, input: 'Why does this deadlock?' }
        : path === '/v1/messages'
          ? { model: 'coder', stream, messages, max_tokens: 256 }
          : { model: 'coder', stream, messages },
    ),
  });
}

async function sent(reply: Response) {
  if (reply.body === null) return [];
  const events = await Array.fromAsync(parsed(reply.body));
  return events.map(({ event, data }) => ({
    event,
    data: data === '[DONE]' ? data : JSON.parse(data),
  }));
}

function answering() {
  const models = fake(
    on(gpt, [
      { type: 'text', text: 'Two threads take ' },
      { type: 'text', text: 'the locks in opposite order.' },
    ]),
  );
  return { models, served: serve(coder, () => ({ models: [models] })) };
}

test('Chat Completions, whole: the motty answers and the model saw the prompt', async () => {
  const { models, served } = answering();

  const reply = await served.fetch(ask('/v1/chat/completions', false));

  expect(reply.status).toBe(200);
  expect(reply.headers.get('content-type')).toStartWith('application/json');
  expect(await reply.json()).toMatchObject({
    id: expect.stringMatching(/^chatcmpl-/),
    object: 'chat.completion',
    model: 'coder',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Two threads take the locks in opposite order.',
        },
        finish_reason: 'stop',
      },
    ],
  });
  expect(models.sent(gpt)).toMatchObject([
    { messages: [{ role: 'user', text: 'Why does this deadlock?' }] },
  ]);
});

test('Chat Completions, streamed: chunks, then the end mark', async () => {
  const { served } = answering();

  const reply = await served.fetch(ask('/v1/chat/completions', true));

  expect(reply.status).toBe(200);
  expect(reply.headers.get('content-type')).toBe('text/event-stream');
  expect(reply.headers.get('cache-control')).toBe('no-cache');
  const events = await sent(reply);
  expect(events).toMatchObject([
    { data: { choices: [{ delta: { content: 'Two threads take ' } }] } },
    {
      data: {
        choices: [{ delta: { content: 'the locks in opposite order.' } }],
      },
    },
    { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
    { data: '[DONE]' },
  ]);
  expect(events[0]?.data).toMatchObject({
    object: 'chat.completion.chunk',
    model: 'coder',
  });
});

test('Responses, whole', async () => {
  const { models, served } = answering();

  const reply = await served.fetch(ask('/v1/responses', false));

  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({
    id: expect.stringMatching(/^resp_/),
    object: 'response',
    status: 'completed',
    model: 'coder',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Two threads take the locks in opposite order.',
          },
        ],
      },
    ],
  });
  expect(models.sent(gpt)).toMatchObject([
    { messages: [{ role: 'user', text: 'Why does this deadlock?' }] },
  ]);
});

test('Responses, streamed: named events from created to completed', async () => {
  const { served } = answering();

  const reply = await served.fetch(ask('/v1/responses', true));

  expect(reply.status).toBe(200);
  expect(reply.headers.get('content-type')).toBe('text/event-stream');
  const events = await sent(reply);
  expect(events.at(0)).toMatchObject({
    event: 'response.created',
    data: { type: 'response.created', response: { status: 'in_progress' } },
  });
  expect(
    events
      .filter(({ event }) => event === 'response.output_text.delta')
      .map(({ data }) => data.delta),
  ).toEqual(['Two threads take ', 'the locks in opposite order.']);
  expect(events.at(-1)).toMatchObject({
    event: 'response.completed',
    data: {
      response: {
        status: 'completed',
        output: [
          {
            content: [
              { text: 'Two threads take the locks in opposite order.' },
            ],
          },
        ],
      },
    },
  });
});

test('Messages, whole', async () => {
  const { models, served } = answering();

  const reply = await served.fetch(
    ask('/v1/messages', false, { 'anthropic-version': '2023-06-01' }),
  );

  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({
    id: expect.stringMatching(/^msg_/),
    type: 'message',
    role: 'assistant',
    model: 'coder',
    content: [
      { type: 'text', text: 'Two threads take the locks in opposite order.' },
    ],
    stop_reason: 'end_turn',
  });
  expect(models.sent(gpt)).toMatchObject([
    { messages: [{ role: 'user', text: 'Why does this deadlock?' }] },
  ]);
});

test('Messages, streamed: named events from start to stop', async () => {
  const { served } = answering();

  const reply = await served.fetch(
    ask('/v1/messages', true, { 'anthropic-version': '2023-06-01' }),
  );

  expect(reply.status).toBe(200);
  expect(reply.headers.get('content-type')).toBe('text/event-stream');
  const events = await sent(reply);
  expect(events.map(({ event }) => event)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  expect(
    events
      .filter(({ event }) => event === 'content_block_delta')
      .map(({ data }) => data.delta.text),
  ).toEqual(['Two threads take ', 'the locks in opposite order.']);
});

test.each([
  ['/v1/chat/completions', false],
  ['/v1/chat/completions', true],
  ['/v1/responses', false],
  ['/v1/responses', true],
])(
  "%s (stream %p): the motty's own error is an OpenAI error with its status",
  async (path, stream) => {
    const served = serve(
      motty({ name: 'coder' }).handle(() => {
        throw new EmptyPrompt('The prompt has no question in it');
      }),
      () => ({}),
    );

    const reply = await served.fetch(ask(path, stream));

    expect(reply.status).toBe(422);
    expect(reply.headers.get('content-type')).toStartWith('application/json');
    expect(reply.headers.has('retry-after')).toBe(false);
    expect(reply.headers.get('x-should-retry')).toBe('false');
    expect(await reply.json()).toMatchObject({
      error: {
        message: 'The prompt has no question in it',
        type: 'invalid_request_error',
        code: 'empty_prompt',
      },
    });
  },
);

test.each([false, true])(
  "/v1/messages (stream %p): the motty's own error is an Anthropic error with its status",
  async (stream) => {
    const served = serve(
      motty({ name: 'coder' }).handle(() => {
        throw new EmptyPrompt('The prompt has no question in it');
      }),
      () => ({}),
    );

    const reply = await served.fetch(ask('/v1/messages', stream));

    expect(reply.status).toBe(422);
    expect(reply.headers.get('content-type')).toStartWith('application/json');
    expect(await reply.json()).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'The prompt has no question in it',
      },
      request_id: reply.headers.get('request-id'),
    });
  },
);

test.each([
  ['/v1/chat/completions', false],
  ['/v1/chat/completions', true],
  ['/v1/responses', false],
  ['/v1/responses', true],
  ['/v1/messages', false],
  ['/v1/messages', true],
])(
  '%s (stream %p): an upstream rate limit is a 429 that says when to retry, in the upstream`s own words',
  async (path, stream) => {
    const served = serve(coder, () => ({
      models: [
        fake(
          on(
            gpt,
            new RateLimited('Limit 90000 TPM reached, try again in 2.4s', {
              retryAfterMs: 2400,
              upstream: true,
            }),
          ),
        ),
      ],
    }));

    const reply = await served.fetch(ask(path, stream));

    expect(reply.status).toBe(429);
    expect(reply.headers.get('retry-after')).toBe('3');
    expect(reply.headers.get('x-should-retry')).toBe('true');
    expect(await reply.json()).toMatchObject({
      error: {
        type: 'rate_limit_error',
        message: 'Limit 90000 TPM reached, try again in 2.4s',
      },
    });
  },
);

test.each([
  [
    '/v1/chat/completions',
    {
      error: {
        message: 'Expected temperature to be at most 2, received 9',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request',
      },
    },
  ],
  [
    '/v1/responses',
    {
      error: {
        message: 'Expected temperature to be at most 2, received 9',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request',
      },
    },
  ],
  [
    '/v1/messages',
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Expected temperature to be at most 2, received 9',
      },
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
  ],
])(
  '%s: an option the upstream refused is a 400 that says which, and the record holds the same',
  async (path, body) => {
    const reported = Promise.withResolvers<{ error?: unknown }>();
    const served = serve(coder, () => ({
      models: [
        {
          serves: () => true,
          call: async function* () {
            yield {
              type: 'error',
              error: {
                code: 'invalid_request',
                status: 400,
                message: 'Expected temperature to be at most 2, received 9',
                provider: { 'openai.chat': { status: 400, code: 400 } },
              },
            };
          },
        },
      ],
      report: reported.resolve,
    }));

    const reply = await served.fetch(ask(path, false));

    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual(body);
    expect((await reported.promise).error).toEqual({
      code: 'invalid_request',
      status: 400,
      message: 'Expected temperature to be at most 2, received 9',
      retryable: false,
      provider: { 'openai.chat': { status: 400, code: 400 } },
      upstream: true,
    });
  },
);

test.each([
  [
    '/v1/chat/completions',
    {
      error: {
        message: 'User not found.',
        type: 'server_error',
        param: null,
        code: 'upstream_refused',
      },
    },
  ],
  [
    '/v1/responses',
    {
      error: {
        message: 'User not found.',
        type: 'server_error',
        param: null,
        code: 'upstream_refused',
      },
    },
  ],
  [
    '/v1/messages',
    {
      type: 'error',
      error: { type: 'api_error', message: 'User not found.' },
      request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    },
  ],
])(
  '%s: a key of the host`s that the upstream refused is a 502 that says what the adapter told',
  async (path, body) => {
    const reported = Promise.withResolvers<{ error?: unknown }>();
    const served = serve(coder, () => ({
      models: [
        {
          serves: () => true,
          call: async function* () {
            yield {
              type: 'error',
              error: { code: 'upstream_refused', message: 'User not found.' },
            };
          },
        },
      ],
      report: reported.resolve,
    }));

    const reply = await served.fetch(ask(path, false));

    expect(reply.status).toBe(502);
    expect(await reply.json()).toEqual(body);
    expect((await reported.promise).error).toEqual({
      code: 'upstream_refused',
      status: 502,
      message: 'User not found.',
      retryable: false,
      upstream: true,
    });
  },
);

test.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])(
  '%s: what an adapter threw that is no SDK error is a 500 that quotes nothing, and the report holds it',
  async (path) => {
    const reported = Promise.withResolvers<Report>();
    const served = serve(coder, () => ({
      models: [
        {
          serves: () => true,
          call: () => {
            throw new TypeError('key sk-live is not a header value');
          },
        },
      ],
      report: reported.resolve,
    }));

    const reply = await served.fetch(ask(path, false));

    expect(reply.status).toBe(500);
    const text = await reply.text();
    expect(text).not.toContain('sk-live');
    expect(JSON.parse(text)).toMatchObject({
      error: { message: 'Internal error' },
    });
    expect(await reported.promise).toMatchObject({
      error: {
        code: 'internal',
        message: 'The model call to openai/gpt failed',
      },
      failed: [
        {
          service: 'models',
          error: { message: 'key sk-live is not a header value' },
        },
      ],
    });
  },
);

test.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])(
  '%s: a server failure the motty raised on purpose is told in its own words',
  async (path) => {
    const served = serve(
      motty({ name: 'coder' }).handle(() => {
        throw new Overloaded('The index is rebuilding, try again in a minute');
      }),
      () => ({}),
    );

    const reply = await served.fetch(ask(path, false));

    // Each caller is told in its own API's number for an overload.
    expect(reply.status).toBe(path === '/v1/messages' ? 529 : 503);
    expect(await reply.json()).toMatchObject({
      error: { message: 'The index is rebuilding, try again in a minute' },
    });
  },
);

test.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])(
  '%s: what a motty threw that is no SDK error is a 500 that quotes nothing',
  async (path) => {
    const served = serve(
      motty({ name: 'coder' }).handle(() => {
        throw new TypeError('db password hunter2 was rejected');
      }),
      () => ({}),
    );

    const reply = await served.fetch(ask(path, false));

    expect(reply.status).toBe(500);
    const text = await reply.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toMatchObject({
      error: { message: 'Internal error' },
    });
  },
);

test.each([
  ['/v1/chat/completions', {}],
  ['/v1/responses', {}],
  ['/v1/messages', { type: 'error' }],
])(
  '%s: a body that is not JSON is an invalid request in the format of the path',
  async (path, envelope) => {
    const { models, served } = answering();

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"model": "coder", "messages": [',
      }),
    );

    expect(reply.status).toBe(400);
    expect(await reply.json()).toMatchObject({
      ...envelope,
      error: {
        type: 'invalid_request_error',
        message: 'The body is not valid JSON',
      },
    });
    expect(models.sent(gpt)).toEqual([]);
  },
);

test.each([
  [
    '/v1/chat/completions',
    {},
    `{"model":"coder","messages":[{"role":"user","content":"Hi"}],"tools":[{"type":"function","function":{"name":"f","parameters":${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}}}]}`,
  ],
  [
    '/v1/responses',
    {},
    `{"model":"coder","input":"Hi","metadata":${'['.repeat(100_000)}${']'.repeat(100_000)}}`,
  ],
  [
    '/v1/messages',
    { type: 'error' },
    `{"model":"coder","max_tokens":5,"messages":[{"role":"user","content":"Hi"}],"tools":[{"name":"f","input_schema":${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}}]}`,
  ],
])(
  '%s: a body nested deeper than any request goes is an invalid request, and says so',
  async (path, envelope, body) => {
    const { models, served } = answering();

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );

    expect(reply.status).toBe(400);
    expect(await reply.json()).toMatchObject({
      ...envelope,
      error: {
        type: 'invalid_request_error',
        message: 'The body is nested more than 512 levels deep',
      },
    });
    expect(models.sent(gpt)).toEqual([]);
  },
);

test('arguments nested too deep inside their text are kept as the text they came as', async () => {
  const { models, served } = answering();
  const written = '['.repeat(100_000) + ']'.repeat(100_000);

  const reply = await served.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'coder',
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'f', arguments: written },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'done' },
        ],
      }),
    }),
  );

  expect(reply.status).toBe(200);
  expect(models.sent(gpt)[0]?.messages[1]).toMatchObject({
    parts: [{ type: 'tool_call', id: 'call_1', name: 'f', raw: written }],
  });
});

test.each([
  ['/v1/chat/completions', {}],
  ['/v1/responses', {}],
  ['/v1/messages', { type: 'error' }],
])(
  '%s: a body sent as something other than JSON is an invalid request',
  async (path, envelope) => {
    const { served } = answering();

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'model=coder',
      }),
    );

    expect(reply.status).toBe(400);
    expect(await reply.json()).toMatchObject({
      ...envelope,
      error: {
        type: 'invalid_request_error',
        message:
          'The body must be JSON, sent as application/json and not as application/x-www-form-urlencoded',
      },
    });
  },
);

test('each API names the headers its own clients send a key in', () => {
  expect(chatCompletions.credentials).toEqual(['authorization', 'api-key']);
  expect(responses.credentials).toEqual(['authorization', 'api-key']);
  expect(messages.credentials).toEqual(['x-api-key', 'authorization']);
});

test.each(
  [chatCompletions, responses, messages].flatMap(({ paths, credentials }) =>
    credentials.flatMap((header) =>
      paths.map((path) => ({
        path,
        header,
        token: header === 'authorization' ? 'Bearer sk-ada' : 'sk-ada',
        others: credentials.filter((other) => other !== header),
      })),
    ),
  ),
)(
  '$path: a token in $header signs the caller in, and no credential header of the API reaches the motty',
  async ({ path, header, token, others }) => {
    const seen: [string, string][][] = [];
    const callers: unknown[] = [];
    const served = serve(
      motty({ name: 'coder' }).handle(({ request }) => {
        seen.push([...request.headers]);
        callers.push(hosted().caller);
        return answer('Use a mutex.');
      }),
      () => ({
        auth: {
          verify: (sent) => (sent === 'sk-ada' ? { id: 'ada' } : undefined),
        },
      }),
    );
    const sent = ask(path, false, { 'x-trace': 'trace-7' });
    sent.headers.append(header.toUpperCase(), token);
    sent.headers.append(header, 'sk-second');
    for (const other of others) sent.headers.set(other, 'Bearer sk-eve');

    await served.fetch(ask(path, false, { [header]: token }));
    await served.fetch(sent);

    expect(callers).toEqual([{ id: 'ada' }, undefined]);
    expect(seen).toEqual([
      [['content-type', 'application/json']],
      [
        ['content-type', 'application/json'],
        ['x-trace', 'trace-7'],
      ],
    ]);
  },
);

test.each(
  [chatCompletions, responses, messages].flatMap(({ paths, credentials }) =>
    paths.map((path) => ({ path, credentials })),
  ),
)(
  '$path: with no auth adapter every credential header of the API is removed all the same',
  async ({ path, credentials }) => {
    const seen: [string, string][][] = [];
    const served = serve(
      motty({ name: 'coder' }).handle(({ request }) => {
        seen.push([...request.headers]);
        return answer('Use a mutex.');
      }),
      () => ({}),
    );

    await served.fetch(
      ask(
        path,
        false,
        Object.fromEntries(credentials.map((header) => [header, 'sk-ada'])),
      ),
    );

    expect(seen).toEqual([[['content-type', 'application/json']]]);
  },
);

test.each(
  [chatCompletions, responses, messages].flatMap(({ paths, credentials }) =>
    [
      ...new Set(
        [chatCompletions, responses, messages].flatMap(
          (other) => other.credentials,
        ),
      ),
    ]
      .filter((header) => !credentials.includes(header))
      .flatMap((header) => paths.map((path) => ({ path, header }))),
  ),
)(
  "$path: a token in $header, another API's credential header, signs nobody in and does not reach the motty, and a header that is no API's credential does",
  async ({ path, header }) => {
    const seen: [string, string][][] = [];
    const callers: unknown[] = [];
    const served = serve(
      motty({ name: 'coder' }).handle(({ request }) => {
        seen.push([...request.headers]);
        callers.push(hosted().caller);
        return answer('Use a mutex.');
      }),
      () => ({
        auth: {
          verify: (sent) => (sent === 'sk-ada' ? { id: 'ada' } : undefined),
        },
      }),
    );

    await served.fetch(
      ask(path, false, {
        [header]: 'sk-ada',
        cookie: 'session=sk-ada',
        'proxy-authorization': 'Bearer sk-ada',
        'x-upstream-key': 'sk-ada',
      }),
    );

    expect(callers).toEqual([undefined]);
    expect(seen).toEqual([
      [
        ['content-type', 'application/json'],
        ['cookie', 'session=sk-ada'],
        ['proxy-authorization', 'Bearer sk-ada'],
        ['x-upstream-key', 'sk-ada'],
      ],
    ]);
  },
);

test('a JSON body with no content type named is read', async () => {
  const { served } = answering();

  const reply = await served.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      body: new TextEncoder().encode(
        '{"model":"coder","messages":[{"role":"user","content":"hi"}]}',
      ),
    }),
  );

  expect(reply.status).toBe(200);
});

test.each([
  ['/v1/chat/completions', {}],
  ['/v1/responses', {}],
  ['/v1/messages', { type: 'error' }],
])(
  '%s: a body the API does not allow is refused before the motty runs',
  async (path, envelope) => {
    const { models, served } = answering();

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '"Why does this deadlock?"',
      }),
    );

    expect(reply.status).toBe(400);
    expect(await reply.json()).toMatchObject({
      ...envelope,
      error: { type: 'invalid_request_error' },
    });
    expect(models.sent(gpt)).toEqual([]);
  },
);

test.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])(
  '%s: a failure after the answer began ends the stream, the status long sent',
  async (path) => {
    const cutOff: ModelAdapter = {
      serves: () => true,
      call: async function* () {
        yield { type: 'text', text: 'Two threads ' };
        yield {
          type: 'error',
          error: toFacts(
            new Overloaded('node gpu-7 fell over', { upstream: true }),
          ),
        };
      },
    };
    const served = serve(coder, () => ({ models: [cutOff] }));

    const reply = await served.fetch(ask(path, true));

    expect(reply.status).toBe(200);
    const text = await reply.text();
    expect(text).toContain('Two threads ');
    expect(text).toContain('node gpu-7 fell over');
  },
);

// One line of progress, a call whose answer is only read, and the call that
// answers: each call reports its own usage.
function planning() {
  return serve(
    motty({ name: 'coder' }).handle(async ({ prompt }) => {
      think('Reading the diff');
      await (await gpt.complete(prompt)).text();
      return gpt.complete(prompt);
    }),
    () => ({
      models: [
        fake(
          on(gpt, [
            { type: 'text', text: 'Compare the lock order.' },
            { type: 'finish', reason: 'stop', usage: { input: 5, output: 2 } },
          ]),
          on(gpt, [
            { type: 'text', text: 'Use a mutex.' },
            { type: 'finish', reason: 'stop', usage: { input: 7, output: 3 } },
          ]),
        ),
      ],
    }),
  );
}

function post(path: string, body: { [field: string]: unknown }): Request {
  return new Request(`http://motty.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'coder', ...body }),
  });
}

test.each([
  [
    '/v1/chat/completions',
    { messages: [{ role: 'user', content: 'Why?' }] },
    { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  ],
  [
    '/v1/responses',
    { input: 'Why?', reasoning: { summary: 'auto' } },
    { input_tokens: 12, output_tokens: 5, total_tokens: 17 },
  ],
  [
    '/v1/messages',
    {
      messages: [{ role: 'user', content: 'Why?' }],
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    },
    { input_tokens: 12, output_tokens: 5 },
  ],
])(
  '%s: progress reaches the caller as reasoning, and the usage is the sum over every call',
  async (path, body, usage) => {
    const whole = await planning().fetch(post(path, body));
    const streamed = await planning().fetch(
      post(path, { ...body, stream: true }),
    );

    const reply = await whole.text();
    expect(reply).toContain('Reading the diff');
    expect(reply).not.toContain('Compare the lock order.');
    expect(JSON.parse(reply)).toMatchObject({ usage });
    const events = await streamed.text();
    expect(events.indexOf('Reading the diff')).toBeGreaterThan(-1);
    expect(events.indexOf('Reading the diff')).toBeLessThan(
      events.indexOf('Use a mutex.'),
    );
  },
);

test.each([
  [
    '/v1/chat/completions',
    {
      messages: [{ role: 'user', content: 'Why?' }],
      reasoning: { exclude: true },
    },
  ],
  ['/v1/responses', { input: 'Why?' }],
  [
    '/v1/messages',
    { messages: [{ role: 'user', content: 'Why?' }], max_tokens: 4096 },
  ],
])(
  '%s: a caller who muted reasoning is sent no progress, whole or streamed',
  async (path, body) => {
    const whole = await planning().fetch(post(path, body));
    const streamed = await planning().fetch(
      post(path, { ...body, stream: true }),
    );

    const reply = await whole.text();
    expect(reply).toContain('Use a mutex.');
    expect(reply).not.toContain('Reading the diff');
    const events = await streamed.text();
    expect(events).toContain('Use a mutex.');
    expect(events).not.toContain('Reading the diff');
  },
);

test('Chat Completions, streamed: the usage is sent only to a caller who asked for it', async () => {
  const messages = [{ role: 'user', content: 'Why?' }];

  const unasked = await sent(
    await planning().fetch(
      post('/v1/chat/completions', { messages, stream: true }),
    ),
  );
  const asked = await sent(
    await planning().fetch(
      post('/v1/chat/completions', {
        messages,
        stream: true,
        stream_options: { include_usage: true },
      }),
    ),
  );

  expect(JSON.stringify(unasked)).not.toContain('usage');
  expect(asked.at(-2)?.data).toMatchObject({
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
  });
});
