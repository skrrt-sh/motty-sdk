import { expect, test } from 'bun:test';
import {
  Aborted,
  answer,
  ContextTooLong,
  InvalidOutput,
  InvalidRequest,
  motty,
  RateLimited,
  TimedOut,
  UnknownModel,
  UpstreamFailed,
  UpstreamRefused,
} from '@mottyjs/core';
import { adapted, toFacts } from '@mottyjs/core/host';
import { decision, noul } from '@mottyjs/decision';
import { run } from '@mottyjs/test';
import { typesafe } from '../src/typesafe.ts';

test('it serves the names under its prefix, for decisions only', () => {
  const adapter = typesafe({ key: 'ts-host' });
  const local = typesafe({
    address: 'http://localhost:8000/v1',
    prefix: 'laya',
  });

  expect(adapter.serves('typesafe/jev-latest')).toBe(true);
  expect(adapter.serves('typesafe')).toBe(false);
  expect(adapter.serves('openai/gpt-5')).toBe(false);
  expect(local.serves('laya/laya-1')).toBe(true);
  expect(local.serves('typesafe/jev-latest')).toBe(false);
  expect(adapter.call).toBeUndefined();
});

test('with no key it fails when made, unless the address is its own', () => {
  expect(() => typesafe({ key: undefined })).toThrow(
    'The typesafe adapter was given no key',
  );
  expect(() => typesafe({})).toThrow();
  expect(() => typesafe({ key: ' \n' })).toThrow(
    'The typesafe adapter was given no key',
  );
  expect(() => typesafe({ address: 'http://localhost:8000/v1' })).not.toThrow();
});

test.each(['laya/v1'])(
  'the prefix %p fails when the adapter is made',
  (prefix) => {
    expect(() =>
      typesafe({ address: 'http://localhost:8000/v1', prefix }),
    ).toThrow(
      /^An adapter was given a prefix that is no name: it takes one or more characters and no \/$/,
    );
  },
);

test('a decision of all three kinds goes out and its answer comes back as it is', async () => {
  const input = {
    state: 'Help! My payouts have been failing for 3 days.',
    questions: {
      urgent: { type: 'noul', instructions: 'Does this convey urgency?' },
      team: {
        type: 'choice',
        instructions: 'Which team should handle this?',
        criteria: { billing: 'Payments, refunds', technical: null },
      },
      anger: {
        type: 'score',
        instructions: 'How frustrated is the customer?',
        criteria: ['Calm', 'Frustrated', 'Very angry'],
      },
    },
  };
  const reply = {
    model: 'jev-1.13.0',
    answers: {
      urgent: { type: 'noul', noul: 0.95 },
      team: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.88, technical: 0.12 },
        confidence: 0.81,
      },
      anger: {
        type: 'score',
        score: 1.05,
        legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
        probabilities: { '0': 0, '1': 0.95, '2': 0.05 },
        confidence: 0.92,
      },
    },
    usage: { input_tokens: 296, output_tokens: 20 },
  };
  const seen: { path: string; key: string | null; body: unknown }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
        body: await request.json(),
      });
      return Response.json(reply);
    },
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const output = await decisions(
    'typesafe/jev-latest',
    input,
    AbortSignal.timeout(5000),
  );

  expect(seen).toEqual([
    {
      path: '/v1/systemone',
      key: 'Bearer ts-host',
      body: { model: 'jev-latest', ...input },
    },
  ]);
  expect(output).toEqual(reply);
});

test('a connection header is sent beside the key, and replaces neither it nor the content type', async () => {
  const seen: (string | null)[][] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push([
        request.headers.get('x-tenant'),
        request.headers.get('authorization'),
        request.headers.get('content-type'),
      ]);
      return Response.json({ model: 'jev-1', answers: {} });
    },
  });
  const { decisions } = adapted([
    typesafe({
      key: 'ts-host',
      address: `${upstream.url}v1`,
      headers: {
        'X-Tenant': 'acme',
        Authorization: 'Bearer other',
        'Content-Type': 'text/plain',
      },
    }),
  ]);

  await decisions(
    'typesafe/jev-latest',
    { state: 'A ticket', questions: {} },
    AbortSignal.timeout(5000),
  );

  expect(seen).toEqual([['acme', 'Bearer ts-host', 'application/json']]);
});

