import { expect, test } from 'bun:test';
import {
  Aborted,
  Blocked,
  ContextTooLong,
  disclosed,
  type ErrorFacts,
  Forbidden,
  fromFacts,
  InvalidOutput,
  InvalidRequest,
  type KnownCode,
  LimitReached,
  MottyError,
  Overloaded,
  QuotaExceeded,
  RateLimited,
  RouteLoop,
  stopReason,
  TimedOut,
  toFacts,
  Unauthenticated,
  UnknownModel,
  UnknownRoute,
  Unsupported,
  UpstreamFailed,
  UpstreamRefused,
} from '../../src/data/errors.ts';

// A query on the path loads the module again, as a bundle and its host each do.
const copy: typeof import('../../src/data/errors.ts') = await import(
  ['../../src/data/errors.ts', 'copy'].join('?')
);

test('a defined error carries its code and status', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  const error = new EmptyPrompt('The request has no messages');
  expect([error.code, error.status, error.message]).toEqual([
    'empty_prompt',
    400,
    'The request has no messages',
  ]);
});

test('a defined error is an instance of its class, the base and Error', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  const error = new EmptyPrompt('The request has no messages');
  expect([
    error instanceof EmptyPrompt,
    error instanceof MottyError,
    error instanceof Error,
  ]).toEqual([true, true, true]);
});

test('a defined error is not an instance of another defined error', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  expect(new EmptyPrompt('empty') instanceof Overloaded).toBe(false);
});

test('a defined error is named after its class', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  expect(new EmptyPrompt('empty').name).toBe('EmptyPrompt');
});

test('a defined error is not retryable unless marked', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  expect(new EmptyPrompt('empty').retryable).toBe(false);
});

test('a defined error marked retryable is retryable', () => {
  class Busy extends MottyError.define('busy', 503, { retryable: true }) {}
  expect(new Busy('busy').retryable).toBe(true);
});

test.each([
  [RateLimited, 'RateLimited', 'rate_limited', 429, true],
  [QuotaExceeded, 'QuotaExceeded', 'quota_exceeded', 429, false],
  [Overloaded, 'Overloaded', 'overloaded', 503, true],
  [ContextTooLong, 'ContextTooLong', 'context_too_long', 400, false],
  [Blocked, 'Blocked', 'blocked', 400, false],
  [Unsupported, 'Unsupported', 'unsupported', 400, false],
  [Forbidden, 'Forbidden', 'forbidden', 403, false],
  [InvalidRequest, 'InvalidRequest', 'invalid_request', 400, false],
  [UpstreamFailed, 'UpstreamFailed', 'upstream_failed', 502, true],
  [UpstreamRefused, 'UpstreamRefused', 'upstream_refused', 502, false],
  [UnknownModel, 'UnknownModel', 'unknown_model', 404, false],
  [TimedOut, 'TimedOut', 'timed_out', 504, true],
  [Aborted, 'Aborted', 'aborted', 499, false],
  [Unauthenticated, 'Unauthenticated', 'unauthenticated', 401, false],
  [InvalidOutput, 'InvalidOutput', 'invalid_output', 502, false],
  [LimitReached, 'LimitReached', 'limit_reached', 500, false],
  [RouteLoop, 'RouteLoop', 'route_loop', 500, false],
  [UnknownRoute, 'UnknownRoute', 'unknown_route', 500, false],
])(
  '%p is named %s with code %s, status %d and retryable %p',
  (Known, name, code, status, retryable) => {
    const error = new Known('failed');
    expect([error.name, error.code, error.status, error.retryable]).toEqual([
      name,
      code,
      status,
      retryable,
    ]);
  },
);

test('an error carries the retry hint it was given', () => {
  expect(
    new RateLimited('slow down', { retryAfterMs: 1500 }).retryAfterMs,
  ).toBe(1500);
});

test('an error given no retry hint has none', () => {
  expect('retryAfterMs' in new RateLimited('slow down')).toBe(false);
});

test('a raised error overrides the defaults of its class', () => {
  const error = new Overloaded('busy', {
    status: 529,
    retryable: false,
    provider: { anthropic: { type: 'overloaded_error' } },
  });
  expect([error.status, error.retryable, error.provider]).toEqual([
    529,
    false,
    { anthropic: { type: 'overloaded_error' } },
  ]);
});

