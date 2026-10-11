import { expect, test } from 'bun:test';
import { failed, failure } from '../../src/wire/openai-failure.ts';

test('a failure is read with its message and the upstream`s own names', () => {
  expect(
    failure(
      'openai.chat',
      429,
      new Headers({ 'retry-after': '20' }),
      '{"error":{"message":"Rate limit reached for gpt-x in organization org-abc on tokens per min.","type":"tokens","param":null,"code":"rate_limit_exceeded"}}',
    ),
  ).toEqual({
    code: 'rate_limited',
    message:
      'Rate limit reached for gpt-x in organization org-abc on tokens per min.',
    retryAfter: 20_000,
    provider: {
      'openai.chat': {
        status: 429,
        code: 'rate_limit_exceeded',
        type: 'tokens',
        param: null,
      },
    },
    upstream: true,
  });
});

test('what the upstream calls the failure outranks its status', () => {
  const named = (status: number, error: string) =>
    failure('openai.responses', status, new Headers(), `{"error":${error}}`)
      .code;

  expect(named(400, '{"code":"context_length_exceeded"}')).toBe(
    'context_too_long',
  );
  expect(named(400, '{"code":"content_policy_violation"}')).toBe('blocked');
  expect(named(400, '{"code":"content_filter"}')).toBe('blocked');
  expect(named(400, '{"code":"bio_policy"}')).toBe('blocked');
  expect(named(404, '{"code":"model_not_found"}')).toBe('unknown_model');
  expect(named(403, '{"code":"model_not_found"}')).toBe('unknown_model');
  expect(named(429, '{"code":"rate_limit_exceeded"}')).toBe('rate_limited');
  expect(named(429, '{"code":"billing_hard_limit_reached"}')).toBe(
    'quota_exceeded',
  );
  expect(named(401, '{"code":"invalid_api_key"}')).toBe('upstream_refused');
  expect(named(401, '{"code":"account_deactivated"}')).toBe('upstream_refused');
  expect(named(400, '{"code":"invalid_prompt"}')).toBe('invalid_request');
  expect(named(400, '{"code":"server_error"}')).toBe('upstream_failed');
});

test.each([
  ['slow_down', 503, 'rate_limited'],
  ['server_is_overloaded', 503, 'overloaded'],
  ['mismatched_organization', 401, 'upstream_refused'],
  ['invalid_project', 401, 'upstream_refused'],
  ['unsupported_country_region_territory', 403, 'upstream_refused'],
  ['content_policy_violation', 400, 'blocked'],
  ['unsupported_parameter', 400, 'unsupported'],
] as const)('the code %s, whatever its status, is %s', (code, status, kind) => {
  expect(
    failure(
      'openai.chat',
      status,
      new Headers(),
      JSON.stringify({ error: { message: 'It failed.', code } }),
    ).code,
  ).toBe(kind);
});

test('a value the model does not take is unsupported, with the option it was given for', () => {
  expect(
    failure(
      'openai.chat',
      400,
      new Headers(),
      `{
  "error": {
    "message": "Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.",
    "type": "invalid_request_error",
    "param": "reasoning_effort",
    "code": "unsupported_value"
  }
}`,
    ),
  ).toEqual({
    code: 'unsupported',
    message:
      "Unsupported value: 'reasoning_effort' does not support 'max' with this model. Supported values are: 'none', 'low', 'medium', 'high', and 'xhigh'.",
    provider: {
      'openai.chat': {
        status: 400,
        code: 'unsupported_value',
        type: 'invalid_request_error',
        param: 'reasoning_effort',
      },
    },
    upstream: true,
  });
});

