import { expect, test } from 'bun:test';
import { dict, parsed } from '../../src/wire/json.ts';
import {
  detailed,
  loose,
  stated,
  upstreamFailure,
} from '../../src/wire/upstream-failure.ts';

function unnamed(status?: number) {
  return upstreamFailure(
    { code: undefined, message: undefined, record: { up: {} } },
    status,
  );
}

test.each([
  [400, 'invalid_request'],
  [401, 'upstream_refused'],
  [402, 'quota_exceeded'],
  [403, 'upstream_refused'],
  [408, 'timed_out'],
  [409, 'invalid_request'],
  [413, 'invalid_request'],
  [418, 'invalid_request'],
  [422, 'invalid_request'],
  [429, 'rate_limited'],
  [498, 'overloaded'],
  [500, 'upstream_failed'],
  [502, 'upstream_failed'],
  [503, 'overloaded'],
  [504, 'timed_out'],
  [524, 'timed_out'],
  [529, 'overloaded'],
] as const)('a failure nothing names, answered %i, is %s', (status, code) => {
  expect(unnamed(status).code).toBe(code);
});

test('a 404 with an error in its body is a model the upstream does not know', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: 'Not Found',
        record: { up: {} },
        error: { message: 'Not Found' },
      },
      404,
    ),
  ).toEqual({
    code: 'unknown_model',
    message: 'Not Found',
    provider: { up: {} },
    upstream: true,
  });
});

test('a 404 with no error in its body is a wrong address, which no retry mends', () => {
  expect(unnamed(404)).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered 404',
    retryable: false,
    provider: { up: {} },
    upstream: true,
  });
});

test('the status a caller gets is the kind`s own, so the upstream`s is not passed on', () => {
  expect(unnamed(529)).toEqual({
    code: 'overloaded',
    message: 'The upstream answered 529',
    provider: { up: {} },
    upstream: true,
  });
  expect(
    upstreamFailure(
      { code: 'context_too_long', message: 'Too long', record: { up: {} } },
      413,
    ),
  ).not.toHaveProperty('status');
});

test('a request the caller got wrong keeps the 4xx it came with', () => {
  expect(unnamed(413)).toMatchObject({ code: 'invalid_request', status: 413 });
  expect(
    upstreamFailure(
      { code: 'invalid_request', message: 'Bad', record: { up: {} } },
      422,
    ),
  ).toMatchObject({ code: 'invalid_request', status: 422 });
});

test('an invalid request keeps no status that means something else, nor a server`s', () => {
  for (const status of [403, 429, 500]) {
    expect(
      upstreamFailure(
        { code: 'invalid_request', message: 'Bad', record: { up: {} } },
        status,
      ),
    ).not.toHaveProperty('status');
  }
});

test('a refused key is the host`s, told in the SDK`s words with no status', () => {
  for (const status of [401, 403]) {
    const facts = unnamed(status);

    expect(facts.code).toBe('upstream_refused');
    expect(facts.message).toBe(
      "The upstream refused the host's credentials or account",
    );
    expect(facts).not.toHaveProperty('status');
    expect(facts).not.toHaveProperty('retryable');
  }
});

test('a spent balance told by status alone is a spent quota', () => {
  expect(unnamed(402)).toEqual({
    code: 'quota_exceeded',
    message: 'The upstream answered 402',
    provider: { up: {} },
    upstream: true,
  });
});

test('what the upstream calls the failure outranks its status', () => {
  expect(
    upstreamFailure(
      { code: 'quota_exceeded', message: 'Spent', record: { up: {} } },
      429,
    ),
  ).toEqual({
    code: 'quota_exceeded',
    message: 'Spent',
    provider: { up: {} },
    upstream: true,
  });
});

