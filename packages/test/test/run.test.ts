import { expect, test } from 'bun:test';
import {
  Aborted,
  answer,
  fallback,
  LimitReached,
  MottyError,
  model,
  motty,
  Overloaded,
  race,
  reroute,
  retry,
  TimedOut,
  think,
  timeout,
  UnknownModel,
} from '@mottyjs/core';
import { hosted, type Report } from '@mottyjs/core/host';
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

test('the path is the entry a reroute ended at', async () => {
  const rerouted = motty({ name: 'rerouted' }).route(() => 'quick', {
    quick: () => reroute('standard'),
    standard: () => answer('standard reply'),
  });

  const { route, path } = await run(rerouted, { text: 'hi' });

  expect(route).toBe('standard');
  expect(path).toEqual(['standard']);
});

test('an answer given before the route has no route and no path', async () => {
  const gated = motty({ name: 'gated' })
    .beforeHandle(() => answer('canned reply'))
    .route(() => 'only', { only: () => answer('routed reply') });

  const { route, path, answer: reply } = await run(gated, { text: 'hi' });

  expect(route).toBeUndefined();
  expect(path).toEqual([]);
  expect(await reply.text()).toBe('canned reply');
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

test('the answer is the one the caller got: its chunks, its finish reason and the usage of the whole request', async () => {
  const calling = motty({ name: 'calling' }).handle(async ({ prompt }) => {
    await (await large.complete(prompt)).text();
    return small.complete(prompt);
  });

  const { answer: reply } = await run(
    calling,
    { text: 'hi' },
    {
      models: [
        fake(
          on(large, [
            { type: 'text', text: 'a plan' },
            { type: 'finish', reason: 'stop', usage: { input: 5, output: 2 } },
          ]),
          on(small, [
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'search',
              arguments: '{}',
            },
            {
              type: 'finish',
              reason: 'tool_calls',
              usage: { input: 7, output: 3 },
            },
          ]),
        ),
      ],
    },
  );

  expect(await reply.finish()).toBe('tool_calls');
  expect(await reply.usage()).toEqual({ input: 12, output: 5 });
  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
  ]);
});