test('an option the Responses API refuses with no code is unsupported, by its words and the option it names', () => {
  expect(
    failure(
      'openai.responses',
      400,
      new Headers(),
      `{
  "error": {
    "message": "Unsupported parameter: 'temperature' is not supported with this model.",
    "type": "invalid_request_error",
    "param": "temperature",
    "code": null
  }
}`,
    ),
  ).toEqual({
    code: 'unsupported',
    message:
      "Unsupported parameter: 'temperature' is not supported with this model.",
    provider: {
      'openai.responses': {
        status: 400,
        code: null,
        type: 'invalid_request_error',
        param: 'temperature',
      },
    },
    upstream: true,
  });
});

test('a value refused with no code is unsupported too', () => {
  expect(
    failure(
      'openai.responses',
      400,
      new Headers(),
      `{"error":{"message":"Unsupported value: 'none' is not supported with the 'o1' model. Supported values are: 'low', 'medium', and 'high'.","type":"invalid_request_error","param":"reasoning.effort","code":null}}`,
    ).code,
  ).toBe('unsupported');
});

test.each([
  'Model incompatible request argument supplied: temperature',
  'Unrecognized request argument supplied: reasoning_effort',
  'Unrecognized request arguments supplied: made_up, other_one',
])(
  'an option Chat Completions refuses with no code and no option named is unsupported, by its whole sentence: %s',
  (message) => {
    expect(
      failure(
        'openai.chat',
        400,
        new Headers(),
        JSON.stringify({
          error: {
            message,
            type: 'invalid_request_error',
            param: null,
            code: null,
          },
        }),
      ).code,
    ).toBe('unsupported');
  },
);

test.each([
  'you must provide a model parameter',
  "Invalid value: 'Unrecognized request argument supplied: x'. Supported values are: 'function'.",
  'Unrecognized request argument supplied: x. It was in your prompt',
])(
  'a request refused with no code and no option named, in other words, stays an invalid request: %s',
  (message) => {
    expect(
      failure(
        'openai.chat',
        400,
        new Headers(),
        JSON.stringify({
          error: {
            message,
            type: 'invalid_request_error',
            param: null,
            code: null,
          },
        }),
      ).code,
    ).toBe('invalid_request');
  },
);

test('an option refused with no code in other words stays an invalid request', () => {
  expect(
    failure(
      'openai.responses',
      400,
      new Headers(),
      `{"error":{"message":"Invalid 'temperature': decimal above maximum value. Expected a value <= 2, but got 2.5 instead.","type":"invalid_request_error","param":"temperature","code":null}}`,
    ).code,
  ).toBe('invalid_request');
});

test('a code the table does not know is not outranked by the words beside it', () => {
  expect(
    failure(
      'openai.chat',
      400,
      new Headers(),
      `{"error":{"message":"Unsupported parameter: 'temperature' is not supported with this model.","type":"invalid_request_error","param":"temperature","code":"invalid_value"}}`,
    ).code,
  ).toBe('invalid_request');
});

test('an option the API does not know is unsupported', () => {
  expect(
    failure(
      'openai.responses',
      400,
      new Headers(),
      `{
  "error": {
    "message": "Unknown parameter: 'input[0].name'.",
    "type": "invalid_request_error",
    "param": "input[0].name",
    "code": "unknown_parameter"
  }
}`,
    ),
  ).toMatchObject({
    code: 'unsupported',
    message: "Unknown parameter: 'input[0].name'.",
    provider: { 'openai.responses': { param: 'input[0].name' } },
  });
});

test('a model the upstream does not know is told so, by code or by a 404 with an error', () => {
  expect(
    failure(
      'openai.chat',
      404,
      new Headers(),
      `{
    "error": {
        "message": "The model \`no-such-model-xyz\` does not exist or you do not have access to it.",
        "type": "invalid_request_error",
        "param": null,
        "code": "model_not_found"
    }
}
`,
    ),
  ).toMatchObject({
    code: 'unknown_model',
    message:
      'The model `no-such-model-xyz` does not exist or you do not have access to it.',
  });
  expect(
    failure(
      'openrouter',
      404,
      new Headers(),
      '{"error":{"message":"Not Found","code":404}}',
    ),
  ).toEqual({
    code: 'unknown_model',
    message: 'Not Found',
    provider: { openrouter: { status: 404, code: 404 } },
    upstream: true,
  });
});