test('a local server is asked with no key', async () => {
  const seen: (string | null)[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers.get('authorization'));
      return Response.json({
        model: 'laya-1',
        answers: { urgent: { type: 'noul', noul: 0.2 } },
        usage: { input_tokens: 40, output_tokens: 4 },
      });
    },
  });
  const { decisions } = adapted([
    typesafe({ address: `${upstream.url}v1`, prefix: 'laya' }),
  ]);

  const output = await decisions(
    'laya/laya-1',
    {
      state: 'hi',
      questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } },
    },
    AbortSignal.timeout(5000),
  );

  expect(seen).toEqual([null]);
  expect(output).toMatchObject({ answers: { urgent: { noul: 0.2 } } });
});

test.each([
  [401, 'upstream_refused', UpstreamRefused],
  [429, 'rate_limited', RateLimited],
])('an upstream %i rejects with %s', async (status, code, Raised) => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { detail: 'The upstream said why' },
        { status, headers: { 'retry-after': '2' } },
      ),
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(Raised);
  expect(toFacts(thrown)).toMatchObject({
    code,
    message:
      code === 'upstream_refused'
        ? "The upstream refused the host's credentials or account"
        : 'The upstream said why',
    retryAfter: 2000,
    provider: { typesafe: { status } },
    upstream: true,
    cause: '{"detail":"The upstream said why"}',
  });
});

test.each([
  [
    'an object',
    400,
    { detail: { error_type: 'api_usage_error', message: 'Invalid request.' } },
    'Invalid request.',
    { status: 400, error_type: 'api_usage_error' },
  ],
  [
    'a sentence',
    400,
    { detail: 'Noul question must have criteria or instructions: urgent' },
    'Noul question must have criteria or instructions: urgent',
    { status: 400 },
  ],
  [
    'a sentence beside other words at the top of the body',
    400,
    {
      message: 'Bad request',
      detail: 'Noul question must have criteria or instructions: urgent',
    },
    'Noul question must have criteria or instructions: urgent',
    { status: 400 },
  ],
  [
    'an object that holds a status of its own',
    400,
    { detail: { status: 200, message: 'Invalid request.' } },
    'Invalid request.',
    { status: 400 },
  ],
  [
    'a list of what a validator refused',
    422,
    {
      detail: [
        {
          type: 'missing',
          loc: ['body', 'state'],
          msg: 'Field required',
          input: { questions: {} },
        },
        {
          type: 'too_short',
          loc: ['body', 'questions'],
          msg: 'Dictionary should have at least 1 item after validation, not 0',
          input: {},
          ctx: { field_type: 'Dictionary', min_length: 1, actual_length: 0 },
        },
      ],
    },
    'body.state: Field required; body.questions: Dictionary should have at least 1 item after validation, not 0',
    {
      status: 422,
      detail: [
        {
          type: 'missing',
          loc: ['body', 'state'],
          msg: 'Field required',
          input: { questions: {} },
        },
        {
          type: 'too_short',
          loc: ['body', 'questions'],
          msg: 'Dictionary should have at least 1 item after validation, not 0',
          input: {},
          ctx: { field_type: 'Dictionary', min_length: 1, actual_length: 0 },
        },
      ],
    },
  ],
])(
  'a refusal whose detail is %s is told in the upstream`s own sentence',
  async (_, status, body, message, record) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json(body, { status }),
    });
    const { decisions } = adapted([
      typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
    ]);

    const thrown = await decisions(
      'typesafe/jev-latest',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ).catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(InvalidRequest);
    expect(toFacts(thrown)).toMatchObject({
      code: 'invalid_request',
      status,
      message,
      cause: JSON.stringify(body),
    });
    expect(toFacts(thrown).provider).toEqual({ typesafe: record });
  },
);

test.each([
  ['a body that is no JSON', '<html>Bad gateway</html>'],
  ['a detail that is empty', '{"detail":" "}'],
  ['a detail with no message', '{"detail":{"error_type":"internal_error"}}'],
])('with %s the failure is told by its status', async (_, body) => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () => new Response(body, { status: 500 }),
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(toFacts(thrown)).toMatchObject({
    code: 'upstream_failed',
    message: 'The decision upstream answered 500',
    cause: body,
  });
});

test.each([
  [
    'Laya`s 422',
    'laya',
    422,
    { detail: "unknown model 'org/repo'; choose one of..." },
    "unknown model 'org/repo'; choose one of...",
  ],
])(
  '%s for a model the server does not know rejects as an unknown model, in its sentence',
  async (_, prefix, status, body, message) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json(body, { status }),
    });
    const { decisions } = adapted([
      typesafe({ key: 'ts-host', address: `${upstream.url}v1`, prefix }),
    ]);

    const thrown = await decisions(
      `${prefix}/org/repo`,
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ).catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(UnknownModel);
    expect(toFacts(thrown)).toMatchObject({ code: 'unknown_model', message });
  },
);

