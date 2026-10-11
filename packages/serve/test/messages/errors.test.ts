import { expect, test } from 'bun:test';
import { error, failure, streamFailure } from '../../src/messages/errors.ts';

function body(type: string, message: string) {
  return JSON.stringify({
    type: 'error',
    error: { type, message },
    request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
  });
}

test.each([
  [400, 'invalid_request_error', 'invalid_request'],
  [413, 'request_too_large', 'invalid_request'],
] as const)('a %i %s is %s, and keeps its status', (status, type, code) => {
  expect(failure(status, new Headers(), body(type, 'It failed.'))).toEqual({
    code,
    status,
    message: 'It failed.',
    provider: {
      anthropic: { type, status, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' },
    },
    upstream: true,
  });
});

test.each([
  [429, 'rate_limit_error', 'rate_limited'],
  [402, 'billing_error', 'quota_exceeded'],
  [500, 'api_error', 'upstream_failed'],
  [504, 'timeout_error', 'timed_out'],
  [529, 'overloaded_error', 'overloaded'],
] as const)(
  'a %i %s is %s, with no status of the upstream`s',
  (status, type, code) => {
    expect(failure(status, new Headers(), body(type, 'It failed.'))).toEqual({
      code,
      message: 'It failed.',
      provider: {
        anthropic: { type, status, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' },
      },
      upstream: true,
    });
  },
);

test('the error type outranks the status', () => {
  const facts = failure(
    400,
    new Headers(),
    body('overloaded_error', 'Overloaded.'),
  );

  expect(facts.code).toBe('overloaded');
  expect(facts).not.toHaveProperty('status');
});

test("a refused key is the host's, with no status of its own", () => {
  for (const [status, type] of [
    [401, 'authentication_error'],
    [403, 'permission_error'],
  ] as const) {
    const facts = failure(
      status,
      new Headers(),
      body(type, 'invalid x-api-key'),
    );
    expect(facts.code).toBe('upstream_refused');
    expect(facts).not.toHaveProperty('status');
    expect(facts).not.toHaveProperty('retryable');
    expect(facts.message).toBe(
      "The upstream refused the host's credentials or account",
    );
    expect(facts.provider).toEqual({
      anthropic: {
        type,
        status,
        request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
        message: 'invalid x-api-key',
      },
    });
  }
});

test('a model the upstream does not know is named by it', () => {
  expect(
    failure(
      404,
      new Headers({ 'x-should-retry': 'false' }),
      '{"type":"error","error":{"type":"not_found_error","message":"model: no-such-model-xyz"},"request_id":"req_011CZq7Lm2Xv9Rt4Kp8Wd3Nh"}',
    ),
  ).toEqual({
    code: 'unknown_model',
    message: 'model: no-such-model-xyz',
    retryable: false,
    provider: {
      anthropic: {
        status: 404,
        type: 'not_found_error',
        request_id: 'req_011CZq7Lm2Xv9Rt4Kp8Wd3Nh',
      },
    },
    upstream: true,
  });
});

test('an address the API does not have names no model, and no retry mends it', () => {
  expect(
    failure(
      404,
      new Headers(),
      '{"type":"error","error":{"type":"not_found_error","message":"Not found"},"request_id":"req_011CNh6Wd3Kp8Rt4Xv9Lm2Zq"}',
    ),
  ).toEqual({
    code: 'upstream_failed',
    message: 'Not found',
    retryable: false,
    provider: {
      anthropic: {
        status: 404,
        type: 'not_found_error',
        request_id: 'req_011CNh6Wd3Kp8Rt4Xv9Lm2Zq',
      },
    },
    upstream: true,
  });
});

test('a rate limit no wait can meet is not worth another try, as the upstream says', () => {
  expect(
    failure(
      429,
      new Headers({ 'x-should-retry': 'false' }),
      '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit of 2,000,000 input tokens per minute (org: 00000000-0000-4000-8000-000000000000, model: claude-haiku-5-5). For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Reduce the prompt length or the maximum tokens requested, or try again later. View your current limits at https://console.anthropic.com/settings/limits. You may also contact sales at https://claude.com/contact-sales to discuss your options for a rate limit increase."},"request_id":"req_011CftWXS7e9mkXL3Vf2TBMa"}',
    ),
  ).toMatchObject({ code: 'rate_limited', retryable: false });
});

test('a spend limit that is reached is a spent quota, not a rate limit to wait out', () => {
  expect(
    failure(
      429,
      new Headers(),
      '{"type":"error","error":{"type":"rate_limit_error","message":"Your organization has reached its spend limit.","details":{"error_code":"enforced_spend_limit_reached"}},"request_id":"req_1"}',
    ),
  ).toEqual({
    code: 'quota_exceeded',
    message: 'Your organization has reached its spend limit.',
    provider: {
      anthropic: {
        status: 429,
        type: 'rate_limit_error',
        details: { error_code: 'enforced_spend_limit_reached' },
        request_id: 'req_1',
      },
    },
    upstream: true,
  });
});

test('a bill the upstream turned down is a spent quota, in its own words', () => {
  expect(
    failure(
      402,
      new Headers(),
      body('billing_error', 'Your payment could not be processed.'),
    ),
  ).toMatchObject({
    code: 'quota_exceeded',
    message: 'Your payment could not be processed.',
  });
});

test('usage limits that are reached are a spent quota, though told as a bad request', () => {
  expect(
    failure(
      400,
      new Headers(),
      body(
        'invalid_request_error',
        'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
      ),
    ),
  ).toMatchObject({
    code: 'quota_exceeded',
    message:
      'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
  });
});

test('a credit balance too low is a spent quota, though told as a bad request', () => {
  const facts = failure(
    400,
    new Headers(),
    body(
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    ),
  );

  expect(facts.code).toBe('quota_exceeded');
  expect(facts).not.toHaveProperty('status');
});

test('a prompt too long for the model is told from other bad requests', () => {
  expect(
    failure(
      400,
      new Headers(),
      body(
        'invalid_request_error',
        'prompt is too long: 250000 tokens > 200000 maximum',
      ),
    ).code,
  ).toBe('context_too_long');
});

test("a body that is not this API's error is named by its status", () => {
  expect(failure(529, new Headers(), '<html>overloaded</html>')).toEqual({
    code: 'overloaded',
    message: 'The upstream answered 529',
    provider: { anthropic: { status: 529 } },
    upstream: true,
  });
  expect(failure(401, new Headers(), '').code).toBe('upstream_refused');
  expect(failure(503, new Headers(), '').code).toBe('overloaded');
  expect(failure(502, new Headers(), '').code).toBe('upstream_failed');
  expect(failure(502, new Headers(), '')).not.toHaveProperty('retryable');
  expect(failure(418, new Headers(), '{}').code).toBe('invalid_request');
});

test('the wait an upstream asks for is read from its headers', () => {
  const limited = body('rate_limit_error', 'Slow down.');
  expect(
    failure(429, new Headers({ 'retry-after': '12' }), limited).retryAfterMs,
  ).toBe(12000);
  expect(
    failure(429, new Headers({ 'retry-after-ms': '250' }), limited)
      .retryAfterMs,
  ).toBe(250);
  expect(failure(429, new Headers(), limited)).not.toHaveProperty(
    'retryAfterMs',
  );
});

test('a failure told inside a stream is named by its type alone', () => {
  expect(
    streamFailure({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    }),
  ).toEqual({
    code: 'overloaded',
    message: 'Overloaded',
    provider: { anthropic: { type: 'overloaded_error' } },
    upstream: true,
  });
  expect(streamFailure({ type: 'error' })).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered with an error',
    retryable: false,
    provider: { anthropic: {} },
    upstream: true,
  });
});