test('a 404 with nothing in its body is a wrong address, which no retry mends', () => {
  expect(failure('openai.chat', 404, new Headers(), '')).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered 404',
    retryable: false,
    provider: { 'openai.chat': { status: 404 } },
    upstream: true,
  });
  expect(
    failure('openai.chat', 404, new Headers(), '<html>Not Found</html>'),
  ).toMatchObject({ code: 'upstream_failed', retryable: false });
});

test('a router`s spent credits are a spent quota, in its own words without the link to the host`s account, with what it says of the limit', () => {
  expect(
    failure(
      'openrouter',
      402,
      new Headers(),
      '{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128. To increase, visit https://openrouter.ai/workspaces/default/keys/0f1e2d3c and adjust the key\'s total limit","code":402,"metadata":{"limit_source":"openrouter_credits","remedy_hint":"Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining balance.","provider_name":null}},"user_id":"user_made_up"}',
    ),
  ).toEqual({
    code: 'quota_exceeded',
    message:
      'This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128.',
    provider: {
      openrouter: {
        status: 402,
        code: 402,
        message:
          "This request requires more credits, or fewer max_tokens. You requested up to 128000 tokens, but can only afford 58128. To increase, visit https://openrouter.ai/workspaces/default/keys/0f1e2d3c and adjust the key's total limit",
        metadata: {
          limit_source: 'openrouter_credits',
          remedy_hint:
            'Add credits at https://openrouter.ai/settings/credits, or lower max_tokens / prompt size to fit your remaining balance.',
          provider_name: null,
        },
      },
    },
    upstream: true,
  });
});

test('a router`s rate limit keeps what it says of whose limit it was', () => {
  expect(
    failure(
      'openrouter',
      429,
      new Headers(),
      '{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations","provider_name":"Google AI Studio","is_byok":false,"provider_error_code":"429","limit_source":"upstream_provider_shared_pool","remedy_hint":"Retry shortly, add your own provider key (https://openrouter.ai/settings/integrations), or route to another provider with provider routing: https://openrouter.ai/docs/features/provider-routing"}},"user_id":"user_made_up"}',
    ),
  ).toMatchObject({
    code: 'rate_limited',
    provider: {
      openrouter: {
        status: 429,
        code: 429,
        metadata: {
          provider_name: 'Google AI Studio',
          is_byok: false,
          provider_error_code: '429',
          limit_source: 'upstream_provider_shared_pool',
        },
      },
    },
  });
});

test('a provider`s whole reply beside a router`s error is kept only in part', () => {
  const { provider } = failure(
    'openrouter',
    400,
    new Headers(),
    JSON.stringify({
      error: {
        message: 'Provider returned error',
        code: 400,
        metadata: { provider_name: 'acme', raw: 'x'.repeat(5000) },
      },
    }),
  );

  expect(provider).toEqual({
    openrouter: {
      status: 400,
      code: 400,
      metadata: { provider_name: 'acme', raw: 'x'.repeat(300) },
    },
  });
});

test('the upstream`s word on another try is read from its header', () => {
  expect(
    failure(
      'openai.chat',
      429,
      new Headers({ 'x-should-retry': 'false', 'retry-after': '20' }),
      '{"error":{"message":"Rate limit reached","code":"rate_limit_exceeded"}}',
    ),
  ).toMatchObject({
    code: 'rate_limited',
    retryable: false,
    retryAfter: 20_000,
  });
  expect(
    failure(
      'openai.chat',
      409,
      new Headers({ 'x-should-retry': 'true' }),
      '{"error":{"message":"Conflict"}}',
    ),
  ).toMatchObject({ code: 'invalid_request', status: 409, retryable: true });
});

