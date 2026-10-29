import { expect, test } from 'bun:test';
import {
  Aborted,
  answer,
  fallback,
  MottyError,
  model,
  motty,
  Overloaded,
  think,
  UnknownModel,
} from '@mottyjs/core';
import { hosted } from '@mottyjs/core/host';
import { fake, memory, on, run, Unscripted } from '../src/index.ts';

const small = model('acme/small');
const large = model('acme/large');

const counting = motty({ name: 'counting' }).handle(async () => {
  const { storage } = hosted();
  const visits = Number((await storage?.get('visits')) ?? 0) + 1;
  await storage?.set('visits', visits);
  return answer(`visit ${visits}`);
});

const greeting = motty({ name: 'greeting' }).handle(() =>
  answer(`hello ${hosted().caller?.id ?? 'stranger'}`),
);

test('a run resolves with the route, the path and the answer', async () => {
  const sizes = motty({ name: 'sizes' }).route(() => 'little', {
    little: () => answer('little reply'),
    big: () => answer('big reply'),
  });
  const routed = motty({ name: 'routed' }).route(
    ({ request }) => (request.model.endsWith(':max') ? 'deep' : 'chat'),
    { chat: sizes, deep: () => answer('deep reply') },
  );

  const chat = await run(routed, { text: 'hi' });
  const deep = await run(routed, { text: 'hi', model: 'acme/routed:max' });

  expect(chat.route).toBe('chat');
  expect(chat.path).toEqual(['chat', 'little']);
  expect(await chat.answer.text()).toBe('little reply');
  expect(deep.route).toBe('deep');
  expect(deep.path).toEqual(['deep']);
  // @ts-expect-error the motty has no route of this name
  expect(deep.route === 'shallow').toBe(false);
});

test('the request is plain data and the rest is defaulted', async () => {
  const echo = motty({ name: 'echo' }).handle(({ request }) =>
    answer(
      JSON.stringify({
        model: request.model,
        messages: request.messages,
        tools: request.tools,
        options: request.options,
        output: request.output,
        trace: request.headers.get('x-trace'),
      }),
    ),
  );

  const text = await run(echo, { text: 'hi' });
  const whole = await run(echo, {
    model: 'acme/echo:max',
    messages: [
      { role: 'system', text: 'Be brief' },
      { role: 'user', text: 'hi' },
    ],
    tools: [{ type: 'function', name: 'search', input: { type: 'object' } }],
    options: { maxTokens: 64 },
    headers: { 'x-trace': 't1' },
    output: { schema: { type: 'object' } },
  });

  expect(await text.answer.json()).toEqual({
    model: 'echo',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [],
    options: {},
    trace: null,
  });
  expect(await whole.answer.json()).toEqual({
    model: 'acme/echo:max',
    messages: [
      { role: 'system', text: 'Be brief' },
      { role: 'user', text: 'hi' },
    ],
    tools: [{ type: 'function', name: 'search', input: { type: 'object' } }],
    options: { maxTokens: 64 },
    output: { schema: { type: 'object' } },
    trace: 't1',
  });
});

test('thoughts are the progress really sent, one per piece', async () => {
  const thinking = motty({ name: 'thinking' }).handle(async ({ prompt }) => {
    think('Reading the request');
    think(await small.complete(prompt));
    return large.complete(prompt);
  });

  const { thoughts } = await run(
    thinking,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, [
            { type: 'text', text: '1. Find ' },
            { type: 'text', text: 'the lock order' },
          ]),
          on(large, 'reply'),
        ),
      ],
    },
  );

  expect(thoughts).toEqual(['Reading the request', '1. Find the lock order']);
});

test('after-response work has finished when the run resolves', async () => {
  const outcomes: string[] = [];
  const noting = motty({ name: 'noting' })
    .handle(() => answer('reply'))
    .afterResponse(async ({ outcome }) => {
      await Bun.sleep(5);
      outcomes.push(outcome);
    });

  await run(noting, { text: 'hi' });

  expect(outcomes).toEqual(['completed']);
});