test('an undefined cast past the types keeps the defaults of the class', () => {
  // @ts-expect-error
  const error = new RateLimited('slow down', {
    status: undefined,
    retryable: undefined,
  });
  expect([error.status, error.retryable]).toEqual([429, true]);
});

test('a base error raised by hand takes a status and can be retryable', () => {
  const error = new MottyError('flaky', { status: 502, retryable: true });
  expect([error.code, error.status, error.retryable]).toEqual([
    'internal',
    502,
    true,
  ]);
});

test('an error given no provider data has none', () => {
  expect('provider' in new RateLimited('slow down')).toBe(false);
});

test('an error carries the cause it was given', () => {
  const cause = new Error('socket closed');
  expect(new Overloaded('busy', { cause }).cause).toBe(cause);
});

test('a known error gives its own facts', () => {
  expect(toFacts(new Overloaded('busy'))).toEqual({
    code: 'overloaded',
    status: 503,
    message: 'busy',
    retryable: true,
  });
});

test('the facts of an error include its retry hint', () => {
  expect(toFacts(new RateLimited('slow down', { retryAfterMs: 1500 }))).toEqual(
    {
      code: 'rate_limited',
      status: 429,
      message: 'slow down',
      retryable: true,
      retryAfterMs: 1500,
    },
  );
});

test('the facts of an error include its provider data', () => {
  expect(
    toFacts(new Blocked('no', { provider: { openai: { param: 'input' } } })),
  ).toEqual({
    code: 'blocked',
    status: 400,
    message: 'no',
    retryable: false,
    provider: { openai: { param: 'input' } },
  });
});

test('a plain error gives its own message and stack as a server failure', () => {
  const thrown = new TypeError('handler returned nothing');
  expect(toFacts(thrown)).toStrictEqual({
    code: 'internal',
    status: 500,
    message: 'handler returned nothing',
    retryable: false,
    unexpected: true,
    stack: String(thrown.stack),
  });
});

test('a plain error with no stack gives facts with none', () => {
  expect(
    toFacts(Object.assign(new Error('no trace'), { stack: undefined })),
  ).toStrictEqual({
    code: 'internal',
    status: 500,
    message: 'no trace',
    retryable: false,
    unexpected: true,
  });
});

test.each([
  ['a string', 'out of cheese', 'out of cheese'],
  ['undefined', undefined, 'undefined'],
  ['null', null, 'null'],
  ['an object', { reason: 'busy' }, '{"reason":"busy"}'],
  ['a number', 503, '503'],
  ['a bigint, which JSON cannot hold', 5n, 'bigint'],
  ['a symbol', Symbol('stop'), 'Symbol(stop)'],
])('%s thrown is described in a server failure', (_, thrown, described) => {
  expect(toFacts(thrown)).toStrictEqual({
    code: 'internal',
    status: 500,
    message: `A value that is not an error was thrown: ${described}`,
    retryable: false,
    unexpected: true,
  });
});

test('the facts of an SDK error hold no stack', () => {
  expect('stack' in toFacts(new Overloaded('busy'))).toBe(false);
});

test('a caller is told the own message of an error that is their mistake', () => {
  expect(
    disclosed(
      toFacts(
        new RateLimited('Slow down, acme', {
          retryAfterMs: 1500,
          provider: { openai: { type: 'requests' } },
        }),
      ),
    ),
  ).toStrictEqual({
    code: 'rate_limited',
    status: 429,
    message: 'Slow down, acme',
    retryable: true,
    retryAfterMs: 1500,
    provider: { openai: { type: 'requests' } },
  });
});

test('a caller is told the own message of a server failure an SDK error names', () => {
  expect(
    disclosed(
      toFacts(
        new Overloaded('The index is rebuilding', {
          retryAfterMs: 1500,
          provider: { anthropic: { request_id: 'req_1' } },
        }),
      ),
    ),
  ).toStrictEqual({
    code: 'overloaded',
    status: 503,
    message: 'The index is rebuilding',
    retryable: true,
    retryAfterMs: 1500,
    provider: { anthropic: { request_id: 'req_1' } },
  });
});

test('a caller is told the own message of the base error raised on purpose', () => {
  expect(disclosed(toFacts(new MottyError('The index is gone'))).message).toBe(
    'The index is gone',
  );
});

test('a caller is told nothing of a thrown value that is not an SDK error', () => {
  expect(disclosed(toFacts(new Error('password is hunter2')))).toStrictEqual({
    code: 'internal',
    status: 500,
    message: 'Internal error',
    retryable: false,
  });
});

