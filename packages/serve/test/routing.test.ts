import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { mark } from '@mottyjs/core/host';
import { fake, on } from '@mottyjs/test';
import { serve } from '../src/index.ts';

const gpt = model('openai/gpt');

const coder = motty({ name: 'coder' }).handle(({ prompt }) =>
  gpt.complete(prompt),
);

function coderServed() {
  return serve(coder, () => ({ models: [fake(on(gpt, 'Use a mutex.'))] }));
}

test('the options are made once, at start, from the environment', async () => {
  const seen: (string | undefined)[] = [];
  const served = serve(coder, (env) => {
    seen.push(env.NODE_ENV);
    return { models: [fake(on(gpt, 'Use a mutex.'))] };
  });
  expect(seen).toEqual(['test']);

  await served.fetch(new Request('http://motty.test/v1/models'));
  await served.fetch(new Request('http://motty.test/v1/models'));
  expect(seen).toEqual(['test']);
});

test('options that cannot be made fail the start, not a request', () => {
  expect(() =>
    serve(coder, () => {
      throw new Error('An adapter was given no key');
    }),
  ).toThrow('An adapter was given no key');
});

test('a motty of an unknown contract version is refused at start', () => {
  expect(() =>
    serve({ [mark]: { ...coder[mark], version: 2 } }, () => ({})),
  ).toThrow('The motty speaks contract version 2, this host 1');
});

test.each([
  [{}, { error: { type: 'invalid_request_error' } }],
  [
    { 'anthropic-version': '2023-06-01' },
    { type: 'error', error: { type: 'invalid_request_error' } },
  ],
])(
  'a path that cannot be read is refused in the format of its API, never with a bare error: %o',
  async (headers, body) => {
    const served = coderServed();

    const reply = await served.fetch(
      new Request('http://motty.test/v1/models/%E0%A4%A', { headers }),
    );

    expect(reply.status).toBe(400);
    expect(reply.headers.get('content-type')).toStartWith('application/json');
    expect(await reply.json()).toMatchObject(body);
  },
);

test('the model list names the served motty, as OpenAI lists', async () => {
  const reply = await coderServed().fetch(
    new Request('http://motty.test/v1/models'),
  );

  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    object: 'list',
    data: [
      {
        id: 'coder',
        object: 'model',
        created: expect.any(Number),
        owned_by: 'motty',
      },
    ],
  });
});

test('the model list is in the shape of Anthropic for its clients', async () => {
  const reply = await coderServed().fetch(
    new Request('http://motty.test/v1/models', {
      headers: { 'anthropic-version': '2023-06-01' },
    }),
  );

  expect(reply.status).toBe(200);
  expect(await reply.json()).toEqual({
    data: [
      {
        type: 'model',
        id: 'coder',
        display_name: 'coder',
        created_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      },
    ],
    has_more: false,
    first_id: 'coder',
    last_id: 'coder',
  });
});

test('one model is read by its name, and no other name is known', async () => {
  const served = coderServed();

  const found = await served.fetch(
    new Request('http://motty.test/v1/models/coder'),
  );
  expect(found.status).toBe(200);
  expect(await found.json()).toMatchObject({ id: 'coder', object: 'model' });

  const read = await served.fetch(
    new Request('http://motty.test/v1/models/coder', {
      headers: { 'anthropic-version': '2023-06-01' },
    }),
  );
  expect(await read.json()).toMatchObject({ id: 'coder', type: 'model' });

  const missing = await served.fetch(
    new Request('http://motty.test/v1/models/gpt-5'),
  );
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({
    error: {
      message: 'No model named gpt-5',
      type: 'invalid_request_error',
      code: 'model_not_found',
    },
  });
});

test.each([
  ['POST', '/v1/embeddings', 'Embeddings are not served'],
  ['POST', '/v1/images/generations', 'Images are not served'],
  ['POST', '/v1/audio/speech', 'Audio is not served'],
  ['POST', '/v1/batches', 'Batches are not served'],
  ['GET', '/v1/files', 'Files are not served'],
  ['POST', '/v1/realtime/client_secrets', 'Realtime is not served'],
  [
    'POST',
    '/v1/conversations',
    'Conversations are not served: no state is held between requests',
  ],
  [
    'GET',
    '/v1/chat/completions',
    'Stored chat completions are not served: no state is held between requests',
  ],
  [
    'GET',
    '/v1/chat/completions/chatcmpl-1/messages',
    'Stored chat completions are not served: no state is held between requests',
  ],
])('%s %s is rejected as an OpenAI error', async (method, path, message) => {
  const reply = await coderServed().fetch(
    new Request(`http://motty.test${path}`, { method }),
  );

  expect(reply.status).toBe(404);
  expect(await reply.json()).toMatchObject({
    error: { message, type: 'invalid_request_error', code: 'unsupported' },
  });
});