test('a provider`s own reader names a failed response first, given all that came', () => {
  expect(
    failure(
      'deepseek',
      400,
      new Headers({ 'x-ds-limit': 'balance' }),
      '{"error":{"message":"Insufficient Balance","type":"unknown_error","code":"invalid_request_error"}}',
      (status, headers, { message }) =>
        status === 400 &&
        headers.get('x-ds-limit') === 'balance' &&
        message === 'Insufficient Balance'
          ? { code: 'quota_exceeded' }
          : undefined,
    ),
  ).toMatchObject({ code: 'quota_exceeded', message: 'Insufficient Balance' });
});

test('a provider`s own reader names a failure in a stream first, with no status', () => {
  expect(
    failed(
      'deepseek',
      { message: 'Insufficient Balance', code: 'rate_limit_exceeded' },
      (status, _, { message }) =>
        status === undefined && message === 'Insufficient Balance'
          ? { code: 'quota_exceeded' }
          : undefined,
    ).code,
  ).toBe('quota_exceeded');
});

test('a failure in a stream with a number for its code is named by that number', () => {
  expect(
    failed('openrouter', { code: 429, message: 'Rate limit exceeded' }),
  ).toEqual({
    code: 'rate_limited',
    message: 'Rate limit exceeded',
    provider: { openrouter: { code: 429 } },
    upstream: true,
  });
  expect(
    failed('openrouter', { code: 502, message: 'Provider disconnected' }),
  ).not.toHaveProperty('retryable');
});

test('a spent quota and a rate limit share a status and not a meaning', () => {
  const spent = failure(
    'openai.chat',
    429,
    new Headers(),
    '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
  );

  expect(spent.code).toBe('quota_exceeded');
  expect(spent).not.toHaveProperty('status');
  expect(spent).not.toHaveProperty('retryable');
  expect(failure('openai.chat', 429, new Headers(), '{}').code).toBe(
    'rate_limited',
  );
});

test('the type names a failure whose code does not', () => {
  expect(
    failure(
      'openai.chat',
      429,
      new Headers(),
      '{"error":{"message":"quota","type":"insufficient_quota"}}',
    ).code,
  ).toBe('quota_exceeded');
  expect(
    failure(
      'openai.chat',
      400,
      new Headers(),
      '{"error":{"type":"invalid_request_error","code":"context_length_exceeded"}}',
    ).code,
  ).toBe('context_too_long');
});

test('a refused key keeps its status, and the upstream`s words that echo it, for the record alone', () => {
  expect(
    failure(
      'openai.responses',
      401,
      new Headers(),
      '{"error":{"message":"Incorrect API key provided: sk-fake-************0000.","code":"invalid_api_key"}}',
    ),
  ).toEqual({
    code: 'upstream_refused',
    message: "The upstream refused the host's credentials or account",
    provider: {
      'openai.responses': {
        status: 401,
        code: 'invalid_api_key',
        message: 'Incorrect API key provided: sk-fake-************0000.',
      },
    },
    upstream: true,
  });
});

test('a body that is not the API`s error still names the failure', () => {
  expect(
    failure(
      'openai.chat',
      502,
      new Headers(),
      '<html><h1>502 Bad Gateway</h1></html>',
    ),
  ).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered 502',
    provider: { 'openai.chat': { status: 502 } },
    upstream: true,
  });
  expect(failure('openai.chat', 500, new Headers(), '').code).toBe(
    'upstream_failed',
  );
});

test('an error that is a sentence is read as its message', () => {
  expect(
    failure('ollama', 404, new Headers(), '{"error":"model not found"}'),
  ).toEqual({
    code: 'unknown_model',
    message: 'model not found',
    provider: { ollama: { status: 404 } },
    upstream: true,
  });
});

