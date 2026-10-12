import { expect, test } from 'bun:test';
import { answer, fallback, model, motty, Overloaded } from '@mottyjs/core';
import { counted, hosted } from '@mottyjs/core/host';
import { decision, noul } from '@mottyjs/decision';
import { fake, on, run, Unscripted } from '../src/index.ts';

const small = model('acme/small');
const large = model('acme/large');
const judge = decision('acme/judge');

const asking = motty({ name: 'asking' }).handle(({ prompt }) =>
  small.complete(prompt),
);

// The decision call as a plugin makes it, so the fake is held to the host
// contract and not to one plugin's reading of it.
const judging = motty({ name: 'judging' }).handle(async ({ request }) =>
  answer(
    JSON.stringify(
      await counted('acme/judge', async (signal) =>
        hosted().decisions?.(
          'acme/judge',
          {
            state: request.messages.at(-1)?.text ?? '',
            questions: {
              urgent: { type: 'noul', instructions: 'Is it urgent?' },
            },
          },
          signal,
        ),
      ),
    ),
  ),
);

test('a scripted text is the answer of the model it was scripted for', async () => {
  const { answer: reply } = await run(
    asking,
    { text: 'hi' },
    { models: [fake(on(small, 'quick reply'))] },
  );

  expect(await reply.text()).toBe('quick reply');
});

test('scripted chunks reach the answer as chunks', async () => {
  const { answer: reply } = await run(
    asking,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, [
            { type: 'reasoning', text: 'The lock order differs' },
            { type: 'text', text: 'deep reply' },
          ]),
        ),
      ],
    },
  );

  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'reasoning', text: 'The lock order differs' },
    { type: 'text', text: 'deep reply' },
  ]);
  expect(await reply.text()).toBe('deep reply');
});

test('a scripted JSON value is read back as JSON', async () => {
  const { answer: reply } = await run(
    asking,
    { text: 'Which files?', output: { schema: { type: 'object' } } },
    { models: [fake(on(small, { files: ['parser.ts'] }))] },
  );

  expect(await reply.json()).toEqual({ files: ['parser.ts'] });
});

test('a scripted function replies from the prompt it was sent', async () => {
  const { answer: reply } = await run(
    asking,
    { text: 'hi' },
    {
      models: [
        fake(on(small, ({ messages }) => `You said ${messages.at(-1)?.text}`)),
      ],
    },
  );

  expect(await reply.text()).toBe('You said hi');
});

test('a scripted error fails the call, and a fallback moves on', async () => {
  const falling = motty({ name: 'falling' }).handle(({ prompt }) =>
    fallback(small, large).complete(prompt),
  );

  const { answer: reply, calls } = await run(
    falling,
    { text: 'hi' },
    {
      models: [
        fake(on(small, new Overloaded('busy')), on(large, 'fallback reply')),
      ],
    },
  );

  expect(await reply.text()).toBe('fallback reply');
  expect(calls.map(({ model, code }) => [model, code])).toEqual([
    ['acme/small', 'overloaded'],
    ['acme/large', undefined],
  ]);
});

test("one model's entries answer in order and the last repeats", async () => {
  const thrice = motty({ name: 'thrice' }).handle(async ({ prompt }) => {
    const first = await small.complete(prompt);
    const second = await small.complete(prompt);
    const third = await small.complete(prompt);
    const other = await large.complete(prompt);
    return answer(
      [
        await first.text(),
        await second.text(),
        await third.text(),
        await other.text(),
      ].join(', '),
    );
  });

  const { answer: reply } = await run(
    thrice,
    { text: 'hi' },
    {
      models: [fake(on(small, 'one'), on(large, 'other'), on(small, 'two'))],
    },
  );

  expect(await reply.text()).toBe('one, two, two, other');
});

test('sent returns the prompts a model was sent, in order', async () => {
  const models = fake(on(small, 'reply'));
  const twice = motty({ name: 'twice' }).handle(async ({ prompt }) => {
    await small.complete({
      messages: [{ role: 'user', text: 'Plan it' }],
      options: { reasoning: { effort: 'high' } },
    });
    return small.complete(prompt);
  });

  await run(twice, { text: 'hi' }, { models: [models] });

  expect(models.sent(small)).toEqual([
    {
      messages: [{ role: 'user', text: 'Plan it' }],
      options: { reasoning: { effort: 'high' } },
    },
    { messages: [{ role: 'user', text: 'hi' }], tools: [], options: {} },
  ]);
  expect(models.sent(large)).toEqual([]);
});

test('a fake serves only the names it has entries for', () => {
  const models = fake(on(small, 'reply'), on(judge, { urgent: 0.9 }));

  expect(models.serves('acme/small')).toBe(true);
  expect(models.serves('acme/judge')).toBe(true);
  expect(models.serves('acme/large')).toBe(false);
});

test('an adapter beside a fake is asked for the names it serves', async () => {
  const both = motty({ name: 'both' }).handle(async ({ prompt }) => {
    const plan = await small.complete(prompt);
    const reply = await large.complete(prompt);
    return answer(`${await plan.text()}, ${await reply.text()}`);
  });

  const { answer: reply } = await run(
    both,
    { text: 'hi' },
    {
      models: [
        fake(on(small, 'scripted')),
        {
          serves: (name) => name.startsWith('acme/'),
          async *call(name) {
            yield { type: 'text', text: `adapter for ${name}` };
            yield { type: 'finish', reason: 'stop' };
          },
        },
      ],
    },
  );

  expect(await reply.text()).toBe('scripted, adapter for acme/large');
});