test.each([
  [
    'the words every server of this API has for no such path',
    '{"detail":"Not Found"}',
    ': Not Found',
  ],
  ['no body', '', ''],
])(
  'a 404 with %s is the host`s address at fault: an upstream failure nothing retries, and no unknown model',
  async (_, body, said) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(body, {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { decisions } = adapted([
      typesafe({
        key: 'ts-host-0123456789abcdef',
        address: `${upstream.url}v0`,
      }),
    ]);

    const thrown = await decisions(
      'typesafe/jev-latest',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ).catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(UpstreamFailed);
    expect(toFacts(thrown)).toMatchObject({
      code: 'upstream_failed',
      status: 502,
      message: `The decision upstream has no decisions at the adapter's address, which is likely wrong${said}`,
      retryable: false,
      provider: { typesafe: { status: 404 } },
      upstream: true,
    });
    expect(JSON.stringify(toFacts(thrown))).not.toMatch(/ts-host|localhost|v0/);
  },
);

test('a 404 whose words say the model is unknown is still an unknown model', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ detail: 'Unknown model: jev-0' }, { status: 404 }),
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-0',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(UnknownModel);
  expect(toFacts(thrown)).toMatchObject({ message: 'Unknown model: jev-0' });
});

test('a name Laya does not know, answered by a checkpoint its router chose, rejects as an unknown model that names it', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        model: 'laya-rl-agent',
        answers: { urgent: { type: 'noul', noul: 0.9 } },
        routing: {
          model: 'english',
          repo: 'convaiinnovations/laya',
          reason: 'English Latin text',
          detection: { script: 'latin', language: 'en', is_english: true },
          workflow: null,
        },
      }),
  });
  const { decisions } = adapted([
    typesafe({ address: `${upstream.url}v1`, prefix: 'laya' }),
  ]);

  const thrown = await decisions(
    'laya/multilingul',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(UnknownModel);
  expect(toFacts(thrown)).toMatchObject({
    code: 'unknown_model',
    message:
      "The decision upstream does not know the model 'multilingul' and answered with one its router chose",
    provider: {
      typesafe: { model: 'english', reason: 'English Latin text' },
    },
    upstream: true,
  });
});

test.each([
  [
    'an answer of a checkpoint its router chose',
    {
      model: 'laya-rl-agent',
      answers: {},
      routing: {
        model: 'english',
        reason: 'English Latin text',
        detection: { script: 'latin', language: 'en' },
      },
    },
  ],
  [
    'an answer of Jev`s, which says nothing of routing',
    { model: 'jev-1.13.0', answers: {} },
  ],
])(
  'a server the host says routes by itself has %s returned as it is',
  async (_, reply) => {
    using upstream = Bun.serve({ port: 0, fetch: () => Response.json(reply) });
    const { decisions } = adapted([
      typesafe({ address: `${upstream.url}v1`, routes: true }),
    ]);

    const output = await decisions(
      'typesafe/jev-latest',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    );

    expect(output).toEqual(reply);
  },
);

test('a name that is also the key of a local server is named whole in the refusal', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        model: 'laya-rl-agent',
        answers: {},
        routing: { model: 'english', detection: { script: 'latin' } },
      }),
  });
  const { decisions } = adapted([
    typesafe({ key: 'local', address: `${upstream.url}v1`, prefix: 'laya' }),
  ]);

  await expect(
    decisions(
      'laya/local',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow("does not know the model 'local'");
});

test.each([
  [
    'a name, an alias or other letters Laya took as the model',
    {
      model: 'multilingual',
      repo: 'convaiinnovations/laya/multilingual',
      reason: "explicit model='multilingual'",
      detection: null,
      workflow: null,
    },
  ],
  ['a routing that is no object', 'explicit'],
])('an answer with %s comes back as it is', async (_, routing) => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({ model: 'laya-rl-agent', answers: {}, routing }),
  });
  const { decisions } = adapted([
    typesafe({ address: `${upstream.url}v1`, prefix: 'laya' }),
  ]);

  const output = await decisions(
    'laya/ML',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  );

  expect(output).toEqual({ model: 'laya-rl-agent', answers: {}, routing });
});