test.each([
  ['{"message":"no Route matched with those values"}'],
  ['{"detail":"no Route matched with those values"}'],
])(
  'words at the top of a body with no error, as in %s, are the message, and name no model',
  (body) => {
    expect(failure('local', 404, new Headers(), body)).toEqual({
      code: 'upstream_failed',
      message: 'no Route matched with those values',
      retryable: false,
      provider: { local: { status: 404 } },
      upstream: true,
    });
  },
);

test('words at the top of a body beside an error are not the message', () => {
  expect(
    failure(
      'local',
      400,
      new Headers(),
      '{"message":"outer","error":{"type":"invalid_request_error"}}',
    ).message,
  ).toBe('The upstream answered 400');
});

test('a failure in a stream with a status written as text for its code is named by it', () => {
  expect(failed('openrouter', { code: '429', message: 'Slow down' })).toEqual({
    code: 'rate_limited',
    message: 'Slow down',
    provider: { openrouter: { code: '429' } },
    upstream: true,
  });
});

test('a code written as text that is no status names nothing', () => {
  expect(failed('zai', { code: '1302', message: 'Busy' }).code).toBe(
    'upstream_failed',
  );
});

test('a body with no error is a failure where the provider says what it holds, told in the words and recorded as it came', () => {
  expect(
    failure(
      'acme',
      401,
      new Headers(),
      '{"outcome":{"number":"77","words":"insufficient balance"}}',
      (_status, _headers, { number }) =>
        number === '77' ? { code: 'quota_exceeded' } : undefined,
      undefined,
      undefined,
      ({ outcome }) =>
        typeof outcome === 'object' &&
        outcome !== null &&
        !Array.isArray(outcome)
          ? { ...outcome, message: 'insufficient balance' }
          : undefined,
    ),
  ).toEqual({
    code: 'quota_exceeded',
    message: 'insufficient balance',
    provider: {
      acme: { status: 401, number: '77', words: 'insufficient balance' },
    },
    upstream: true,
  });
});

test('a body the provider says holds no failure is read as any other, with the words at its top', () => {
  expect(
    failure(
      'acme',
      500,
      new Headers(),
      '{"message":"It broke"}',
      undefined,
      undefined,
      undefined,
      () => undefined,
    ),
  ).toMatchObject({ code: 'upstream_failed', message: 'It broke' });
});

test('one provider`s own status, in a body with no error, tells nothing where no provider said it does', () => {
  expect(
    failure(
      'openai.responses',
      400,
      new Headers(),
      '{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}',
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 400,
    message: 'The upstream answered 400',
    provider: { 'openai.responses': { status: 400 } },
    upstream: true,
  });
});

test('one provider`s own code names nothing in the family`s table', () => {
  expect(
    failure(
      'openai.chat',
      400,
      new Headers(),
      '{"error":{"message":"It failed.","code":"data_inspection_failed"}}',
    ).code,
  ).toBe('invalid_request');
});

test('what the adapter cuts is cut from all the upstream said before any of it is shortened, so no cap leaves a part', () => {
  const said = `${'x'.repeat(292)} hunter2-hunter2`;

  expect(
    failure(
      'acme',
      400,
      new Headers(),
      JSON.stringify({
        error: {
          message: `${'Long. '.repeat(332)}hunter2-hunter2`,
          param: said,
          metadata: { note: said, [said]: { 'hunter2-hunter2': said } },
        },
      }),
      undefined,
      undefined,
      (text) => text.replaceAll('hunter2-hunter2', '[cut]'),
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 400,
    message: `${'Long. '.repeat(332)}[cut]`,
    provider: {
      acme: {
        status: 400,
        param: `${'x'.repeat(292)} [cut]`,
        metadata: {
          note: `${'x'.repeat(292)} [cut]`,
          [`${'x'.repeat(292)} [cut]`]: `{"[cut]":"${'x'.repeat(290)}`,
        },
      },
    },
    upstream: true,
  });
});