test("the caller's own mistake is described in this API's error body", () => {
  expect(
    error({
      code: 'invalid_request',
      status: 400,
      message: 'max_tokens must be a number',
    }),
  ).toEqual({
    status: 400,
    body: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'max_tokens must be a number',
      },
    },
  });
});

test('the facts given are written as they are, with nothing withheld', () => {
  expect(
    error({
      code: 'overloaded',
      status: 529,
      message: 'The upstream is overloaded',
      upstream: true,
    }),
  ).toEqual({
    status: 529,
    body: {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'The upstream is overloaded',
      },
    },
  });
});

test.each([
  ['rate_limited', 429, 'rate_limit_error'],
  ['context_too_long', 400, 'invalid_request_error'],
  ['blocked', 400, 'invalid_request_error'],
  ['unsupported', 400, 'invalid_request_error'],
  ['invalid_request', 400, 'invalid_request_error'],
  ['unknown_model', 404, 'not_found_error'],
  ['upstream_refused', 502, 'api_error'],
  ['upstream_failed', 502, 'api_error'],
  ['timed_out', 504, 'timeout_error'],
])(
  '%s, with no status but its kind`s %i, is written as %s',
  (code, status, type) => {
    expect(error({ code, message: 'x' })).toEqual({
      status,
      body: { type: 'error', error: { type, message: 'x' } },
    });
  },
);

test('a request of too many bytes keeps the name this API gives it', () => {
  expect(
    error({ code: 'invalid_request', status: 413, message: 'x' }),
  ).toMatchObject({
    status: 413,
    body: { error: { type: 'request_too_large' } },
  });
});