test('a number in the error is read as the status where none was sent', () => {
  const inStream = (code: number, status?: number) =>
    upstreamFailure(
      {
        code: undefined,
        message: 'Provider returned error',
        record: { up: {} },
        error: { message: 'Provider returned error', code },
      },
      status,
    );

  expect(inStream(429).code).toBe('rate_limited');
  expect(inStream(402).code).toBe('quota_exceeded');
  expect(inStream(404).code).toBe('unknown_model');
  expect(inStream(503, 200).code).toBe('overloaded');
  expect(inStream(502)).not.toHaveProperty('retryable');
  expect(inStream(422)).toMatchObject({ code: 'invalid_request', status: 422 });
});

test('a number in the error that is no error status names nothing', () => {
  for (const code of [200, 399, 600, 20012]) {
    expect(
      upstreamFailure({
        code: undefined,
        message: undefined,
        record: { up: {} },
        error: { code },
      }),
    ).toMatchObject({ code: 'upstream_failed', retryable: false });
  }
});

test('the status that was sent outranks a number in the error', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: undefined,
        record: { up: {} },
        error: { code: 404 },
      },
      500,
    ).code,
  ).toBe('upstream_failed');
});

test('the family`s name outranks a number in the error', () => {
  expect(
    upstreamFailure({
      code: 'context_too_long',
      message: 'Too long',
      record: { up: {} },
      error: { code: 429 },
    }).code,
  ).toBe('context_too_long');
});

test('a provider`s own reader is given the status, the headers and the error', () => {
  const seen: unknown[] = [];
  upstreamFailure(
    {
      code: undefined,
      message: 'No credit',
      record: { up: {} },
      error: { code: 'Arrearage' },
      headers: new Headers({ 'x-request-id': 'req_1' }),
    },
    400,
    undefined,
    (status, headers, error) => {
      seen.push(status, headers.get('x-request-id'), error);
      return undefined;
    },
  );

  expect(seen).toEqual([400, 'req_1', { code: 'Arrearage' }]);
});

test('a provider`s own name outranks the family`s, the number and the status', () => {
  expect(
    upstreamFailure(
      {
        code: 'rate_limited',
        message: 'No credit',
        record: { up: {} },
        error: { code: 429 },
      },
      400,
      undefined,
      () => ({ code: 'quota_exceeded' }),
    ),
  ).toEqual({
    code: 'quota_exceeded',
    message: 'No credit',
    provider: { up: {} },
    upstream: true,
  });
});

test('a failure the provider`s reader leaves is named as if there were none', () => {
  expect(
    upstreamFailure(
      { code: 'rate_limited', message: 'Slow down', record: { up: {} } },
      400,
      undefined,
      () => undefined,
    ).code,
  ).toBe('rate_limited');
  expect(
    upstreamFailure(
      { code: undefined, message: undefined, record: { up: {} } },
      503,
      undefined,
      () => undefined,
    ).code,
  ).toBe('overloaded');
});

test('a failure in a stream reaches the provider`s reader with no status and no headers', () => {
  const seen: unknown[] = [];
  upstreamFailure(
    { code: undefined, message: undefined, record: { up: {} } },
    undefined,
    undefined,
    (status, headers, error) => {
      seen.push(status, [...headers], error);
      return undefined;
    },
  );

  expect(seen).toEqual([undefined, [], {}]);
});

test('the retry facts a provider`s reader states outrank the headers', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: 'Busy',
        record: { up: {} },
        headers: new Headers({ 'x-should-retry': 'false' }),
      },
      503,
      20_000,
      () => ({ code: 'overloaded', retryable: true, retryAfter: 1500 }),
    ),
  ).toMatchObject({ code: 'overloaded', retryable: true, retryAfter: 1500 });
});

test('the upstream`s own word on another try replaces the kind`s', () => {
  const told = (code: 'rate_limited' | 'invalid_request', flag: string) =>
    upstreamFailure({
      code,
      message: 'x',
      record: { up: {} },
      headers: new Headers({ 'x-should-retry': flag }),
    });

  expect(told('rate_limited', 'false').retryable).toBe(false);
  expect(told('invalid_request', 'true').retryable).toBe(true);
  expect(told('rate_limited', 'maybe')).not.toHaveProperty('retryable');
});