test('what a router`s provider said is cut before its opening is taken', () => {
  expect(
    failure(
      'acme',
      400,
      new Headers(),
      JSON.stringify({
        error: {
          message: 'Provider returned error',
          metadata: { raw: `${'x'.repeat(292)} hunter2-hunter2` },
        },
      }),
      undefined,
      undefined,
      (text) => text.replaceAll('hunter2-hunter2', '[cut]'),
    ).message,
  ).toBe(`Provider returned error: ${'x'.repeat(292)} [cut]`);
});

test('a failure is named from what the upstream said as it came, whatever is cut from the record', () => {
  expect(
    failure(
      'acme',
      400,
      new Headers(),
      '{"error":{"message":"Too long","code":"context_length_exceeded"}}',
      undefined,
      undefined,
      (text) => text.replaceAll('context_length_exceeded', '[cut]'),
    ),
  ).toEqual({
    code: 'context_too_long',
    message: 'Too long',
    provider: { acme: { status: 400, code: '[cut]' } },
    upstream: true,
  });
});

test('the sentence written where the upstream said nothing is not what the adapter cuts from', () => {
  expect(
    failure('acme', 500, new Headers(), '{}', undefined, undefined, (text) =>
      text.replaceAll('upstream', '[cut]'),
    ).message,
  ).toBe('The upstream answered 500');
});

test('a failure told inside a stream is cut the same way', () => {
  expect(
    failed(
      'acme',
      { message: 'No key hunter2-hunter2', 'hunter2-hunter2': 'is not valid' },
      undefined,
      undefined,
      (text) => text.replaceAll('hunter2-hunter2', '[cut]'),
    ),
  ).toMatchObject({
    message: 'No key [cut]',
    provider: { acme: { '[cut]': 'is not valid' } },
  });
});

test('a failure told inside a stream is named by its code alone', () => {
  expect(
    failed('openai.responses', {
      code: 'rate_limit_exceeded',
      message: 'Slow down',
    }),
  ).toEqual({
    code: 'rate_limited',
    message: 'Slow down',
    provider: { 'openai.responses': { code: 'rate_limit_exceeded' } },
    upstream: true,
  });
  expect(
    failed('openai.responses', { code: 'server_error', message: 'Oops' }),
  ).not.toHaveProperty('retryable');
  expect(failed('openai.responses', { code: 'vector_store_timeout' })).toEqual({
    code: 'upstream_failed',
    message: 'The upstream answered with an error',
    retryable: false,
    provider: { 'openai.responses': { code: 'vector_store_timeout' } },
    upstream: true,
  });
});

test('a router`s failure is read with its numeric code and what its provider said', () => {
  expect(
    failure(
      'openai.chat',
      400,
      new Headers(),
      '{"error":{"message":"Provider returned error","code":400,"metadata":{"provider_name":"acme","raw":"{\\"error\\":{\\"message\\":\\"temperature: range is 0..1\\"}}"}}}',
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 400,
    message: 'Provider returned error: temperature: range is 0..1',
    provider: {
      'openai.chat': {
        status: 400,
        code: 400,
        metadata: {
          provider_name: 'acme',
          raw: '{"error":{"message":"temperature: range is 0..1"}}',
        },
      },
    },
    upstream: true,
  });
});

test('what a router put beside the error, not in it, is read the same', () => {
  expect(
    failure(
      'openai.responses',
      400,
      new Headers(),
      '{"error":{"code":"invalid_prompt","message":"Invalid Responses API request"},"metadata":{"raw":"[{\\"path\\":[\\"temperature\\"],\\"message\\":\\"Too big: expected number to be <=2\\"}]"}}',
    ).message,
  ).toBe(
    'Invalid Responses API request: [{"path":["temperature"],"message":"Too big: expected number to be <=2"}]',
  );
});