test('a caller is never given a stack', () => {
  expect(
    'stack' in
      disclosed({
        code: 'teapot',
        status: 418,
        message: 'no',
        stack: 'at brew',
      }),
  ).toBe(false);
});

test.each([
  ['a string', 'password is hunter2'],
  ['an object', { password: 'hunter2' }],
])('a caller is told nothing of %s thrown', (_, thrown) => {
  expect(disclosed(toFacts(thrown))).toStrictEqual({
    code: 'internal',
    status: 500,
    message: 'Internal error',
    retryable: false,
  });
});

test('a caller is told nothing of a thrown value that crossed the contract and was raised again', () => {
  expect(
    disclosed(toFacts(fromFacts(toFacts(new Error('password is hunter2'))))),
  ).toStrictEqual({
    code: 'internal',
    status: 500,
    message: 'Internal error',
    retryable: false,
  });
});

test('a caller is told the own message of an error with no status', () => {
  expect(
    disclosed({ code: 'teapot', message: 'short and stout' }),
  ).toStrictEqual({
    code: 'teapot',
    message: 'short and stout',
  });
});

test('a caller is told the own message of a known class given a server status', () => {
  expect(
    disclosed(toFacts(new Blocked('policy v3 matched', { status: 500 })))
      .message,
  ).toBe('policy v3 matched');
});

test('the SDK error a signal was stopped with is the error raised', () => {
  const limit = new TimedOut('The host allows 30 seconds');
  expect(stopReason(AbortSignal.abort(limit).reason)).toBe(limit);
});

test('an SDK error of another copy a signal was stopped with is the error raised', () => {
  const limit = new copy.TimedOut('The host allows 30 seconds');
  expect(stopReason(limit) === limit).toBe(true);
});

test.each([
  ['no reason', AbortSignal.abort().reason],
  ['a string', 'caller left'],
  ['a plain error', new Error('caller left')],
  ['undefined', undefined],
])('a signal stopped with %s raises a fresh aborted error', (_, reason) => {
  const raised = stopReason(reason);
  expect([raised instanceof Aborted, raised.code, raised.status]).toEqual([
    true,
    'aborted',
    499,
  ]);
});

test('a signal stopped by its platform timer raises a timeout', () => {
  expect(
    stopReason(new DOMException('timed out', 'TimeoutError')) instanceof
      TimedOut,
  ).toBe(true);
});

test('a stop reason and the facts of the same value name one error', () => {
  expect(
    [
      new DOMException('signal fired', 'AbortError'),
      new DOMException('signal fired', 'TimeoutError'),
      new Overloaded('busy'),
    ].map((value) => toFacts(stopReason(value)).code === toFacts(value).code),
  ).toEqual([true, true, true]);
});

test('the known codes are offered by type and any other code is accepted', () => {
  const known: ErrorFacts['code'][] = ['rate_limited', 'internal', 'db_down'];
  const mine: KnownCode[] = [
    'rate_limited',
    'internal',
    // @ts-expect-error
    'rate_limted',
  ];
  expect([known.length, mine.length]).toEqual([3, 3]);
});

test('a stop reason made here carries the cause given', () => {
  const cause = new UpstreamFailed('The first model was down');

  expect(stopReason(undefined, cause).cause).toBe(cause);
  expect(stopReason(AbortSignal.abort().reason, cause).cause).toBe(cause);
  expect(
    stopReason(new DOMException('timed out', 'TimeoutError'), cause).cause,
  ).toBe(cause);
  expect(Object.hasOwn(stopReason(undefined), 'cause')).toBe(false);
});

test('the error a host stopped with is given no cause', () => {
  const reason = new TimedOut('The host allows 30 seconds');

  expect(stopReason(reason, new UpstreamFailed('The model was down'))).toBe(
    reason,
  );
  expect(Object.hasOwn(reason, 'cause')).toBe(false);
});

test('a stop is worded for a call and a whole request alike', () => {
  expect([
    stopReason(undefined).message,
    stopReason(AbortSignal.abort().reason).message,
  ]).toEqual(['The work was stopped', 'The work was stopped']);
});

test('a timeout is worded for a call and a whole request alike', () => {
  expect([
    stopReason(new DOMException('timed out', 'TimeoutError')).message,
    stopReason(Object.assign(new Error('late'), { name: 'TimeoutError' }))
      .message,
  ]).toEqual(['The work timed out', 'The work timed out']);
});