test('the upstream`s word outranks the family`s, and what nothing names', () => {
  expect(
    upstreamFailure({
      code: 'upstream_failed',
      message: 'x',
      record: { up: {} },
      retryable: false,
      headers: new Headers({ 'x-should-retry': 'true' }),
    }).retryable,
  ).toBe(true);
  expect(
    upstreamFailure({
      code: undefined,
      message: undefined,
      record: { up: {} },
      headers: new Headers({ 'x-should-retry': 'true' }),
    }).retryable,
  ).toBe(true);
});

test('no flag makes a spent quota worth another try', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: undefined,
        record: { up: {} },
        headers: new Headers({ 'x-should-retry': 'true' }),
      },
      402,
    ),
  ).not.toHaveProperty('retryable');
  expect(
    upstreamFailure(
      { code: undefined, message: undefined, record: { up: {} } },
      429,
      undefined,
      () => ({ code: 'quota_exceeded', retryable: true }),
    ),
  ).not.toHaveProperty('retryable');
});

test('the family`s word on another try stands when the upstream sent none', () => {
  expect(
    upstreamFailure({
      code: 'upstream_failed',
      message: 'Not found',
      record: { up: {} },
      retryable: false,
    }).retryable,
  ).toBe(false);
});

test('the retry flag is left to the code unless nothing names the failure', () => {
  expect(unnamed(429)).not.toHaveProperty('retryable');
  expect(unnamed(500)).not.toHaveProperty('retryable');
  expect(unnamed(400)).not.toHaveProperty('retryable');
  expect(unnamed(302)).toMatchObject({
    code: 'upstream_failed',
    retryable: false,
  });
  expect(unnamed()).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered with an error',
    retryable: false,
    provider: { up: {} },
    upstream: true,
  });
  expect(
    upstreamFailure({
      code: 'upstream_failed',
      message: 'Oops',
      record: { up: {} },
    }),
  ).not.toHaveProperty('retryable');
});

test('a status that is no error is recorded but not passed on', () => {
  expect(unnamed(302)).not.toHaveProperty('status');
});

test('the wait the upstream asked for is kept', () => {
  expect(
    upstreamFailure(
      { code: undefined, message: undefined, record: { up: {} } },
      429,
      1500,
    ).retryAfter,
  ).toBe(1500);
  expect(unnamed(429)).not.toHaveProperty('retryAfter');
});

test('all an error states beside its message is kept for the record', () => {
  expect(
    stated({
      message: 'This request requires more credits',
      code: 402,
      param: null,
      metadata: { limit_source: 'openrouter_credits', provider_name: null },
    }),
  ).toEqual({
    code: 402,
    param: null,
    metadata: { limit_source: 'openrouter_credits', provider_name: null },
  });
});

test('a provider`s whole reply beside the error is cut short, and what is small beside it is kept', () => {
  const { metadata } = stated({
    metadata: { provider_name: 'acme', raw: 'x'.repeat(5000) },
  });

  expect(metadata).toEqual({ provider_name: 'acme', raw: 'x'.repeat(300) });
});

test('a reply kept as JSON is cut short as text', () => {
  expect(
    stated({
      metadata: { raw: { error: { message: 'x'.repeat(5000) } } },
      trace: ['x'.repeat(5000)],
    }),
  ).toEqual({
    metadata: { raw: `{"error":{"message":"${'x'.repeat(279)}` },
    trace: `["${'x'.repeat(298)}`,
  });
});

test.each([
  [
    'JSON that holds an error with a message',
    '{"error":{"message":"temperature: range is 0..1","type":"invalid_request_error"}}',
    'temperature: range is 0..1',
  ],
  [
    'JSON that holds a message',
    '{"message":"temperature: range is 0..1"}',
    'temperature: range is 0..1',
  ],
  [
    'JSON with no message of its own',
    '[{"path":["temperature"],"message":"Too big"}]',
    '[{"path":["temperature"],"message":"Too big"}]',
  ],
  ['text', ' temperature is out of range ', 'temperature is out of range'],
  ['the message again', 'Provider returned error', undefined],
  ['nothing', '', undefined],
])(
  'what the provider said beside a router`s message, as %s, is read whole',
  (_, raw, detail) => {
    expect(detailed('Provider returned error', { raw })).toBe(detail);
  },
);