test('a router`s failure with nothing beside it keeps its own message', () => {
  expect(
    failure(
      'openai.chat',
      400,
      new Headers(),
      '{"error":{"message":"Expected temperature to be at most 2, received 9","code":400,"metadata":{"provider_name":null}}}',
    ).message,
  ).toBe('Expected temperature to be at most 2, received 9');
});

test('what the provider said inside a stream is read from the error', () => {
  expect(
    failed('openai.chat', {
      code: 502,
      message: 'Provider returned error',
      metadata: { raw: 'upstream connect error' },
    }).message,
  ).toBe('Provider returned error: upstream connect error');
});

test('a list of what a validator refused is the message, and the record keeps the list while it is small', () => {
  expect(
    failure(
      'local',
      422,
      new Headers(),
      '{"detail":[{"type":"missing","loc":["body","messages",0,"role"],"msg":"Field required"}]}',
    ),
  ).toEqual({
    code: 'invalid_request',
    status: 422,
    message: 'body.messages.0.role: Field required',
    provider: {
      local: {
        status: 422,
        detail: [
          {
            type: 'missing',
            loc: ['body', 'messages', 0, 'role'],
            msg: 'Field required',
          },
        ],
      },
    },
    upstream: true,
  });
  expect(
    failure(
      'local',
      422,
      new Headers(),
      JSON.stringify({ detail: [{ loc: ['body'], msg: 'x'.repeat(400) }] }),
    ).provider,
  ).toEqual({
    local: {
      status: 422,
      detail: `[{"loc":["body"],"msg":"${'x'.repeat(276)}`,
    },
  });
});

test('a list beside a message that was told is not what was said, and is not kept', () => {
  expect(
    failure(
      'local',
      422,
      new Headers(),
      '{"error":{"message":"Refused"},"detail":[{"loc":["body"],"msg":"Field required"}]}',
    ).provider,
  ).toEqual({ local: { status: 422 } });
});

test.each([
  [
    401,
    'upstream_refused',
    "The upstream refused the host's credentials or account",
  ],
  [
    403,
    'upstream_refused',
    "The upstream refused the host's credentials or account",
  ],
  [404, 'unknown_model', 'Unrecognized request argument supplied: foo'],
  [429, 'rate_limited', 'Unrecognized request argument supplied: foo'],
  [500, 'upstream_failed', 'Unrecognized request argument supplied: foo'],
  [503, 'overloaded', 'Unrecognized request argument supplied: foo'],
] as const)(
  'the words of a refused option name nothing on a %i, the status OpenAI never refuses one with',
  (status, code, message) => {
    expect(
      failure(
        'openai.chat',
        status,
        new Headers(),
        '{"error":{"message":"Unrecognized request argument supplied: foo","type":null,"param":null,"code":null}}',
      ),
    ).toMatchObject({ code, message });
    expect(
      failure(
        'openai.responses',
        status,
        new Headers(),
        `{"error":{"message":"Unsupported parameter: 'foo' is not supported with this model.","param":"foo","code":null}}`,
      ).code,
    ).toBe(code);
  },
);

test.each([
  `{"error":{"message":"Busy","trace":${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}}}`,
  `{"error":${'['.repeat(100_000)}${']'.repeat(100_000)}}`,
])(
  'a body nested too deep to read is read as none, so the failure is told by its status',
  (body) => {
    expect(failure('openai.chat', 503, new Headers(), body)).toEqual({
      code: 'overloaded',
      message: 'The upstream answered 503',
      provider: { 'openai.chat': { status: 503 } },
      upstream: true,
    });
  },
);

test('what a router`s provider said nested too deep to read is told as the text it came as', () => {
  const raw = '['.repeat(100_000) + ']'.repeat(100_000);

  expect(
    failure(
      'openai.chat',
      500,
      new Headers(),
      JSON.stringify({
        error: { message: 'Provider returned error', metadata: { raw } },
      }),
    ).message,
  ).toBe(`Provider returned error: ${'['.repeat(300)}`);
});