test('the facts of an error say what caused it, one level down', () => {
  expect(
    toFacts(
      new MottyError('The stream failed', {
        cause: new Error('The tokenizer gave no text', {
          cause: new Error('The file was missing'),
        }),
      }),
    ),
  ).toStrictEqual({
    code: 'internal',
    status: 500,
    message: 'The stream failed',
    retryable: false,
    cause: 'The tokenizer gave no text',
  });
});

test('the facts of a thrown value that is not an SDK error say its cause', () => {
  expect(
    toFacts(new Error('Could not load', { cause: new Error('No such file') }))
      .cause,
  ).toBe('No such file');
});

test.each([
  ['a string', 'socket closed', 'socket closed'],
  ['plain data', { socket: 'closed' }, '{"socket":"closed"}'],
  ['a big integer', 7n, 'bigint'],
  ['null', null, 'null'],
])('a cause that is %s is told as text', (_, cause, told) => {
  expect(toFacts(new Overloaded('busy', { cause })).cause).toBe(told);
});

test('an error with no cause has none in its facts', () => {
  expect([
    Object.hasOwn(toFacts(new Overloaded('busy')), 'cause'),
    Object.hasOwn(toFacts(new Error('failed')), 'cause'),
  ]).toEqual([false, false]);
});

test('a caller is never told the cause', () => {
  const cause = new Error('db-7 refused');

  expect([
    Object.hasOwn(
      disclosed(toFacts(new InvalidRequest('No messages', { cause }))),
      'cause',
    ),
    Object.hasOwn(
      disclosed(toFacts(new Overloaded('busy', { cause }))),
      'cause',
    ),
    Object.hasOwn(disclosed(toFacts(new Error('failed', { cause }))), 'cause'),
  ]).toEqual([false, false, false]);
});

test('facts with a cause raise an error that carries it and gives the same facts', () => {
  const facts = toFacts(
    new Overloaded('busy', { cause: new Error('socket closed') }),
  );

  expect(fromFacts(facts).cause).toBe('socket closed');
  expect(toFacts(fromFacts(facts))).toStrictEqual(facts);
  expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
});

test('a cause of the wrong type in facts is read as absent', () => {
  expect(
    Object.hasOwn(
      fromFacts(JSON.parse('{"code":"blocked","message":"no","cause":{}}')),
      'cause',
    ),
  ).toBe(false);
});

test.each([
  ['AbortError', 'aborted', 499, 'The work was stopped', false],
  ['TimeoutError', 'timed_out', 504, 'The work timed out', true],
])(
  'a platform %s gives the %s facts',
  (name, code, status, message, retryable) => {
    expect([
      toFacts(new DOMException('signal fired', name)),
      toFacts(Object.assign(new Error('signal fired'), { name })),
    ]).toEqual([
      { code, status, message, retryable },
      { code, status, message, retryable },
    ]);
  },
);

test('the reason of a stopped signal gives the aborted facts', () => {
  expect(toFacts(AbortSignal.abort().reason).code).toBe('aborted');
});

test('facts with a known code raise that class', () => {
  expect(
    fromFacts({ code: 'overloaded', status: 503, message: 'busy' }),
  ).toBeInstanceOf(Overloaded);
});

test.each([
  ['quota_exceeded', QuotaExceeded],
  ['forbidden', Forbidden],
  ['invalid_request', InvalidRequest],
  ['upstream_failed', UpstreamFailed],
])('facts with the code %s raise its class', (code, Known) => {
  expect(fromFacts({ code, status: 500, message: 'no' })).toBeInstanceOf(Known);
});

test('a known class keeps the status the upstream gave', () => {
  const error = fromFacts({ code: 'overloaded', status: 529, message: 'busy' });
  expect([error instanceof Overloaded, error.status, error.retryable]).toEqual([
    true,
    529,
    true,
  ]);
});

test('a spent quota is not retryable and a rate limit is', () => {
  expect(
    ['quota_exceeded', 'rate_limited'].map(
      (code) => fromFacts({ code, status: 429, message: 'no' }).retryable,
    ),
  ).toEqual([false, true]);
});

test('facts make an unknown code retryable', () => {
  const error = fromFacts({
    code: 'teapot',
    status: 418,
    message: 'no',
    retryable: true,
  });
  expect([error.code, error.retryable]).toEqual(['teapot', true]);
});

test('facts make a known class not retryable', () => {
  expect(
    fromFacts({
      code: 'rate_limited',
      status: 429,
      message: 'no',
      retryable: false,
    }).retryable,
  ).toBe(false);
});