test('the calls made are in the result', async () => {
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const { calls } = await run(
    asking,
    { text: 'hi' },
    { models: [fake(on(small, 'reply'))] },
  );

  expect(calls.map((call) => call.model)).toEqual(['acme/small']);
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

test("a memory shared by two motties holds each one's keys under its own name, as a host does", async () => {
  const storage = memory();
  const visited = (name: string) =>
    motty({ name }).handle(async () => {
      const { storage: held } = hosted();
      const visits = Number((await held?.get('visits')) ?? 0) + 1;
      await held?.set('visits', visits);
      return answer(`visit ${visits}`);
    });
  await run(visited('coder'), { text: 'hi' }, { storage });
  await run(visited('coder'), { text: 'hi' }, { storage });

  const { answer: reply } = await run(
    visited('tutor'),
    { text: 'hi' },
    { storage },
  );

  expect(await reply.text()).toBe('visit 1');
  expect(await storage.get('coder:visits')).toBe(2);
  expect(await storage.get('tutor:visits')).toBe(1);
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

test('with an auth adapter and no token there is no caller, and the adapter is not asked', async () => {
  const asked: string[] = [];

  const { answer: reply } = await run(
    greeting,
    { text: 'hi', headers: { authorization: 'Basic ada' } },
    {
      auth: {
        verify: (token) => {
          asked.push(token);
          return { id: 'ada' };
        },
      },
    },
  );

  expect(await reply.text()).toBe('hello stranger');
  expect(asked).toEqual([]);
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

test("a failed run rejects with the author's own class", async () => {
  class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}
  const refusing = motty({ name: 'refusing' }).handle(() => {
    throw new EmptyPrompt('The prompt is empty');
  });

  const asked = run(refusing, { messages: [] });

  await expect(asked).rejects.toBeInstanceOf(EmptyPrompt);
  await expect(asked).rejects.not.toBeInstanceOf(Overloaded);
  await expect(asked).rejects.toMatchObject({
    code: 'empty_prompt',
    status: 400,
    message: 'The prompt is empty',
  });
});

test('a thrown value that is no SDK error rejects as an internal one', async () => {
  const broken = motty({ name: 'broken' }).handle(() => {
    throw new TypeError('not a function');
  });

  const asked = run(broken, { text: 'hi' });

  await expect(asked).rejects.toBeInstanceOf(MottyError);
  await expect(asked).rejects.toMatchObject({
    code: 'internal',
    message: 'not a function',
  });
});

test('an error a boundary recovered from resolves the run', async () => {
  const recovering = motty({ name: 'recovering' })
    .handle(({ prompt }) => small.complete(prompt))
    .onError(() => answer('sorry'));

  const { answer: reply } = await run(
    recovering,
    { text: 'hi' },
    { models: [fake(on(small, new Overloaded('busy')))] },
  );

  expect(await reply.text()).toBe('sorry');
});

test('a caller who already left rejects the run as aborted', async () => {
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const asked = run(asking, { text: 'hi', signal: AbortSignal.abort() });

  await expect(asked).rejects.toBeInstanceOf(Aborted);
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

test('the duration limit stops the request as the host would', async () => {
  const waiting = motty({ name: 'waiting' }).handle(async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    return answer('late reply');
  });

  const asked = run(waiting, { text: 'hi' }, { limits: { duration: 5 } });

  await expect(asked).rejects.toBeInstanceOf(TimedOut);
});

test('the call limit reaches the motty', async () => {
  const twice = motty({ name: 'twice' }).handle(async ({ prompt }) => {
    await small.complete(prompt);
    return small.complete(prompt);
  });

  const asked = run(
    twice,
    { text: 'hi' },
    { models: [fake(on(small, 'reply'))], limits: { calls: 1 } },
  );

  await expect(asked).rejects.toBeInstanceOf(LimitReached);
});

test('setting overrides reach the motty', async () => {
  const tuned = motty({ name: 'tuned' }).handle(() =>
    answer(JSON.stringify(hosted().settings)),
  );

  const { answer: reply } = await run(
    tuned,
    { text: 'hi' },
    { settings: { tiers: { deepProbability: 0.4 } } },
  );

  expect(await reply.json()).toEqual({ tiers: { deepProbability: 0.4 } });
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

test('the report is the record with an id and the overrides in effect', async () => {
  const reports: Report[] = [];
  const asking = motty({ name: 'asking' }).route(() => 'only', {
    only: ({ prompt }) => small.complete(prompt),
  });

  await run(
    asking,
    { text: 'hi' },
    {
      models: [fake(on(small, 'reply'))],
      settings: { tiers: { deepProbability: 0.4 } },
      report: (report) => void reports.push(report),
    },
  );

  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    id: expect.any(String),
    settings: { tiers: { deepProbability: 0.4 } },
    outcome: 'completed',
    path: ['only'],
    calls: [{ model: 'acme/small' }],
  });
});

test('a failed run is reported before it rejects', async () => {
  const outcomes: Report['outcome'][] = [];
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const asked = run(
    asking,
    { text: 'hi', signal: AbortSignal.abort() },
    { report: (report) => void outcomes.push(report.outcome) },
  );

  await expect(asked).rejects.toBeInstanceOf(Aborted);
  expect(outcomes).toEqual(['aborted']);
});

test('a middleware runs alone with a handler added in the test', async () => {
  const shouting = motty({ name: 'shouting' }).derive(({ request }) => ({
    loud: request.messages.at(-1)?.text?.toUpperCase() ?? '',
  }));

  const { answer: reply } = await run(
    motty({ name: 'under-test' })
      .use(shouting)
      .handle(({ loud }) => answer(loud)),
    { text: 'hi' },
  );

  expect(await reply.text()).toBe('HI');
});

test('the answer names the model that was called, not the id its upstream gave', async () => {
  const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
    small.complete(prompt),
  );

  const { answer: reply } = await run(
    asking,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, [
            { type: 'text', text: 'reply' },
            { type: 'finish', reason: 'stop', model: 'acme/small-2026' },
          ]),
        ),
      ],
    },
  );

  expect(await reply.model()).toBe('acme/small');
  expect(await reply.text()).toBe('reply');
});

test('the answer names the model a fallback moved to', async () => {
  const recovering = motty({ name: 'recovering' }).handle(({ prompt }) =>
    fallback(small, large).complete(prompt),
  );

  const { answer: reply } = await run(
    recovering,
    { text: 'hi' },
    {
      models: [
        fake(on(small, new Overloaded('busy')), on(large, 'fallback reply')),
      ],
    },
  );

  expect(await reply.model()).toBe('acme/large');
});

test('the answer names the model through a retry, a time limit and a race', async () => {
  const retried = motty({ name: 'retried' }).handle(({ prompt }) =>
    retry(small, 1).complete(prompt),
  );
  const limited = motty({ name: 'limited' }).handle(({ prompt }) =>
    timeout(fallback(small, large), { first: 1000, stall: 1000 }).complete(
      prompt,
    ),
  );
  const raced = motty({ name: 'raced' }).handle(({ prompt }) =>
    race(small, large).complete(prompt),
  );

  const again = await run(
    retried,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, new Overloaded('busy', { retryAfter: 0 })),
          on(small, 'second reply'),
        ),
      ],
    },
  );
  const inTime = await run(
    limited,
    { text: 'hi' },
    { models: [fake(on(small, new Overloaded('busy')), on(large, 'reply'))] },
  );
  const won = await run(
    raced,
    { text: 'hi' },
    { models: [fake(on(small, new Overloaded('busy')), on(large, 'reply'))] },
  );

  expect(await again.answer.model()).toBe('acme/small');
  expect(await inTime.answer.model()).toBe('acme/large');
  expect(await won.answer.model()).toBe('acme/large');
});