test('what the provider said is read from JSON that was not put in a string', () => {
  expect(
    detailed('Provider returned error', {
      provider_name: 'acme',
      raw: { error: { message: 'temperature: range is 0..1' } },
    }),
  ).toBe('temperature: range is 0..1');
});

test('what the provider said is told after the router`s message, and alone where the router has none', () => {
  const told = (message: string | undefined) =>
    upstreamFailure(
      { code: undefined, message, detail: 'Too big', record: { up: {} } },
      400,
    ).message;

  expect(told('Bad request')).toBe('Bad request: Too big');
  expect(told(undefined)).toBe('Too big');
});

test('a message with nothing beside it has nothing more to tell', () => {
  expect([
    detailed('Bad request'),
    detailed('Bad request', undefined, { provider_name: null }),
    detailed(undefined, 'not a record'),
  ]).toEqual([undefined, undefined, undefined]);
});

test('the first place that holds what the provider said is the one read', () => {
  expect(detailed('Bad request', {}, { raw: 'Too big' })).toBe('Too big');
});

test('a sentence of a spent quota that holds a link is not the caller`s, and the whole message is kept for the host', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128. To increase, visit https://openrouter.ai/workspaces/default/keys/0f1e2d3c and adjust the key's total limit",
        record: { up: { code: 402 } },
      },
      402,
    ),
  ).toEqual({
    code: 'quota_exceeded',
    message:
      'This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128.',
    provider: {
      up: {
        code: 402,
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128. To increase, visit https://openrouter.ai/workspaces/default/keys/0f1e2d3c and adjust the key's total limit",
      },
    },
    upstream: true,
  });
});

test('a spent quota told in one sentence that holds a link is told in words of our own, never as a part of it', () => {
  expect(
    upstreamFailure({
      code: 'quota_exceeded',
      message: 'Out of credits, see http://billing.example/acct/7 to add more',
      record: { up: {} },
    }),
  ).toMatchObject({
    message: "The upstream's account has no quota left for this request",
    provider: {
      up: {
        message:
          'Out of credits, see http://billing.example/acct/7 to add more',
      },
    },
  });
});

test('every link of a spent quota is cut, wherever its sentence stands', () => {
  expect(
    upstreamFailure({
      code: 'quota_exceeded',
      message:
        'Top up at https://a.example/pay. Your balance is spent! Details: https://b.example/usage?key=1',
      record: { up: {} },
    }).message,
  ).toBe('Your balance is spent!');
});

test('a spent quota told with no link is told as it came, and its record is left alone', () => {
  expect(
    upstreamFailure({
      code: 'quota_exceeded',
      message: 'You exceeded your current quota. Check your plan.',
      record: { up: {} },
    }),
  ).toEqual({
    code: 'quota_exceeded',
    message: 'You exceeded your current quota. Check your plan.',
    provider: { up: {} },
    upstream: true,
  });
});

test('a link in a failure of another kind is left to the caller', () => {
  expect(
    upstreamFailure(
      {
        code: 'invalid_request',
        message: 'Bad schema. See https://docs.example/schemas for the form',
        record: { up: {} },
      },
      400,
    ).message,
  ).toBe('Bad schema. See https://docs.example/schemas for the form');
});

test('a quota a provider`s own reader names loses its link the same', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: 'Insufficient Balance. Recharge at https://pay.example/top-up',
        record: { up: {} },
      },
      400,
      undefined,
      () => ({ code: 'quota_exceeded' }),
    ).message,
  ).toBe('Insufficient Balance.');
});