test('facts with provider data raise an error carrying it', () => {
  expect(
    fromFacts({
      code: 'blocked',
      status: 400,
      message: 'no',
      provider: { openai: { param: 'input' } },
    }).provider,
  ).toEqual({ openai: { param: 'input' } });
});

test('facts with a retry hint raise an error carrying it', () => {
  expect(
    fromFacts({
      code: 'rate_limited',
      status: 429,
      message: 'slow down',
      retryAfterMs: 1500,
    }).retryAfterMs,
  ).toBe(1500);
});

test('facts with no status take the status of their class', () => {
  expect(
    ['rate_limited', 'upstream_refused', 'teapot'].map(
      (code) => fromFacts({ code, message: 'no' }).status,
    ),
  ).toEqual([429, 502, 500]);
});

test('facts that crossed a wire as JSON nulls are read as absent', () => {
  const error = fromFacts(
    JSON.parse(
      '{"code":"rate_limited","message":"no","status":null,"retryable":null,"retryAfterMs":null,"provider":null}',
    ),
  );
  expect([
    error instanceof RateLimited,
    error.status,
    error.retryable,
    'retryAfterMs' in error,
    'provider' in error,
  ]).toEqual([true, 429, true, false, false]);
});

test('facts of the wrong type are read as absent', () => {
  expect(
    toFacts(
      fromFacts(
        JSON.parse(
          '{"code":"rate_limited","message":"no","status":"429","retryable":"no","retryAfterMs":"1500","provider":7}',
        ),
      ),
    ),
  ).toStrictEqual({
    code: 'rate_limited',
    status: 429,
    message: 'no',
    retryable: true,
  });
});

test('provider data that is a list is read as absent', () => {
  expect(
    'provider' in
      fromFacts(JSON.parse('{"code":"blocked","message":"no","provider":[]}')),
  ).toBe(false);
});

test('facts with an unknown code raise a base error carrying them', () => {
  const error = fromFacts({ code: 'teapot', status: 418, message: 'no' });
  expect([
    error.name,
    error.code,
    error.status,
    error.message,
    error.retryable,
  ]).toEqual(['MottyError', 'teapot', 418, 'no', false]);
});

test('facts whose code names an object method raise a base error', () => {
  expect(
    fromFacts({ code: 'constructor', status: 400, message: 'no' }),
  ).toBeInstanceOf(MottyError);
});

test('an error survives the trip to facts and back', () => {
  const error = fromFacts(
    toFacts(
      new Overloaded('busy', {
        status: 529,
        retryAfterMs: 1500,
        provider: { anthropic: { type: 'overloaded_error' } },
      }),
    ),
  );
  expect([error instanceof Overloaded, toFacts(error)]).toEqual([
    true,
    {
      code: 'overloaded',
      status: 529,
      message: 'busy',
      retryable: true,
      retryAfterMs: 1500,
      provider: { anthropic: { type: 'overloaded_error' } },
    },
  ]);
});

test.each([
  [MottyError],
  [RateLimited],
  [QuotaExceeded],
  [Overloaded],
  [ContextTooLong],
  [Blocked],
  [Unsupported],
  [Forbidden],
  [InvalidRequest],
  [UpstreamFailed],
  [UpstreamRefused],
  [UnknownModel],
  [TimedOut],
  [Aborted],
  [Unauthenticated],
  [InvalidOutput],
  [LimitReached],
  [RouteLoop],
  [UnknownRoute],
])('%p gives the same facts after the trip to facts and back', (Known) => {
  for (const options of [
    {},
    { status: 418 },
    { retryable: true },
    { retryable: false },
    { retryAfterMs: 1500 },
    { provider: { openai: { param: 'input' } } },
  ]) {
    const error = new Known('failed', options);
    const back = fromFacts(toFacts(error));
    expect([back instanceof Known, toFacts(back)]).toStrictEqual([
      true,
      toFacts(error),
    ]);
  }
});

