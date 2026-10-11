import { expect, test } from 'bun:test';
import { isMarked, type Marked, mark, version } from '../src/contract.ts';
import { fromFacts, RateLimited, toFacts } from '../src/data/errors.ts';
import type { ChatRequest, StandardSchema } from '../src/data/message.ts';
import { stubHost } from './stub-host.ts';

function request(model: string): ChatRequest {
  return {
    id: 'req_1',
    model,
    messages: [{ role: 'user', text: 'Hello' }],
    tools: [],
    options: {},
    headers: new Headers(),
  };
}

function relay(): Marked {
  return {
    [mark]: {
      version,
      description: { sdk: '0.0.0', name: 'relay', plugins: ['tenant'] },
      run: (request, host) =>
        host.models(
          request.model,
          { messages: [...request.messages] },
          host.signal,
        ),
    },
  };
}

test('a value carrying the mark is recognised', () => {
  expect(isMarked(relay())).toBe(true);
});

test('a function carrying the mark is recognised', () => {
  expect(isMarked(Object.assign(() => {}, relay()))).toBe(true);
});

test('a value with the same shape but no mark is not recognised', () => {
  expect(
    isMarked({
      version,
      description: { sdk: '0.0.0', name: 'relay', plugins: [] },
      run: () =>
        stubHost().models('acme/small', { messages: [] }, AbortSignal.abort()),
    }),
  ).toBe(false);
});

test('a value under a look-alike symbol is not recognised', () => {
  expect(isMarked({ [Symbol('@mottyjs/core')]: relay()[mark] })).toBe(false);
});

test.each([undefined, null, 0, 'motty', true])(
  '%p is not recognised',
  (value) => {
    expect(isMarked(value)).toBe(false);
  },
);

test('the mark is the same symbol from a second lookup of the registry', () => {
  expect(Symbol.for(Symbol.keyFor(mark) ?? '')).toBe(mark);
});

test('the contract version is a whole number starting at one', () => {
  expect(version).toBe(1);
});

test('the version behind the mark compares with the version of the host', () => {
  const loaded: unknown = relay();
  expect(isMarked(loaded) && loaded[mark].version === version).toBe(true);
});

test('a bundle built with another version is told apart', () => {
  const loaded: unknown = {
    [mark]: { ...relay()[mark], version: version + 1 },
  };
  expect(isMarked(loaded) && loaded[mark].version === version).toBe(false);
});

test('a request goes in and a stream with one terminal event comes out', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hi' },
      { type: 'text', text: ' there' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 3, output: 2, cached: 0, reasoning: 0 },
      },
    ],
  });
  const events = await Array.fromAsync(
    relay()[mark].run(request('acme/small'), host),
  );
  expect(events.map((event) => event.type)).toEqual(['text', 'text', 'finish']);
});

test('the host sees the prompt each model was sent', async () => {
  const host = stubHost();
  await Array.fromAsync(relay()[mark].run(request('acme/small'), host));
  expect(host.sent('acme/small')).toEqual([
    { messages: [{ role: 'user', text: 'Hello' }] },
  ]);
});

test('the stop signal reaches the model call', async () => {
  const stop = new AbortController();
  const host = stubHost(
    {
      'acme/small': [
        { type: 'text', text: 'Hi' },
        { type: 'text', text: ' there' },
        {
          type: 'finish',
          reason: 'stop',
          usage: { input: 3, output: 2, cached: 0, reasoning: 0 },
        },
      ],
    },
    { signal: stop.signal },
  );
  const events = [];
  for await (const event of relay()[mark].run(request('acme/small'), host)) {
    events.push(event);
    stop.abort();
  }
  expect(events).toEqual([
    { type: 'text', text: 'Hi' },
    {
      type: 'error',
      error: { code: 'aborted', status: 499, message: 'The call was stopped' },
    },
  ]);
});

test('a failed call crosses as facts', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfterMs: 1500,
        },
      },
    ],
  });
  expect(
    await Array.fromAsync(relay()[mark].run(request('acme/small'), host)),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'rate_limited',
        status: 429,
        message: 'Slow down',
        retryAfterMs: 1500,
      },
    },
  ]);
});

test('the facts of a failed call are raised as the class of the motty', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'error',
        error: { code: 'rate_limited', status: 429, message: 'Slow down' },
      },
    ],
  });
  const raised = [];
  for await (const event of host.models(
    'acme/small',
    { messages: [] },
    host.signal,
  )) {
    if (event.type === 'error') raised.push(fromFacts(event.error));
  }
  expect(raised.map((error) => error instanceof RateLimited)).toEqual([true]);
});

test('a model name the host cannot serve gives unknown_model', async () => {
  const host = stubHost({ 'acme/small': [] });
  expect(
    await Array.fromAsync(relay()[mark].run(request('acme/large'), host)),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'unknown_model',
        status: 404,
        message: 'No model named acme/large',
      },
    },
  ]);
});

test('an error thrown in the motty crosses back as facts', async () => {
  const failing: Marked = {
    [mark]: {
      version,
      description: { sdk: '0.0.0', name: 'relay', plugins: [] },
      run: async function* () {
        try {
          throw new RateLimited('Slow down', { retryAfterMs: 1500 });
        } catch (thrown) {
          yield { type: 'error', error: toFacts(thrown) };
        }
      },
    },
  };
  expect(
    await Array.fromAsync(failing[mark].run(request('acme/small'), stubHost())),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'rate_limited',
        status: 429,
        message: 'Slow down',
        retryable: true,
        retryAfterMs: 1500,
      },
    },
  ]);
});

test('the prompt that crosses carries a JSON Schema and no Standard Schema', () => {
  const host = stubHost();
  const schema: StandardSchema = {
    '~standard': {
      version: 1,
      vendor: 'acme',
      validate: (value) => ({ value }),
    },
  };
  host.models(
    'a',
    { messages: [], output: { schema: { type: 'object' } } },
    host.signal,
  );
  // @ts-expect-error a bare JSON Schema is not an output by itself
  host.models('c', { messages: [], output: { type: 'object' } }, host.signal);
  // @ts-expect-error a Standard Schema holds a function and never crosses
  host.models('b', { messages: [], output: schema }, host.signal);
  expect(host.sent('a')).toEqual([
    { messages: [], output: { schema: { type: 'object' } } },
  ]);
});

test('the description is plain data', () => {
  const { description } = relay()[mark];
  expect(JSON.parse(JSON.stringify(description))).toEqual(description);
});

test('the host carries a caller, settings and limits as plain data', () => {
  const { caller, settings, limits } = stubHost(
    {},
    {
      caller: { id: 'user_1' },
      settings: { tiers: { deep: 'acme/large' } },
      limits: { calls: 10, afterResponse: 30_000 },
    },
  );
  expect(JSON.parse(JSON.stringify({ caller, settings, limits }))).toEqual({
    caller: { id: 'user_1' },
    settings: { tiers: { deep: 'acme/large' } },
    limits: { calls: 10, afterResponse: 30_000 },
  });
});

test('a storage crosses with increment or without it', () => {
  const plain = stubHost(
    {},
    {
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      },
    },
  );
  const counting = stubHost(
    {},
    {
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        increment: async (_key, by) => by,
      },
    },
  );

  expect(plain.storage?.increment).toBeUndefined();
  expect(counting.storage?.increment).toBeInstanceOf(Function);
});