test.each([
  ['Top up at https://pay.example/top-up'],
  ['Insufficient balance (see https://pay.example/acct/7).'],
  ['See www.pay.example/billing for account acct_123'],
  ['https://pay.example/billing'],
  [''],
])(
  'a spent quota told as %j leaves nothing to tell, so the caller is told in words of our own',
  (message) => {
    expect(
      upstreamFailure({ code: 'quota_exceeded', message, record: { up: {} } })
        .message,
    ).toBe("The upstream's account has no quota left for this request");
  },
);

test('a link written with no scheme is cut with its sentence', () => {
  expect(
    upstreamFailure({
      code: 'quota_exceeded',
      message: 'Your balance is spent. Top up at www.pay.example/top-up',
      record: { up: {} },
    }).message,
  ).toBe('Your balance is spent.');
});

test('an error of many fields is recorded only while the whole stays small', () => {
  const record = stated(
    Object.fromEntries(
      Array.from({ length: 500 }, (_, at) => [`field${at}`, 'x'.repeat(290)]),
    ),
  );

  expect(Object.keys(record)).toEqual([
    'field0',
    'field1',
    'field2',
    'field3',
    'field4',
    'field5',
  ]);
});

test('a field of many fields is recorded only while the whole of it stays small', () => {
  const { metadata } = stated({
    metadata: Object.fromEntries(
      Array.from({ length: 500 }, (_, at) => [`field${at}`, 'x'.repeat(290)]),
    ),
    code: 402,
  });

  expect(JSON.stringify(metadata).length).toBeLessThan(2100);
  expect(metadata).toHaveProperty('field0', 'x'.repeat(290));
});

test('what the provider said beside the router`s message is cut short', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: 'Provider returned error',
        detail: 'x'.repeat(5000),
        record: { up: {} },
      },
      400,
    ).message,
  ).toBe(`Provider returned error: ${'x'.repeat(300)}`);
});

test('no flag makes a refused credential worth another try', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: undefined,
        record: { up: {} },
        headers: new Headers({ 'x-should-retry': 'true' }),
      },
      401,
    ),
  ).not.toHaveProperty('retryable');
});

test.each([
  ['rate_limited', 429, 'Slow down, account. Wait 2s.'],
  ['quota_exceeded', 402, 'Slow down, account. Wait 2s.'],
  ['overloaded', 529, 'Slow down, account. Wait 2s.'],
  ['upstream_failed', 500, 'Slow down, account. Wait 2s.'],
  ['invalid_request', 400, 'Slow down, account id-12345678. Wait 2s.'],
  ['unsupported', 400, 'Slow down, account id-12345678. Wait 2s.'],
  ['context_too_long', 400, 'Slow down, account id-12345678. Wait 2s.'],
  ['unknown_model', 404, 'Slow down, account id-12345678. Wait 2s.'],
] as const)(
  'an id read alone is cut from a failure that is %s unless the kind tells the caller`s own request back',
  (code, status, told) => {
    expect(
      upstreamFailure(
        {
          code,
          message: 'Slow down, account id-12345678. Wait 2s.',
          record: { up: {} },
        },
        status,
        undefined,
        undefined,
        [{ pattern: /id-\d{4,16}/g, replacement: '', bare: true }],
      ).message,
    ).toBe(told);
  },
);

test.each([
  ['Limit of id-12345678 reached', 'Limit of reached'],
  ['Limit of id-12345678 id-87654321 reached', 'Limit of reached'],
  ['Limit  of id-12345678 reached.  Wait', 'Limit  of reached.  Wait'],
  ['Limit of id-12345678\nreached', 'Limit of \nreached'],
  ['Limit of\nid-12345678 reached', 'Limit of\n reached'],
  ['id-12345678 reached its limit', ' reached its limit'],
])(
  'an id read alone leaves one space of the two it stood between, and no other space is touched: %j',
  (message, told) => {
    expect(
      upstreamFailure(
        { code: 'overloaded', message, record: { up: {} } },
        529,
        undefined,
        undefined,
        [{ pattern: /id-\d{4,16}/g, replacement: '', bare: true }],
      ).message,
    ).toBe(told);
  },
);