test.each([
  ['rate_limited', 429, true],
  ['quota_exceeded', 429, false],
  ['overloaded', 503, true],
  ['context_too_long', 400, false],
  ['blocked', 400, false],
  ['unsupported', 400, false],
  ['forbidden', 403, false],
  ['invalid_request', 400, false],
  ['upstream_failed', 502, true],
  ['upstream_refused', 502, false],
  ['unknown_model', 404, false],
  ['timed_out', 504, true],
  ['aborted', 499, false],
  ['unauthenticated', 401, false],
  ['invalid_output', 502, false],
  ['limit_reached', 500, false],
  ['route_loop', 500, false],
  ['unknown_route', 500, false],
  ['teapot', 500, false],
])(
  'facts with the code %s gain only a status and retryable on the trip to an error and back',
  (code, status, retryable) => {
    for (const given of [
      {},
      { status: 418 },
      { retryable: !retryable },
      { retryAfterMs: 1500 },
      { provider: { openai: { param: 'input' } } },
    ]) {
      expect(
        toFacts(fromFacts({ code, message: 'no', ...given })),
      ).toStrictEqual({ code, status, message: 'no', retryable, ...given });
    }
  },
);

test('facts with no code or message raise an internal error', () => {
  const raised = fromFacts(JSON.parse('{}'));

  expect(raised).toBeInstanceOf(MottyError);
  expect(toFacts(raised)).toEqual({
    code: 'internal',
    status: 500,
    message: 'Internal error',
    retryable: false,
  });
});

test('a second copy of the module holds its own classes', () => {
  expect([
    copy.MottyError === MottyError,
    copy.Overloaded === Overloaded,
    Object.getPrototypeOf(copy.Overloaded.prototype) === Overloaded.prototype,
  ]).toEqual([false, false, false]);
});

test('an error is an instance of another class defined with its code', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  expect(
    new EmptyPrompt('empty') instanceof MottyError.define('empty_prompt', 422),
  ).toBe(true);
});

test('an error from another copy is an instance of the class with its code', () => {
  expect(new copy.Overloaded('busy')).toBeInstanceOf(Overloaded);
  expect(new Overloaded('busy')).toBeInstanceOf(copy.Overloaded);
});

test('an error from another copy is an instance of the base', () => {
  expect([
    new copy.Overloaded('busy') instanceof MottyError,
    new copy.MottyError('failed') instanceof MottyError,
    copy.fromFacts({ code: 'teapot', message: 'no' }) instanceof MottyError,
  ]).toEqual([true, true, true]);
});

test('an error from another copy is not an instance of a class with another code', () => {
  expect([
    new copy.Overloaded('busy') instanceof RateLimited,
    new copy.MottyError('failed') instanceof Overloaded,
  ]).toEqual([false, false]);
});

test('an author class from another copy matches one written here by its code', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  class Theirs extends copy.MottyError.define('empty_prompt', 400) {}
  expect([
    new Theirs('empty') instanceof EmptyPrompt,
    new EmptyPrompt('empty') instanceof Theirs,
  ]).toEqual([true, true]);
});

test('the base error is not an instance of a defined class', () => {
  expect(new MottyError('failed') instanceof Overloaded).toBe(false);
});

test('a class extending the base is not matched by an error with another code', () => {
  class Bare extends MottyError {}
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  expect([
    new RateLimited('slow down') instanceof Bare,
    new EmptyPrompt('empty') instanceof Bare,
    new copy.RateLimited('slow down') instanceof Bare,
  ]).toEqual([false, false, false]);
});

test('a class extending the base matches its own errors', () => {
  class Bare extends MottyError {}
  expect([
    new Bare('failed') instanceof Bare,
    new Bare('failed') instanceof MottyError,
    new Bare('failed') instanceof RateLimited,
  ]).toEqual([true, true, false]);
});

test('a class extending the base of another copy matches by the base code', () => {
  class Bare extends MottyError {}
  class Theirs extends copy.MottyError {}
  expect([
    new Theirs('failed') instanceof Bare,
    new Bare('failed') instanceof Theirs,
    new RateLimited('slow down') instanceof Theirs,
  ]).toEqual([true, true, false]);
});

test('the base of either copy matches every error of both', () => {
  class Bare extends MottyError {}
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  expect(
    [
      new Bare('failed'),
      new EmptyPrompt('empty'),
      new RateLimited('slow down'),
      new copy.RateLimited('slow down'),
      new MottyError('failed'),
      new copy.MottyError('failed'),
    ].flatMap((error) => [
      error instanceof MottyError,
      error instanceof copy.MottyError,
    ]),
  ).toEqual(Array.from({ length: 12 }, () => true));
});

test('a status that is not finite is left out of the facts', () => {
  class Weird extends MottyError.define('weird', 400) {}
  expect(
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map(
      (status) => toFacts(new Weird('w', { status })),
    ),
  ).toStrictEqual([
    { code: 'weird', message: 'w', retryable: false },
    { code: 'weird', message: 'w', retryable: false },
    { code: 'weird', message: 'w', retryable: false },
  ]);
});

