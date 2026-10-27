import { expect, test } from 'bun:test';
import {
  Aborted,
  disclosed,
  type ErrorFacts,
  fromFacts,
  InvalidRequest,
  MottyError,
  Overloaded,
  RateLimited,
  stopReason,
  TimedOut,
  toFacts,
  UpstreamFailed,
} from '../../src/data/errors.ts';

// A query on the path loads the module again, as a bundle and its host each do.
const copy: typeof import('../../src/data/errors.ts') = await import(
  ['../../src/data/errors.ts', 'copy'].join('?')
);

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
  ['an object', { reason: 'busy' }, '{"reason":"busy"}'],
  ['a bigint, which JSON cannot hold', 5n, 'bigint'],
])('%s thrown is described in a server failure', (_, thrown, described) => {
  expect(toFacts(thrown)).toStrictEqual({
    code: 'internal',
    status: 500,
    message: `A value that is not an error was thrown: ${described}`,
    retryable: false,
    unexpected: true,
  });
});

test('a caller is told the own message of an error that is their mistake', () => {
  expect(
    disclosed(
      toFacts(
        new RateLimited('Slow down, acme', {
          retryAfter: 1500,
          provider: { openai: { type: 'requests' } },
        }),
      ),
    ),
  ).toStrictEqual({
    code: 'rate_limited',
    status: 429,
    message: 'Slow down, acme',
    retryable: true,
    retryAfter: 1500,
    provider: { openai: { type: 'requests' } },
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

test('facts with a known code raise that class', () => {
  expect(
    fromFacts({ code: 'overloaded', status: 503, message: 'busy' }),
  ).toBeInstanceOf(Overloaded);
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
      '{"code":"rate_limited","message":"no","status":null,"retryable":null,"retryAfter":null,"provider":null}',
    ),
  );
  expect([
    error instanceof RateLimited,
    error.status,
    error.retryable,
    'retryAfter' in error,
    'provider' in error,
  ]).toEqual([true, 429, true, false, false]);
});

test('facts of the wrong type are read as absent', () => {
  expect(
    toFacts(
      fromFacts(
        JSON.parse(
          '{"code":"rate_limited","message":"no","status":"429","retryable":"no","retryAfter":"1500","provider":7}',
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
        retryAfter: 1500,
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
      retryAfter: 1500,
      provider: { anthropic: { type: 'overloaded_error' } },
    },
  ]);
});

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
      (retryAfter) => toFacts(new Weird('w', { retryAfter })),
    ),
  ).toStrictEqual([
    { code: 'weird', status: 400, message: 'w', retryable: false },
    { code: 'weird', status: 400, message: 'w', retryable: false },
    { code: 'weird', status: 400, message: 'w', retryable: false },
    { code: 'weird', status: 400, message: 'w', retryable: false },
  ]);
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
      retryAfter: '1500',
    }),
  ).toStrictEqual({ code: 'teapot', message: 'no', retryable: false });
});

test.each([
  [Object.assign(new Error('busy'), { code: 'overloaded' })],
  [{ code: 'overloaded', status: 503, message: 'busy', retryable: true }],
  ['overloaded'],
])('%p is not an instance of an error class or the base', (value) => {
  expect([value instanceof Overloaded, value instanceof MottyError]).toEqual([
    false,
    false,
  ]);
});

test('a mark in facts that is not true is read as absent', () => {
  const raised = fromFacts(
    JSON.parse('{"code":"blocked","message":"no","upstream":"true"}'),
  );

  expect(Object.hasOwn(raised, 'upstream')).toBe(false);
});

test('a caller is told the own message of a server failure that came from outside', () => {
  expect(
    disclosed({
      code: 'upstream_failed',
      status: 500,
      message: 'Expected temperature to be at most 2, received 9',
      retryable: false,
      retryAfter: 1500,
      provider: { openai: { param: 'temperature' } },
      upstream: true,
    }),
  ).toStrictEqual({
    code: 'upstream_failed',
    status: 500,
    message: 'Expected temperature to be at most 2, received 9',
    retryable: false,
    retryAfter: 1500,
    provider: { openai: { param: 'temperature' } },
  });
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