test('each run has storage of its own by default', async () => {
  await run(counting, { text: 'hi' });

  const { answer: reply } = await run(counting, { text: 'hi' });

  expect(await reply.text()).toBe('visit 1');
});

test('a memory passed to two runs is shared by them', async () => {
  const storage = memory();
  await run(counting, { text: 'hi' }, { storage });

  const { answer: reply } = await run(counting, { text: 'hi' }, { storage });

  expect(await reply.text()).toBe('visit 2');
});

test('everyone is admitted as tester by default', async () => {
  const { answer: reply } = await run(greeting, { text: 'hi' });

  expect(await reply.text()).toBe('hello tester');
});

test('an auth adapter is given the bearer token, and the credential stops at the host', async () => {
  const seeing = motty({ name: 'seeing' }).handle(({ request }) =>
    answer(
      `${hosted().caller?.id} ${request.headers.has('authorization')} ${request.headers.get('x-trace')}`,
    ),
  );

  const { answer: reply } = await run(
    seeing,
    { text: 'hi', headers: { authorization: 'Bearer ada', 'x-trace': 't1' } },
    {
      auth: { verify: (token) => ({ id: token }) },
    },
  );

  expect(await reply.text()).toBe('ada false t1');
});

test('the credential stops at the host with no auth adapter too', async () => {
  const { answer: reply } = await run(
    motty({ name: 'seeing' }).handle(({ request }) =>
      answer(`${hosted().caller?.id} ${request.headers.has('authorization')}`),
    ),
    { text: 'hi', headers: { authorization: 'Bearer ada' } },
  );

  expect(await reply.text()).toBe('tester false');
});

test('an auth adapter that proves nobody leaves the host without a caller', async () => {
  const { answer: reply } = await run(
    greeting,
    { text: 'hi', headers: { authorization: 'Bearer eve' } },
    { auth: { verify: () => undefined } },
  );

  expect(await reply.text()).toBe('hello stranger');
});

test('with no models any call fails the run', async () => {
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const asked = run(asking, { text: 'hi' });

  await expect(asked).rejects.toBeInstanceOf(Unscripted);
  await expect(asked).rejects.toThrow(
    'No chat reply was scripted for acme/small',
  );
});

test('a call nobody scripted fails the run though a fallback recovered', async () => {
  const recovering = motty({ name: 'recovering' }).handle(({ prompt }) =>
    fallback(small, large).complete(prompt),
  );

  const asked = run(
    recovering,
    { text: 'hi' },
    { models: [fake(on(large, 'fallback reply'))] },
  );

  await expect(asked).rejects.toBeInstanceOf(Unscripted);
  await expect(asked).rejects.toThrow(
    'No reply was scripted for a call to acme/small',
  );
});

test('with models given as a function, a call none of its adapters serves fails the run as unscripted though a fallback recovered', async () => {
  const recovering = motty({ name: 'recovering' }).handle(({ prompt }) =>
    fallback(small, large).complete(prompt),
  );
  const asked: string[] = [];

  const ran = run(
    recovering,
    { text: 'hi', model: 'acme/coder' },
    {
      models: async (request) => {
        asked.push(request.model);
        return [fake(on(large, 'fallback reply'))];
      },
    },
  );

  await expect(ran).rejects.toBeInstanceOf(Unscripted);
  await expect(ran).rejects.toThrow(
    'No reply was scripted for a call to acme/small',
  );
  expect(asked).toEqual(['acme/coder']);
});

test('a call scripted to fail as an unknown model is a failure like any other, and a fallback moves on', async () => {
  const recovering = motty({ name: 'recovering' }).handle(({ prompt }) =>
    fallback(small, large).complete(prompt),
  );

  const { answer: reply, calls } = await run(
    recovering,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, new UnknownModel('The model was retired')),
          on(large, 'fallback reply'),
        ),
      ],
    },
  );

  expect(await reply.text()).toBe('fallback reply');
  expect(calls).toMatchObject([
    {
      model: 'acme/small',
      code: 'unknown_model',
      message: 'The model was retired',
    },
    { model: 'acme/large' },
  ]);
  expect(calls[1]).not.toHaveProperty('message');
});