test('a retry hint that is not finite or is negative is left out of the facts', () => {
  class Weird extends MottyError.define('weird', 400) {}
  expect(
    [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1].map(
      (retryAfterMs) => toFacts(new Weird('w', { retryAfterMs })),
    ),
  ).toStrictEqual([
    { code: 'weird', status: 400, message: 'w', retryable: false },
    { code: 'weird', status: 400, message: 'w', retryable: false },
    { code: 'weird', status: 400, message: 'w', retryable: false },
    { code: 'weird', status: 400, message: 'w', retryable: false },
  ]);
});

test('facts left without a status take the status of their class back', () => {
  expect(
    fromFacts(toFacts(new RateLimited('slow down', { status: Number.NaN })))
      .status,
  ).toBe(429);
});

test('a branded value with a code that is not a string gives the internal code', () => {
  expect(
    toFacts({
      [Symbol.for('@mottyjs/core/error')]: true,
      code: 42,
      status: 418,
      message: 'no',
      retryable: true,
    }),
  ).toStrictEqual({
    code: 'internal',
    status: 418,
    message: 'no',
    retryable: true,
  });
});

test('a branded value with no message gives the general message', () => {
  expect(
    toFacts({
      [Symbol.for('@mottyjs/core/error')]: true,
      code: 'teapot',
      status: 418,
      retryable: true,
    }),
  ).toStrictEqual({
    code: 'teapot',
    status: 418,
    message: 'Internal error',
    retryable: true,
  });
});

test('a branded value with a retryable that is not a boolean gives none', () => {
  expect(
    toFacts({
      [Symbol.for('@mottyjs/core/error')]: true,
      code: 'teapot',
      status: 418,
      message: 'no',
      retryable: 'yes',
    }),
  ).toStrictEqual({ code: 'teapot', status: 418, message: 'no' });
});

test('a branded value with a status or retry hint of the wrong type gives neither', () => {
  expect(
    toFacts({
      [Symbol.for('@mottyjs/core/error')]: true,
      code: 'teapot',
      status: '418',
      message: 'no',
      retryable: false,
      retryAfterMs: '1500',
    }),
  ).toStrictEqual({ code: 'teapot', message: 'no', retryable: false });
});

test.each([
  [
    new RateLimited('slow down', {
      status: Number.NaN,
      retryAfterMs: Number.POSITIVE_INFINITY,
    }),
  ],
  [new RateLimited('slow down', { status: Number.NEGATIVE_INFINITY })],
  [{ [Symbol.for('@mottyjs/core/error')]: true, code: 42 }],
  [
    {
      [Symbol.for('@mottyjs/core/error')]: true,
      code: 'teapot',
      status: Number.NaN,
      retryable: 'yes',
      retryAfterMs: Number.POSITIVE_INFINITY,
    },
  ],
])('the facts of %p are the same after a trip through JSON', (thrown) => {
  const facts = toFacts(thrown);
  expect(JSON.parse(JSON.stringify(facts))).toStrictEqual(facts);
});

test.each([
  [new Error('busy')],
  [Object.assign(new Error('busy'), { code: 'overloaded' })],
  [{ code: 'overloaded' }],
  [{ code: 'overloaded', status: 503, message: 'busy', retryable: true }],
  [null],
  [undefined],
  ['overloaded'],
  [503],
  [Overloaded],
])('%p is not an instance of an error class or the base', (value) => {
  expect([value instanceof Overloaded, value instanceof MottyError]).toEqual([
    false,
    false,
  ]);
});

test('an error caught as unknown narrows to the class it is an instance of', () => {
  const caught: unknown = new RateLimited('slow down', { retryAfterMs: 1500 });
  expect(caught instanceof RateLimited ? caught.retryAfterMs : 0).toBe(1500);
});

test('an error from another copy gives its facts here', () => {
  expect(toFacts(new copy.Overloaded('busy'))).toEqual({
    code: 'overloaded',
    status: 503,
    message: 'busy',
    retryable: true,
  });
});

test('an error raised by the motty is not marked as from outside', () => {
  const raised = new RateLimited('Slow down, acme');

  expect([
    Object.hasOwn(raised, 'upstream'),
    'upstream' in toFacts(raised),
  ]).toEqual([false, false]);
});