test.each([
  [
    'a 413 that says it in other letters',
    413,
    'context_too_long',
    ContextTooLong,
    'State Too Large (50001 > 50000 chars)',
  ],
  [
    'a 413 that is about no state',
    413,
    'invalid_request',
    InvalidRequest,
    "too many choice options for 'team' (300 > 100)",
  ],
  [
    'a state too large that comes with another status than 413',
    400,
    'invalid_request',
    InvalidRequest,
    'state too large (50001 > 50000 chars)',
  ],
  [
    'an unknown model named past the start of a sentence',
    400,
    'invalid_request',
    InvalidRequest,
    "lang 'xx' is served by an unknown model",
  ],
])(
  '%s, answered with %i and read by its words, rejects with %s',
  async (_, status, code, Raised, detail) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ detail }, { status }),
    });
    const { decisions } = adapted([
      typesafe({ address: `${upstream.url}v1`, prefix: 'laya' }),
    ]);

    const thrown = await decisions(
      'laya/english',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ).catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(Raised);
    expect(toFacts(thrown)).toMatchObject({
      code,
      message: detail,
      provider: { typesafe: { status } },
    });
  },
);

test.each([['shortened as any field is', 'r'.repeat(5000), 'r'.repeat(300)]])(
  'the record keeps the kind of error Jev names and the id it gave the request, %s',
  async (_, sent, kept) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            detail: {
              error_type: 'api_usage_error',
              message: 'Unknown model: no-such-model',
            },
          },
          { status: 400, headers: { 'x-typesafe-request-id': sent } },
        ),
    });
    const { decisions } = adapted([
      typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
    ]);

    const thrown = await decisions(
      'typesafe/no-such-model',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ).catch((raised: unknown) => raised);

    expect(toFacts(thrown).provider).toEqual({
      typesafe: {
        status: 400,
        error_type: 'api_usage_error',
        request_id: kept,
      },
    });
  },
);

test('a connection`s body fields go with every request, and the call`s own state, questions and model replace theirs', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return Response.json({ model: 'laya-1', answers: {} });
    },
  });
  const { decisions } = adapted([
    typesafe({
      address: `${upstream.url}v1`,
      prefix: 'laya',
      body: {
        min_confidence: 0.9,
        lang: 'de',
        model: 'multilingual',
        state: 'the connection`s',
        questions: { other: { type: 'noul', instructions: 'Is it?' } },
      },
    }),
  ]);

  await decisions(
    'laya/english',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  );

  expect(seen).toEqual([
    {
      min_confidence: 0.9,
      lang: 'de',
      model: 'english',
      state: 'hi',
      questions: {},
    },
  ]);
});

test('a sentence longer than a message is shortened after the key is cut from it, so no end of the key is left', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) =>
      Response.json(
        {
          detail: `${'m'.repeat(1985)} ${request.headers.get('authorization')} was refused`,
        },
        { status: 400 },
      ),
  });
  const { decisions } = adapted([
    typesafe({
      key: 'ts-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1',
      address: `${upstream.url}v1`,
    }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(toFacts(thrown).message).toBe(`${'m'.repeat(1985)} Bearer [key]`);
  expect(JSON.stringify(toFacts(thrown))).not.toMatch(/Zq7L|Xv9R|6Bc1/);
});

test('past its time limit a call fails as timed out, and the upstream sees it', async () => {
  const left = Promise.withResolvers<Event>();
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      request.signal.addEventListener('abort', left.resolve);
      return new Promise<Response>(() => {});
    },
  });
  // A limit that fires before the request reaches the server leaves it no
  // abort to see, so this one is long enough for a machine under load.
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1`, timeout: 500 }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    new AbortController().signal,
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(TimedOut);
  expect(toFacts(thrown)).toMatchObject({ status: 504, retryable: true });
  expect((await left.promise).type).toBe('abort');
});

test.each([-1])(
  'a time limit of %p fails when the adapter is made, in words that name the adapter and the option',
  (timeout) => {
    expect(() => typesafe({ key: 'ts-host', timeout })).toThrow(
      /^The typesafe adapter's timeout must be a finite number of zero or more$/,
    );
    expect(() =>
      typesafe({
        address: 'http://localhost:8000/v1',
        prefix: 'laya',
        timeout,
      }),
    ).toThrow(
      /^The laya adapter's timeout must be a finite number of zero or more$/,
    );
  },
);

test('a time limit of zero is a time, and a call under it times out', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1`, timeout: 0 }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    new AbortController().signal,
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(TimedOut);
});

test('a stop ends a call the upstream never answers, and the upstream sees it', async () => {
  const stop = new AbortController();
  const left = Promise.withResolvers<Event>();
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      request.signal.addEventListener('abort', left.resolve);
      stop.abort();
      return new Promise<Response>(() => {});
    },
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    stop.signal,
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(Aborted);
  expect((await left.promise).type).toBe('abort');
});