test('a scripted decision crosses the host as the whole wire reply', async () => {
  const models = fake(on(judge, { urgent: 0.9 }));

  const { answer: reply, calls } = await run(
    judging,
    { text: 'The build is red' },
    { models: [models] },
  );

  expect(await reply.json()).toEqual({
    model: 'acme/judge',
    answers: { urgent: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  expect(calls.map((call) => call.model)).toEqual(['acme/judge']);
  expect(models.sent(judge)).toEqual([
    {
      state: 'The build is red',
      questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } },
    },
  ]);
});

test("one decision model's entries answer in order and the last repeats", async () => {
  const models = fake(on(judge, { urgent: 0.1 }), on(judge, { urgent: 0.9 }));

  const first = await run(judging, { text: 'hi' }, { models: [models] });
  const second = await run(judging, { text: 'hi' }, { models: [models] });
  const third = await run(judging, { text: 'hi' }, { models: [models] });

  expect(await first.answer.json()).toMatchObject({
    answers: { urgent: { noul: 0.1 } },
  });
  expect(await second.answer.json()).toMatchObject({
    answers: { urgent: { noul: 0.9 } },
  });
  expect(await third.answer.json()).toMatchObject({
    answers: { urgent: { noul: 0.9 } },
  });
});

test('a scripted decision is typed by the questions the plugin asks', async () => {
  const gate = motty({ name: 'gate' }).handle(async ({ request }) => {
    const { urgent } = await judge.decide(request.messages.at(-1)?.text ?? '', {
      urgent: noul({ instructions: 'Is it urgent?' }),
    });
    return answer(urgent.noul >= 0.5 ? 'now' : 'later');
  });

  const { answer: reply } = await run(
    gate,
    { text: 'The build is red' },
    { models: [fake(on(judge, { urgent: 0.9 }))] },
  );

  expect(await reply.text()).toBe('now');
});

test('a decision nobody scripted fails the run though the motty recovered', async () => {
  const lenient = motty({ name: 'lenient' }).handle(async () => {
    try {
      await counted('acme/judge', async (signal) =>
        hosted().decisions?.(
          'acme/judge',
          { state: 'hi', questions: {} },
          signal,
        ),
      );
      return answer('judged');
    } catch {
      return answer('passed');
    }
  });

  const asked = run(lenient, { text: 'hi' }, { models: [fake()] });

  await expect(asked).rejects.toBeInstanceOf(Unscripted);
});

test('a question no entry names fails the run though the motty recovered', async () => {
  const lenient = motty({ name: 'lenient' })
    .use(judging)
    .onError(() => answer('passed'));

  const asked = run(
    lenient,
    { text: 'hi' },
    { models: [fake(on(judge, { software: 0.97 }))] },
  );

  await expect(asked).rejects.toBeInstanceOf(Unscripted);
});

test('a chat call to a name scripted as a decision model is not scripted', async () => {
  const mixed = motty({ name: 'mixed' }).handle(({ prompt }) =>
    model('acme/judge').complete(prompt),
  );

  const asked = run(
    mixed,
    { text: 'hi' },
    { models: [fake(on(judge, { urgent: 0.9 }))] },
  );

  await expect(asked).rejects.toThrow(
    'No chat reply was scripted for acme/judge',
  );
});

test.each([
  [
    'none by default',
    {},
    {},
    ['headers.x-session', 'headers.x-title', 'headers.cookie'],
  ],
  [
    'the ones its connection lists',
    { forwardHeaders: ['X-Session', 'cookie'] },
    { 'x-session': 's-1' },
    ['headers.x-title', 'headers.cookie'],
  ],
  [
    'all but the ones never sent when its connection forwards any',
    { forwardHeaders: true },
    { 'x-session': 's-1', 'x-title': 'Coder' },
    ['headers.cookie'],
  ],
] as const)(
  'a fake is sent %s of the headers a call states, and the call is warned of the rest',
  async (_, connection, headers, warned) => {
    const models = fake(connection, on(small, 'ok'));

    const { answer: reply, calls } = await run(
      motty({ name: 'stating' }).handle(({ prompt }) => {
        prompt.options = {
          headers: {
            'x-session': 's-1',
            'x-title': 'Coder',
            'x-absent': null,
            cookie: 'a=b',
          },
        };
        return small.complete(prompt);
      }),
      { text: 'hi' },
      { models: [models] },
    );

    expect(await reply.text()).toBe('ok');
    expect(models.sent(small)[0]?.options).toEqual({ headers });
    expect(calls[0]?.warnings?.map(({ setting }) => setting) ?? []).toEqual([
      ...warned,
    ]);
  },
);

test('a header no request can carry fails a call to a fake before it is sent, as it does a real connection', async () => {
  const models = fake(on(small, 'ok'));

  const asked = run(
    motty({ name: 'stating' }).handle(({ prompt }) => {
      prompt.options = { headers: { 'x note': 'bad' } };
      return small.complete(prompt);
    }),
    { text: 'hi' },
    { models: [models] },
  );

  await expect(asked).rejects.toThrow(
    'A call stated the header "x note" with a name no request can carry',
  );
  expect(models.sent(small)).toEqual([]);
});

test('sent is typed by the kind of model it is asked about', () => {
  const models = fake(on(small, 'reply'));

  expect(models.sent(small)[0]?.messages).toBeUndefined();
  // @ts-expect-error what a decision model was sent is JSON, not a prompt
  expect(models.sent(judge)[0]?.messages).toBeUndefined();
});