test('facts marked as from outside raise an error that carries the mark and gives it back', () => {
  const raised = fromFacts({
    code: 'rate_limited',
    status: 429,
    message: 'Rate limit for org-SECRET',
    upstream: true,
  });

  expect(raised.upstream).toBe(true);
  expect(toFacts(raised)).toStrictEqual({
    code: 'rate_limited',
    status: 429,
    message: 'Rate limit for org-SECRET',
    retryable: true,
    upstream: true,
  });
});

test('an error from outside keeps its mark when it is caught and thrown again', () => {
  const raised = fromFacts({ code: 'blocked', message: 'no', upstream: true });
  let again: unknown;
  try {
    try {
      throw raised;
    } catch (thrown) {
      throw stopReason(thrown);
    }
  } catch (thrown) {
    again = thrown;
  }

  expect(toFacts(again).upstream).toBe(true);
});

test.each([[false], [null], ['true'], [1]])(
  'a mark of %p in facts is read as absent',
  (upstream) => {
    const raised = fromFacts(
      JSON.parse(JSON.stringify({ code: 'blocked', message: 'no', upstream })),
    );

    expect(Object.hasOwn(raised, 'upstream')).toBe(false);
  },
);

test('an error from another copy keeps its mark in the facts given here', () => {
  expect(
    toFacts(copy.fromFacts({ code: 'blocked', message: 'no', upstream: true }))
      .upstream,
  ).toBe(true);
});

test.each([
  ['rate_limited', 429],
  ['context_too_long', 400],
  ['upstream_refused', 502],
  ['upstream_failed', 500],
  ['teapot', 418],
])(
  'a caller is told the own message of a %s that came from outside with status %d',
  (code, status) => {
    expect(
      disclosed({
        code,
        status,
        message: 'Expected temperature to be at most 2, received 9',
        retryable: false,
        retryAfterMs: 1500,
        provider: { openai: { param: 'temperature' } },
        upstream: true,
      }),
    ).toStrictEqual({
      code,
      status,
      message: 'Expected temperature to be at most 2, received 9',
      retryable: false,
      retryAfterMs: 1500,
      provider: { openai: { param: 'temperature' } },
    });
  },
);

test('a caller is told the own message of an error the motty raised, whatever its class and status', () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}

  expect(
    [
      new EmptyPrompt('Send at least one message'),
      new Unauthenticated('The key acme_1 is not known'),
      new InvalidOutput('The summary is missing', { status: 422 }),
      new LimitReached('The request made more than 3 model calls'),
    ].map((raised) => disclosed(toFacts(raised)).message),
  ).toEqual([
    'Send at least one message',
    'The key acme_1 is not known',
    'The summary is missing',
    'The request made more than 3 model calls',
  ]);
});

test('a caller is not told where an error came from', () => {
  expect(
    'upstream' in
      disclosed({
        code: 'blocked',
        status: 400,
        message: 'no',
        upstream: true,
      }),
  ).toBe(false);
});

test('the facts for the host keep the own message and provider data of an error from outside', () => {
  const facts: ErrorFacts = {
    code: 'rate_limited',
    status: 429,
    message: 'Rate limit for org-SECRET',
    retryable: true,
    provider: { openai: { organization: 'org-SECRET' } },
    upstream: true,
  };

  expect(toFacts(fromFacts(facts))).toStrictEqual(facts);
});

test('an error an author marks as from an upstream of their own is told in its own words', () => {
  expect(
    disclosed(
      toFacts(new Forbidden('The index refused this key', { upstream: true })),
    ).message,
  ).toBe('The index refused this key');
});

test('facts a host called its own raise an error with no mark, and neither its facts nor what a caller is told has one', () => {
  const raised = fromFacts({
    code: 'unsupported',
    message: 'No audio here',
    upstream: false,
  });

  expect([
    Object.hasOwn(raised, 'upstream'),
    'upstream' in toFacts(raised),
    'upstream' in
      disclosed({
        code: 'unsupported',
        message: 'No audio here',
        upstream: false,
      }),
  ]).toEqual([false, false, false]);
});

test('an error cannot be raised with the mark off, and one cast past the types holds none', () => {
  // @ts-expect-error only the facts of a sent error say a failure is the host's own
  const raised = new Unsupported('No audio here', { upstream: false });

  expect([
    Object.hasOwn(raised, 'upstream'),
    'upstream' in toFacts(raised),
  ]).toEqual([false, false]);
});