test('an id read alone that something stands in for keeps both spaces around it', () => {
  expect(
    upstreamFailure(
      {
        code: 'overloaded',
        message: 'Limit of id-12345678 reached',
        record: { up: {} },
      },
      529,
      undefined,
      undefined,
      [{ pattern: /id-\d{4,16}/g, replacement: 'the account', bare: true }],
    ).message,
  ).toBe('Limit of the account reached');
});

test('an id read by the words around it is cut from every kind, each cut in its turn, and the record holds what was said', () => {
  expect(
    upstreamFailure(
      {
        code: 'invalid_request',
        message: 'Bad request for account id-12345678 (trace 77).',
        record: { up: { status: 400 } },
      },
      400,
      undefined,
      undefined,
      [
        { pattern: / for account id-\d{4,16}/g, replacement: '' },
        { pattern: / \(trace \d{1,9}\)/g, replacement: '' },
      ],
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 400,
    message: 'Bad request.',
    provider: {
      up: {
        status: 400,
        message: 'Bad request for account id-12345678 (trace 77).',
      },
    },
    upstream: true,
  });
});

test('a failure that holds nothing to cut is told as it came, and its record is left alone', () => {
  expect(
    upstreamFailure(
      { code: 'overloaded', message: 'Busy', record: { up: {} } },
      529,
      undefined,
      undefined,
      [{ pattern: /id-\d{4,16}/g, replacement: '' }],
    ),
  ).toEqual({
    code: 'overloaded',
    message: 'Busy',
    provider: { up: {} },
    upstream: true,
  });
});

test('an id is cut from all a provider said before its opening is taken, so none is left in part', () => {
  const facts = upstreamFailure(
    {
      code: undefined,
      message: 'Provider returned error',
      detail: `${'x'.repeat(292)} id-12345678 and more`,
      record: { up: {} },
    },
    500,
    undefined,
    undefined,
    [{ pattern: /id-\d{4,16}/g, replacement: '' }],
  );

  expect(facts.message).toBe(
    `Provider returned error: ${'x'.repeat(292)}  and mo`,
  );
  expect(facts.provider).toEqual({
    up: { message: `Provider returned error: ${'x'.repeat(292)} id-1234` },
  });
});

test('a refused credential is told in the SDK`s words whatever is cut, and the record holds what was said', () => {
  expect(
    upstreamFailure(
      { code: undefined, message: 'No, id-12345678', record: { up: {} } },
      401,
      undefined,
      undefined,
      [{ pattern: /id-\d{4,16}/g, replacement: '' }],
    ),
  ).toMatchObject({
    message: "The upstream refused the host's credentials or account",
    provider: { up: { message: 'No, id-12345678' } },
  });
});

test.each([
  [
    'a sentence that holds a link',
    'Rate limit reached. Please try again in 2.556s. Visit https://platform.example/account/rate-limits to learn more.',
    'Rate limit reached. Please try again in 2.556s.',
  ],
  [
    'a question that only leads into the link',
    'Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s. Need more tokens? Upgrade to Dev Tier today at https://console.example/settings/billing',
    'Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s.',
  ],
  [
    'every question that leads into the link',
    'Slow down. Too slow? Need more? See https://console.example/billing. Try again in 2s.',
    'Slow down. Try again in 2s.',
  ],
  [
    'no question that leads into a sentence with no link',
    'Slow down. Too many requests? Try again in 2s.',
    'Slow down. Too many requests? Try again in 2s.',
  ],
])('a rate limit is told without %s', (_, message, told) => {
  const facts = upstreamFailure(
    { code: 'rate_limited', message, record: { up: {} } },
    429,
  );

  expect(facts.message).toBe(told);
  expect(facts.provider).toEqual(
    told === message ? { up: {} } : { up: { message } },
  );
});

test('a rate limit told in one sentence that holds a link is told in words of our own, never as a part of it', () => {
  expect(
    upstreamFailure(
      {
        code: 'rate_limited',
        message:
          'Need more? Raise your limit at https://console.example/billing',
        record: { up: {} },
      },
      429,
    ),
  ).toEqual({
    code: 'rate_limited',
    message: "The upstream's rate limit has no room left for this request",
    provider: {
      up: {
        message:
          'Need more? Raise your limit at https://console.example/billing',
      },
    },
    upstream: true,
  });
});