test('an upstream nobody listens at rejects as a retryable failure', async () => {
  const gone = Bun.serve({ port: 0, fetch: () => new Response('') });
  await gone.stop(true);
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${gone.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(UpstreamFailed);
  expect(toFacts(thrown)).toMatchObject({ retryable: true, upstream: true });
});

test('an answer that is not JSON is invalid output', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () => new Response('<html>gateway</html>'),
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(InvalidOutput);
});

test('a motty routes on a decision made through the adapter', async () => {
  const seen: Headers[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers);
      return Response.json({
        model: 'jev-1.13.0',
        answers: { hard: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 120, output_tokens: 12 },
      });
    },
  });
  const tiers = motty({ name: 'tiers' }).route(
    async ({ request }) => {
      const { hard } = await decision('typesafe/jev-latest').decide(
        request.messages,
        { hard: noul({ instructions: 'Is this a hard problem?' }) },
      );
      return hard.noul > 0.5 ? 'deep' : 'quick';
    },
    { quick: () => answer('quick reply'), deep: () => answer('deep reply') },
  );

  const { route, calls } = await run(
    tiers,
    { text: 'Why does this deadlock?', headers: { 'x-caller': 'secret' } },
    { models: [typesafe({ key: 'ts-host', address: `${upstream.url}v1` })] },
  );

  expect(route).toBe('deep');
  expect(calls).toMatchObject([
    { model: 'typesafe/jev-latest', input: 120, output: 12 },
  ]);
  expect(seen.map((headers) => headers.get('authorization'))).toEqual([
    'Bearer ts-host',
  ]);
  expect(seen.map((headers) => headers.has('x-caller'))).toEqual([false]);
});

test.each([[307, 'another']])(
  'a %i to %s origin is not followed: it is one failure no retry mends, and the other address is asked nothing',
  async (status, origin) => {
    const asked: string[] = [];
    using other = Bun.serve({
      port: 0,
      fetch: (request) => {
        asked.push(request.url);
        return Response.json({ answers: {} });
      },
    });
    using upstream = Bun.serve({
      port: 0,
      fetch: (request) => {
        const { pathname } = new URL(request.url);
        asked.push(pathname);
        return pathname === '/moved/systemone'
          ? Response.json({ answers: {} })
          : new Response('Moved to another place', {
              status,
              headers: {
                location:
                  origin === 'another'
                    ? `${other.url}moved/systemone`
                    : '/moved/systemone',
              },
            });
      },
    });
    const { decisions } = adapted([
      typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
    ]);

    const thrown = await decisions(
      'typesafe/jev-latest',
      { state: 'hi', questions: {} },
      AbortSignal.timeout(5000),
    ).catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(UpstreamFailed);
    expect(toFacts(thrown)).toEqual({
      code: 'upstream_failed',
      status: 502,
      message: `The upstream answered ${status}, a redirect, which is not followed`,
      retryable: false,
      upstream: true,
    });
    expect(asked).toEqual(['/v1/systemone']);
  },
);

test('a key that is a word of the adapter`s own sentence leaves the sentence whole', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () => new Response('the decision was lost', { status: 500 }),
  });
  const { decisions } = adapted([
    typesafe({ key: 'decision', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(toFacts(thrown)).toMatchObject({
    message: 'The decision upstream answered 500',
    cause: 'the [key] was lost',
  });
});

test('a failure longer than an adapter reads is let go where the reading stops, and its opening is the cause', async () => {
  let released = false;
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode('m'.repeat(16_384)));
          },
          cancel() {
            released = true;
          },
        }),
        { status: 500 },
      ),
  });
  const { decisions } = adapted([
    typesafe({ key: 'ts-host', address: `${upstream.url}v1` }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(1500),
  ).catch((raised: unknown) => raised);

  expect(toFacts(thrown)).toMatchObject({
    code: 'upstream_failed',
    message: 'The decision upstream answered 500',
    cause: 'm'.repeat(1000),
  });
  await Bun.sleep(50);
  expect(released).toBe(true);
});

test('a header`s secret that the end of the cause would break is cut whole before it', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) =>
      new Response(
        `${'m'.repeat(990)}${request.headers.get('x-gateway')} was refused`,
        { status: 500 },
      ),
  });
  const { decisions } = adapted([
    typesafe({
      key: 'ts-host',
      address: `${upstream.url}v1`,
      headers: { 'x-gateway': 'gw-Tt6Uu7Vv8Ww9Xx0Yy1Zz2' },
    }),
  ]);

  const thrown = await decisions(
    'typesafe/jev-latest',
    { state: 'hi', questions: {} },
    AbortSignal.timeout(5000),
  ).catch((raised: unknown) => raised);

  expect(toFacts(thrown)).toMatchObject({
    cause: `${'m'.repeat(990)}[key] was `,
  });
});