test('a real adapter that reports an unknown model does not fail a run the motty recovered', async () => {
  const recovering = motty({ name: 'recovering' }).handle(({ prompt }) =>
    fallback(small, large).complete(prompt),
  );

  const { answer: reply } = await run(
    recovering,
    { text: 'hi' },
    {
      models: [
        {
          serves: (name) => name === 'acme/small',
          call: async function* () {
            yield {
              type: 'error',
              error: {
                code: 'unknown_model',
                status: 404,
                message: 'The model does not exist',
                upstream: true,
              },
            };
          },
        },
        fake(on(large, 'fallback reply')),
      ],
    },
  );

  expect(await reply.text()).toBe('fallback reply');
});

test('an unknown model nothing recovered from rejects the run as that', async () => {
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const asked = run(
    asking,
    { text: 'hi' },
    { models: [fake(on(small, new UnknownModel('The model was retired')))] },
  );

  await expect(asked).rejects.toBeInstanceOf(UnknownModel);
  await expect(asked).rejects.not.toBeInstanceOf(Unscripted);
});

test('a failed run rejects with the SDK error a model call raised', async () => {
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const asked = run(
    asking,
    { text: 'hi' },
    { models: [fake(on(small, new Overloaded('busy')))] },
  );

  await expect(asked).rejects.toBeInstanceOf(Overloaded);
  await expect(asked).rejects.toMatchObject({
    code: 'overloaded',
    status: 503,
    retryable: true,
  });
});

test('a caller who leaves midway rejects the run as aborted', async () => {
  const leaving = new AbortController();
  const asking = motty({ name: 'asking' }).handle(({ prompt }) => {
    leaving.abort();
    return small.complete(prompt);
  });

  const asked = run(
    asking,
    { text: 'hi', signal: leaving.signal },
    { models: [fake(on(small, 'reply'))] },
  );

  await expect(asked).rejects.toBeInstanceOf(Aborted);
});

test('setting overrides are typed by the settings of the motty that runs', async () => {
  const tuned = motty({ name: 'tuned' })
    .derive(() => ({ settings: { tiers: { deepProbability: 0.5 } } }))
    .handle(() => answer('tuned'));

  await run(tuned, { text: 'hi' }, { settings: { tiers: {} } });
  await run(
    tuned,
    { text: 'hi' },
    { settings: { tiers: { deepProbability: 0.4 } } },
  );
  // @ts-expect-error the motty declares no group of that name
  await run(tuned, { text: 'hi' }, { settings: { tires: {} } });
  await run(
    tuned,
    { text: 'hi' },
    // @ts-expect-error the value is a number
    { settings: { tiers: { deepProbability: 'often' } } },
  );
});

test('an early answer, one a boundary gave and one an entry was caught with name the model that gave them', async () => {
  const cached = motty({ name: 'cached' })
    .beforeHandle(({ prompt }) => small.complete(prompt))
    .handle(({ prompt }) => large.complete(prompt));
  const recovered = motty({ name: 'recovered' })
    .handle(() => {
      throw new MottyError('The handler broke');
    })
    .onError((_thrown, { prompt }) => large.complete(prompt));

  const failing = motty({ name: 'failing' }).handle(() => {
    throw new MottyError('The entry broke');
  });
  const guarded = motty({ name: 'guarded' }).route(() => 'deep', {
    deep: failing.catch((_thrown, { prompt }) => small.complete(prompt)),
  });

  const early = await run(
    cached,
    { text: 'hi' },
    { models: [fake(on(small, 'early reply'), on(large, 'unused'))] },
  );
  const caught = await run(
    recovered,
    { text: 'hi' },
    { models: [fake(on(large, 'sorry'))] },
  );

  const entry = await run(
    guarded,
    { text: 'hi' },
    { models: [fake(on(small, 'entry recovered'))] },
  );

  expect(early.calls.map((call) => call.model)).toEqual(['acme/small']);
  expect(await early.answer.model()).toBe('acme/small');
  expect(await caught.answer.model()).toBe('acme/large');
  expect(await entry.answer.model()).toBe('acme/small');
});