test('the answer of a nested motty names the model its entry called', async () => {
  const sizes = motty({ name: 'sizes' }).route(() => 'big', {
    little: ({ prompt }) => small.complete(prompt),
    big: ({ prompt }) => large.complete(prompt),
  });
  const routed = motty({ name: 'routed' }).route(() => 'chat', {
    chat: sizes,
  });

  const { path, answer: reply } = await run(
    routed,
    { text: 'hi' },
    { models: [fake(on(large, 'big reply'))] },
  );

  expect(path).toEqual(['chat', 'big']);
  expect(await reply.model()).toBe('acme/large');
});

test('a rewritten answer names the model of the one it was made from', async () => {
  const rewriting = motty({ name: 'rewriting' })
    .handle(({ prompt }) => large.complete(prompt))
    .afterHandle(async (context) => {
      context.answer = answer(
        (await context.answer.text()).toUpperCase(),
        context.answer,
      );
    });

  const { answer: reply } = await run(
    rewriting,
    { text: 'hi' },
    { models: [fake(on(small, 'unused'), on(large, 'reply'))] },
  );

  expect(await reply.text()).toBe('REPLY');
  expect(await reply.model()).toBe('acme/large');
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

test('the answer names the model that gave it, not the one called last', async () => {
  const comparing = motty({ name: 'comparing' }).handle(async ({ prompt }) => {
    const reply = await small.complete(prompt);
    await large.complete(prompt);
    return reply;
  });

  const { calls, answer: reply } = await run(
    comparing,
    { text: 'hi' },
    { models: [fake(on(small, 'reply'), on(large, 'second opinion'))] },
  );

  expect(calls.map((call) => call.model)).toEqual(['acme/small', 'acme/large']);
  expect(await reply.model()).toBe('acme/small');
});

test('an answer made by hand names no model though a model was called', async () => {
  const judging = motty({ name: 'judging' }).handle(async ({ prompt }) =>
    answer(`judged: ${await (await small.complete(prompt)).text()}`),
  );

  const { answer: reply } = await run(
    judging,
    { text: 'hi' },
    { models: [fake(on(small, 'fine'))] },
  );

  expect(await reply.text()).toBe('judged: fine');
  expect(await reply.model()).toBeUndefined();
});