test('a list of what a validator refused is told as where and what, entry by entry', () => {
  const { message } = loose({
    detail: [
      {
        type: 'less_than_equal',
        loc: ['body', 'temperature'],
        msg: 'Input should be less than or equal to 1.5',
        input: 2,
        ctx: { le: 1.5 },
      },
      {
        type: 'missing',
        loc: ['body', 'messages', 0, 'role'],
        msg: 'Field required',
      },
      { type: 'value_error', loc: [], msg: 'Value error' },
      { type: 'value_error', msg: 'No place said' },
    ],
  });

  expect(message).toBe(
    'body.temperature: Input should be less than or equal to 1.5; body.messages.0.role: Field required; Value error; No place said',
  );
});

test.each([
  [{ detail: 'Invalid API Key' }, 'Invalid API Key'],
  [{ message: 'Not found', detail: [{ loc: ['a'], msg: 'b' }] }, 'Not found'],
  [{ detail: [{ loc: ['a'] }, 'text', 7, null, { msg: 3 }] }, undefined],
  [{ detail: [] }, undefined],
  [{ detail: { msg: 'in no list' } }, undefined],
  [{ error: { type: 'x' }, detail: [{ loc: ['a'], msg: 'b' }] }, undefined],
])('what %j says at its top is read as %j', (body, told) => {
  const { message } = loose(body);

  expect(message).toBe(told);
});

test('a list that is told is kept beside the words made from it, and one that is not told is not', () => {
  expect(loose({ detail: [{ loc: ['a'], msg: 'b' }] })).toEqual({
    message: 'a: b',
    detail: [{ loc: ['a'], msg: 'b' }],
  });
  expect(loose({ detail: 'Invalid API Key' })).toEqual({
    message: 'Invalid API Key',
  });
  expect(loose({ detail: [{ loc: ['a'] }] })).toEqual({});
});

test('a list is told entry by whole entry while the text stays short, and its first entry whatever its length', () => {
  const entry = { loc: ['body', 'tools'], msg: 'x'.repeat(130) };

  expect(loose({ detail: [entry, entry, entry, entry] })).toMatchObject({
    message: `body.tools: ${'x'.repeat(130)}; body.tools: ${'x'.repeat(130)}`,
  });
  expect(loose({ detail: [{ msg: 'y'.repeat(400) }, entry] })).toMatchObject({
    message: 'y'.repeat(400),
  });
});

test('a name is cut from a list of what was refused as from any message', () => {
  expect(
    upstreamFailure(
      {
        code: undefined,
        message: 'body: Refused for account id-12345678',
        record: { up: {} },
      },
      422,
      undefined,
      undefined,
      [{ pattern: / for account id-\d{4,16}/g, replacement: '' }],
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 422,
    message: 'body: Refused',
    provider: { up: { message: 'body: Refused for account id-12345678' } },
    upstream: true,
  });
});