test.each([
  ['GET', '/v1/responses/resp_1'],
  ['DELETE', '/v1/responses/resp_1'],
  ['POST', '/v1/responses/resp_1/cancel'],
  ['GET', '/v1/responses/resp_1/input_items'],
])('%s %s is rejected: no response is stored', async (method, path) => {
  const reply = await coderServed().fetch(
    new Request(`http://motty.test${path}`, { method }),
  );

  expect(reply.status).toBe(404);
  expect(await reply.json()).toMatchObject({
    error: {
      message:
        'Stored responses are not served: no state is held between requests',
      type: 'invalid_request_error',
    },
  });
});

test('token counting is rejected in the format of its API', async () => {
  const served = coderServed();

  const anthropic = await served.fetch(
    new Request('http://motty.test/v1/messages/count_tokens', {
      method: 'POST',
    }),
  );
  expect(anthropic.status).toBe(404);
  expect(await anthropic.json()).toEqual({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: 'Token counting is not served yet',
    },
  });

  const openai = await served.fetch(
    new Request('http://motty.test/v1/responses/input_tokens', {
      method: 'POST',
    }),
  );
  expect(openai.status).toBe(404);
  expect(await openai.json()).toMatchObject({
    error: { message: 'Token counting is not served yet' },
  });
});

test.each([
  ['POST', '/v1/messages/batches', {}, 'Batches are not served'],
  ['GET', '/v1/messages', {}, 'Only POST /v1/messages is served'],
  [
    'GET',
    '/v1/files',
    { 'anthropic-version': '2023-06-01' },
    'Files are not served',
  ],
])(
  '%s %s is rejected as an Anthropic error',
  async (method, path, headers, message) => {
    const reply = await coderServed().fetch(
      new Request(`http://motty.test${path}`, { method, headers }),
    );

    expect(reply.status).toBe(404);
    expect(await reply.json()).toEqual({
      type: 'error',
      error: { type: 'not_found_error', message },
    });
  },
);

test.each([
  ['GET', '/'],
  ['GET', '/health'],
  ['POST', '/v1'],
  ['POST', '/v1/models'],
  ['POST', '/v1/chat'],
  ['POST', '/v1/embeddingsx'],
  ['POST', '/v2/chat/completions'],
  ['POST', '/chat/completions'],
  ['POST', '/responses'],
])(
  '%s %s is an unknown path: a 404 an OpenAI client can read',
  async (method, path) => {
    const reply = await coderServed().fetch(
      new Request(`http://motty.test${path}`, { method }),
    );

    expect(reply.status).toBe(404);
    expect(await reply.json()).toEqual({
      error: {
        message: 'Nothing is served at this path: every endpoint is under /v1',
        type: 'invalid_request_error',
        param: null,
        code: 'unsupported',
      },
    });
  },
);

test('an unknown path asked with the version header of Anthropic is a 404 its client can read', async () => {
  const reply = await coderServed().fetch(
    new Request('http://motty.test/messages', {
      method: 'POST',
      headers: { 'anthropic-version': '2023-06-01' },
    }),
  );

  expect(reply.status).toBe(404);
  expect(await reply.json()).toEqual({
    type: 'error',
    error: {
      type: 'not_found_error',
      message: 'Nothing is served at this path: every endpoint is under /v1',
    },
  });
});

test.each([
  ['/v1/chat/completions', { messages: [{ role: 'user', content: 'Hi' }] }],
  ['/v1/responses', { input: 'Hi' }],
  [
    '/v1/messages',
    { max_tokens: 64, messages: [{ role: 'user', content: 'Hi' }] },
  ],
])(
  'a body with no model is told the same on every API: %s',
  async (path, body) => {
    const reply = await coderServed().fetch(
      new Request(`http://motty.test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

    expect(reply.status).toBe(400);
    expect(await reply.text()).toContain('"message":"The body needs a model"');
  },
);