test('the type of what a model call can end in never follows the status', () => {
  const typed = (code: string, status: number) =>
    error({ code, status, message: 'x' }).body;

  expect(typed('context_too_long', 403)).toMatchObject({
    error: { type: 'invalid_request_error' },
  });
  expect(typed('quota_exceeded', 402)).toMatchObject({
    error: { type: 'billing_error' },
  });
  expect(typed('upstream_failed', 404)).toMatchObject({
    error: { type: 'api_error' },
  });
});

test('a kind no model call ends in is written as it was, by its code or its status', () => {
  for (const [code, status, type] of [
    ['unauthenticated', 401, 'authentication_error'],
    ['forbidden', 403, 'permission_error'],
    ['aborted', 499, 'invalid_request_error'],
    ['limit_reached', 500, 'api_error'],
    ['empty_prompt', 422, 'invalid_request_error'],
    ['empty_prompt', 413, 'request_too_large'],
  ] as const) {
    expect(error({ code, status, message: 'x' })).toMatchObject({
      status,
      body: { type: 'error', error: { type } },
    });
  }
  expect(error({ code: 'internal', message: 'x' }).status).toBe(500);
});

test.each([
  [
    'beside the error',
    {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Provider refused' },
      metadata: { raw: 'temperature: range is 0..1' },
    },
  ],
  [
    'in the error',
    {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Provider refused',
        metadata: { raw: 'temperature: range is 0..1' },
      },
    },
  ],
])(
  'what a router`s provider said, %s, is told after its message',
  (_, body) => {
    expect(failure(400, new Headers(), JSON.stringify(body)).message).toBe(
      'Provider refused: temperature: range is 0..1',
    );
  },
);

test('a router`s failure with nothing beside it keeps its own message', () => {
  expect(
    failure(
      400,
      new Headers(),
      '{"type":"error","error":{"type":"invalid_request_error","message":"Expected temperature to be at most 2, received 9","error_type":"invalid_request"},"request_id":"gen-1","metadata":{"provider_name":null}}',
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 400,
    message: 'Expected temperature to be at most 2, received 9',
    provider: {
      anthropic: {
        status: 400,
        type: 'invalid_request_error',
        error_type: 'invalid_request',
        request_id: 'gen-1',
        metadata: { provider_name: null },
      },
    },
    upstream: true,
  });
});

test('a failure told inside a stream is named by the same table', () => {
  expect(
    streamFailure({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Spend limit reached',
        details: { error_code: 'enforced_spend_limit_reached' },
      },
    }).code,
  ).toBe('quota_exceeded');
  expect(
    streamFailure({
      type: 'error',
      error: { type: 'not_found_error', message: 'Not found' },
    }),
  ).toMatchObject({ code: 'upstream_failed', retryable: false });
});

test.each([
  ['quota_exceeded', 402, 'billing_error'],
  ['overloaded', 529, 'overloaded_error'],
])(
  '%s is answered with %i, this API`s own status for it, as %s',
  (code, status, type) => {
    expect(error({ code, message: 'x' })).toEqual({
      status,
      body: { type: 'error', error: { type, message: 'x' } },
    });
  },
);

test('an error that is a sentence is read as its message', () => {
  expect(failure(404, new Headers(), '{"error":"model not found"}')).toEqual({
    code: 'unknown_model',
    message: 'model not found',
    provider: { anthropic: { status: 404 } },
    upstream: true,
  });
});

test('a list of what a gateway`s validator refused is the message, as where and what, and the record keeps the list', () => {
  expect(
    failure(
      422,
      new Headers(),
      '{"detail":[{"type":"missing","loc":["body","max_tokens"],"msg":"Field required","input":{}}]}',
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 422,
    message: 'body.max_tokens: Field required',
    provider: {
      anthropic: {
        status: 422,
        detail: [
          {
            type: 'missing',
            loc: ['body', 'max_tokens'],
            msg: 'Field required',
            input: {},
          },
        ],
      },
    },
    upstream: true,
  });
});

test.each([
  ['{"message":"no Route matched with those values"}'],
  ['{"detail":"no Route matched with those values"}'],
])(
  'words at the top of a body with no error, as in %s, are the message',
  (body) => {
    expect(failure(404, new Headers(), body)).toEqual({
      code: 'upstream_failed',
      message: 'no Route matched with those values',
      retryable: false,
      provider: { anthropic: { status: 404 } },
      upstream: true,
    });
  },
);