test('a message of many sentences is read in time that grows as its length does', () => {
  function taken(size: number) {
    const message = '. '.repeat(size / 2);
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      upstreamFailure({ code: 'rate_limited', message, record: { up: {} } });
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  expect(taken(100_000)).toBeLessThan(8 * Math.max(taken(25_000), 1));
  expect(taken(400_000)).toBeLessThan(8 * Math.max(taken(100_000), 1));
});

test.each([
  [`${'Busy. '.repeat(400)}Wait`, 'Busy. '.repeat(333).trimEnd()],
  [`${'busy '.repeat(500)}`, 'busy '.repeat(400).trimEnd()],
  ['x'.repeat(100_000), 'x'.repeat(2000)],
  [`Busy. ${'x'.repeat(100_000)}`, 'Busy.'],
])(
  'a message longer than any provider`s is told up to its last whole sentence, or else its last whole word',
  (message, told) => {
    const facts = upstreamFailure(
      { code: 'overloaded', message, record: { up: {} } },
      529,
    );

    expect(facts.message).toBe(told);
    expect(facts.provider).toEqual({ up: { message } });
  },
);

test('a message is shortened after its names are cut, so none is left in part', () => {
  expect(
    upstreamFailure(
      {
        code: 'overloaded',
        message: `${'x'.repeat(1990)} id-1234567890123456 busy. ${'y'.repeat(100)}`,
        record: { up: {} },
      },
      529,
      undefined,
      undefined,
      [{ pattern: /id-\d{4,16}/g, replacement: '', bare: true }],
    ).message,
  ).toBe(`${'x'.repeat(1990)} busy.`);
});

test('a rate limit longer than any provider`s loses its links before it is shortened', () => {
  expect(
    upstreamFailure({
      code: 'rate_limited',
      message: `Wait. ${'x'.repeat(1990)} see https://up.test/account.`,
      record: { up: {} },
    }).message,
  ).toBe('Wait.');
});

test.each([
  ['id-12345678', 500, 'The upstream answered 500'],
  [
    ' id-12345678 ',
    429,
    "The upstream's rate limit has no room left for this request",
  ],
  ['id-12345678', undefined, 'The upstream answered with an error'],
])(
  'a message that was nothing but a name, %j, says nothing, so the failure is told as one with no message is',
  (message, status, told) => {
    expect(
      upstreamFailure(
        { code: undefined, message, record: { up: {} } },
        status,
        undefined,
        undefined,
        [{ pattern: /id-\d{4,16}/g, replacement: '', bare: true }],
      ),
    ).toMatchObject({ message: told, provider: { up: { message } } });
  },
);

test.each([
  ['No capacity for id-12345678.', 'No capacity for.'],
  ['Busy for id-12345678, wait', 'Busy for, wait'],
  ['Busy (account id-12345678)', 'Busy (account)'],
  ['Busy for `id-12345678`.', 'Busy for ``.'],
  ['Busy for  id-12345678.', 'Busy for .'],
  ['Busy for id-12345678 .', 'Busy for .'],
])(
  'an id read alone takes with it the one space it leaves before a closing mark: %j',
  (message, told) => {
    expect(
      upstreamFailure(
        { code: 'overloaded', message, record: { up: {} } },
        529,
        undefined,
        undefined,
        [{ pattern: /id-\d{4,16}/g, replacement: '', bare: true }],
      ).message,
    ).toBe(told);
  },
);

test('what the adapter cuts is cut from a field`s name as from its value, at every depth, and two names the cut makes equal are both kept', () => {
  expect(
    stated(
      {
        message: 'bad request',
        'hunter2-hunter2': 'is not valid',
        'hunter2-hunter2 ': 'nor is this',
        '[cut] 2': 'said as it came',
        details: [{ 'Bearer hunter2-hunter2': true, sent: 'hunter2-hunter2' }],
      },
      (text) => text.trim().replaceAll('hunter2-hunter2', '[cut]'),
    ),
  ).toEqual({
    '[cut]': 'is not valid',
    '[cut] 2': 'nor is this',
    '[cut] 2 2': 'said as it came',
    details: [{ 'Bearer [cut]': true, sent: '[cut]' }],
  });
});

test('a field named as the prototype stays a field, with what the adapter cuts gone from inside it', () => {
  const record = stated(
    dict(parsed('{"__proto__":{"hunter2-hunter2":"is not valid"}}')),
    (text) => text.replaceAll('hunter2-hunter2', '[cut]'),
  );

  expect(JSON.stringify(record)).toBe('{"__proto__":{"[cut]":"is not valid"}}');
  expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
});

test('a field is cut short after the adapter`s cut, so what is cut is never left in part', () => {
  expect(
    stated({ raw: `${'x'.repeat(292)} hunter2-hunter2` }, (text) =>
      text.replaceAll('hunter2-hunter2', '[cut]'),
    ),
  ).toEqual({ raw: `${'x'.repeat(292)} [cut]` });
});