test('a rate limit is told without the organisation it names and without its links, and the record holds all of it', () => {
  const said =
    "This request would exceed your organization's rate limit of 30,000 input tokens per minute (org: 3a68180d-2011-422d-afea-f25a64613009, model: claude-sonnet-4-20250514). For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later. You may also contact sales at https://www.anthropic.com/contact-sales to discuss your options for a rate limit increase.";

  expect(failure(429, new Headers(), body('rate_limit_error', said))).toEqual({
    code: 'rate_limited',
    message:
      "This request would exceed your organization's rate limit of 30,000 input tokens per minute (model: claude-sonnet-4-20250514). You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later.",
    provider: {
      anthropic: {
        type: 'rate_limit_error',
        status: 429,
        request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
        message: said,
      },
    },
    upstream: true,
  });
});

test.each([
  [
    'in a body',
    'Number of request tokens has exceeded your per-minute rate limit (org: 3a68180d-2011-422d-afea-f25a64613009, model: claude-sonnet-4-20250514).',
    'Number of request tokens has exceeded your per-minute rate limit (model: claude-sonnet-4-20250514).',
  ],
  [
    'in words not seen before',
    'Rate limited; org: 3a68180d-2011-422d-afea-f25a64613009',
    'Rate limited; ',
  ],
])(
  'the organisation a rate limit names, %s, is cut from what the caller is told',
  (_, said, told) => {
    expect(
      failure(429, new Headers(), body('rate_limit_error', said)).message,
    ).toBe(told);
    expect(
      streamFailure({
        type: 'error',
        error: { type: 'rate_limit_error', message: said },
      }),
    ).toMatchObject({
      message: told,
      provider: { anthropic: { message: said } },
    });
  },
);

test.each([
  'messages.1.content.0: tool_use_id 3a68180d-2011-422d-afea-f25a64613009 not found',
  'tools.0.custom.name: org: 3a68180d-2011-422d-afea-f25a64613009 is not a valid name',
])(
  'a request told back to the caller keeps an id of the caller`s own: %s',
  (said) => {
    expect(
      failure(400, new Headers(), body('invalid_request_error', said)),
    ).toEqual({
      code: 'invalid_request',
      status: 400,
      message: said,
      provider: {
        anthropic: {
          type: 'invalid_request_error',
          status: 400,
          request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy',
        },
      },
      upstream: true,
    });
  },
);

test.each([
  [
    'longer than any seen',
    `Rate limited; org: ${'3a68180d-2011-422d-afea-f25a64613009'.repeat(3)}`,
    'Rate limited; ',
  ],
  [
    'under a label in capitals',
    'Rate limited (Org: 3a68180d-2011-422d-afea-f25a64613009, model: claude-sonnet-4-20250514).',
    'Rate limited (model: claude-sonnet-4-20250514).',
  ],
  [
    'alone under a label in capitals',
    'Rate limited for ORG: 3A68180D-2011-422D-AFEA-F25A64613009 today',
    'Rate limited for today',
  ],
  [
    'with no dash in it',
    'Rate limited; org: 3a68180d2011422dafeaf25a64613009',
    'Rate limited; ',
  ],
])('the organisation a rate limit names, %s, is cut whole', (_, said, told) => {
  expect(
    failure(429, new Headers(), body('rate_limit_error', said)).message,
  ).toBe(told);
});

test.each([
  'Bad table row (org: ----------------, dept: x)',
  'Bad table row (org: 3a68180d, dept: x)',
  'Bad table row (org: -3a68180d-2011-422d, dept: x)',
])('what has no id`s shape is no organisation: %s', (said) => {
  expect(
    failure(400, new Headers(), body('invalid_request_error', said)).message,
  ).toBe(said);
});

test.each([
  ['org: ', ''],
  ['(org: ', ''],
  ['(org: 3a68180d-', ''],
  ['-', 'org: 3'],
  ['3a68180d', '(org: '],
  ['3a68180d-', '(org: '],
  [' org: 3a68180d-2011-422d-afea-f25a64613009', ''],
])(
  'a message that repeats %j after %j is read in time that grows as its length does',
  (piece, opening) => {
    function taken(size: number) {
      const said = opening + piece.repeat(size / piece.length);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        failure(529, new Headers(), body('overloaded_error', said));
        best = Math.min(best, performance.now() - start);
      }
      return best;
    }

    expect(taken(1_000_000)).toBeLessThan(40 * Math.max(taken(100_000), 1));
  },
);

test('a body nested too deep to read is read as none, so the failure is told by its status', () => {
  expect(
    failure(
      500,
      new Headers(),
      `{"type":"error","error":{"type":"api_error","message":"Busy","trace":${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}}}`,
    ),
  ).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered 500',
    provider: { anthropic: { status: 500 } },
    upstream: true,
  });
});
