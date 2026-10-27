import { afterEach, expect, mock, test } from 'bun:test';
import { MottyError, Unsupported } from '../../src/data/errors.ts';
import { current, enter } from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { stubHost } from '../stub-host.ts';

afterEach(() => {
  mock.restore();
});

test('a Standard Schema reaches the host as its JSON Schema and types the value', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: '{"city":"Oslo"}' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 2, cached: 0, reasoning: 0 },
      },
    ],
  });

  const [place, wrong] = await enter(host, async () => {
    const reply = await model('acme/small').complete({
      messages: [],
      output: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) =>
            typeof value === 'object' &&
            value !== null &&
            'city' in value &&
            typeof value.city === 'string'
              ? { value: { city: value.city } }
              : { issues: [{ message: 'city must be a string' }] },
          jsonSchema: {
            output: () => ({
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            }),
          },
        },
      },
    });
    const place: { city: string } = await reply.json();
    // @ts-expect-error the schema's output has no number in it
    const wrong: { city: number } = await reply.json();
    return [place, wrong];
  });

  expect([place, wrong]).toEqual([{ city: 'Oslo' }, { city: 'Oslo' }]);
  expect(host.sent('acme/small')).toEqual([
    {
      messages: [],
      output: {
        schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ]);
});

test('a Standard Schema with no JSON Schema throws Unsupported, uncounted and unasked', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const calls = await enter(host, async () => {
    await expect(
      model('acme/small').complete({
        messages: [],
        output: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value: unknown) => ({ value }),
          },
        },
      }),
    ).rejects.toBeInstanceOf(Unsupported);
    return current().calls;
  });

  expect(host.sent('acme/small')).toEqual([]);
  expect(calls.made).toEqual([]);
});

test('a prompt with no output reaches the host as the very object, with no output key', async () => {
  const host = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  const prompt = {
    messages: [{ role: 'user' as const, text: 'Hi' }],
    options: { temperature: 0 },
  };

  await enter(host, () => model('acme/small').complete(prompt));

  const sent = host.sent('acme/small')[0];
  expect(sent).toBe(prompt);
  expect(Object.hasOwn(sent ?? {}, 'output')).toBe(false);
});

test('messages, options and a JSON Schema output reach the host as the references the author passed', async () => {
  const host = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  const prompt = {
    messages: [{ role: 'user' as const, text: 'Hi' }],
    options: { stop: ['END'] },
    output: { schema: { type: 'object' } },
  };

  await enter(host, () => model('acme/small').complete(prompt));

  const sent = host.sent('acme/small')[0];
  expect(sent?.messages).toBe(prompt.messages);
  expect(sent?.options).toBe(prompt.options);
  expect(sent?.output).toBe(prompt.output);
});

test.each([
  ['a class instance', () => ({ default: new URL('https://example.com') })],
  ['an array with a hole', () => ({ enum: new Array(2) })],
  ['an undefined value', () => ({ default: undefined })],
  ['a number that is not finite', () => ({ maximum: Number.NaN })],
  [
    'a value that holds itself',
    () => {
      const schema = { type: 'object', not: {} };
      schema.not = schema;
      return schema;
    },
  ],
  [
    'a value nested too deep to walk',
    () => {
      let schema = {};
      for (let depth = 0; depth < 1_000_000; depth += 1) {
        schema = { not: schema };
      }
      return schema;
    },
  ],
  [
    'a getter that throws',
    () => ({
      get default(): string {
        throw new RangeError('Not ready');
      },
    }),
  ],
])(
  'a JSON Schema form holding %s throws Unsupported and the host is not asked',
  async (_name, output) => {
    const host = stubHost();

    const calls = await enter(host, async () => {
      await expect(
        model('acme/small').complete({
          messages: [],
          output: {
            '~standard': {
              version: 1,
              vendor: 'test',
              validate: (value: unknown) => ({ value }),
              jsonSchema: { output },
            },
          },
        }),
      ).rejects.toBeInstanceOf(Unsupported);
      return current().calls;
    });

    expect(host.sent('acme/small')).toEqual([]);
    expect(calls.made).toEqual([]);
  },
);

test('a JSON Schema form of plain data is sent, an object with no prototype included', async () => {
  const host = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });

  await enter(host, () =>
    model('acme/small').complete({
      messages: [],
      output: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            output: () =>
              Object.assign(Object.create(null), {
                type: 'object',
                properties: {
                  city: { type: ['string', 'null'], default: null },
                },
                additionalProperties: false,
                minProperties: 0,
              }),
          },
        },
      },
    }),
  );

  expect(host.sent('acme/small')).toEqual([
    {
      messages: [],
      output: {
        schema: {
          type: 'object',
          properties: { city: { type: ['string', 'null'], default: null } },
          additionalProperties: false,
          minProperties: 0,
        },
      },
    },
  ]);
});

test.each([
  ['no validate function', '{"~standard":{"version":1,"vendor":"test"}}'],
  ['a validate that is not a function', '{"~standard":{"validate":true}}'],
  ['nothing', '{"~standard":null}'],
])(
  'an output whose ~standard holds %s throws Unsupported and the host is not asked',
  async (_name, output) => {
    const host = stubHost();

    const calls = await enter(host, async () => {
      await expect(
        model('acme/small').complete({
          messages: [],
          output: JSON.parse(output),
        }),
      ).rejects.toBeInstanceOf(Unsupported);
      return current().calls;
    });

    expect(host.sent('acme/small')).toEqual([]);
    expect(calls.made).toEqual([]);
  },
);

test.each([
  ['null', 'null'],
  ['text', '"object"'],
  ['an array', '[]'],
])(
  'an output that is %s throws Unsupported and the host is not asked',
  async (_name, output) => {
    const host = stubHost();

    const calls = await enter(host, async () => {
      await expect(
        model('acme/small').complete({
          messages: [],
          output: JSON.parse(output),
        }),
      ).rejects.toBeInstanceOf(Unsupported);
      return current().calls;
    });

    expect(host.sent('acme/small')).toEqual([]);
    expect(calls.made).toEqual([]);
  },
);

test('an output whose ~standard throws when read throws Unsupported holding the cause', async () => {
  const host = stubHost();

  await enter(host, async () => {
    await expect(
      model('acme/small').complete({
        messages: [],
        output: {
          get '~standard'(): never {
            throw new RangeError('Not ready');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      cause: expect.any(RangeError),
    });
  });

  expect(host.sent('acme/small')).toEqual([]);
});

test.each([
  ['undefined', JSON.parse('{}').prompt],
  ['null', JSON.parse('null')],
])(
  'a prompt that is %s fails the call with a plain error, the author’s mistake',
  async (_name, prompt) => {
    const host = stubHost();

    const failure = await enter(host, () =>
      model('acme/small')
        .complete(prompt)
        .catch((thrown: unknown) => thrown),
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MottyError);
    expect(failure).toHaveProperty('message', 'A prompt must be an object');
    expect(host.sent('acme/small')).toEqual([]);
  },
);

test.each([
  ['an array', '[]'],
  ['null', 'null'],
  ['text', '"object"'],
])(
  'a JSON Schema form whose root is %s throws Unsupported and the host is not asked',
  async (_name, form) => {
    const host = stubHost();

    await enter(host, async () => {
      await expect(
        model('acme/small').complete({
          messages: [],
          output: {
            '~standard': {
              version: 1,
              vendor: 'test',
              validate: (value: unknown) => ({ value }),
              jsonSchema: { output: () => JSON.parse(form) },
            },
          },
        }),
      ).rejects.toBeInstanceOf(Unsupported);
    });

    expect(host.sent('acme/small')).toEqual([]);
  },
);

test('the converter of a Standard Schema is asked for draft 2020-12 and nothing else', async () => {
  const host = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  const asked: unknown[] = [];

  await enter(host, () =>
    model('acme/small').complete({
      messages: [],
      output: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            output: (...options) => {
              asked.push(...options);
              return { type: 'object' };
            },
          },
        },
      },
    }),
  );

  expect(asked).toStrictEqual([{ target: 'draft-2020-12' }]);
});

test('a converter that throws fails the call as Unsupported holding what it threw', async () => {
  const host = stubHost();

  await enter(host, async () => {
    await expect(
      model('acme/small').complete({
        messages: [],
        output: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value: unknown) => ({ value }),
            jsonSchema: {
              output: () => {
                throw new RangeError('No JSON Schema for a transform');
              },
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      cause: expect.any(RangeError),
    });
  });

  expect(host.sent('acme/small')).toEqual([]);
});

test('a JSON Schema form whose branches share one definition is sent, the shared object walked once', async () => {
  const host = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  let walked = 0;

  await enter(host, () =>
    model('acme/small').complete({
      messages: [],
      output: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => ({ value }),
          jsonSchema: {
            output: () => {
              const shared = {
                get type() {
                  walked += 1;
                  return 'string';
                },
              };
              let schema: { [keyword: string]: unknown } = shared;
              for (let depth = 0; depth < 8; depth += 1) {
                schema = { anyOf: [schema, schema], not: schema };
              }
              return schema;
            },
          },
        },
      },
    }),
  );

  expect(walked).toBe(1);
  expect(host.sent('acme/small')).toHaveLength(1);
}, 1_000);

test('a Standard Schema inside the object form reaches the host as its JSON Schema with what is stated beside it, and types the value', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: '{"city":"Oslo","extra":true}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const [place, wrong] = await enter(host, async () => {
    const reply = await model('acme/small').complete({
      messages: [],
      output: {
        name: 'place',
        description: 'Where it is',
        strict: true,
        schema: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value: unknown) =>
              typeof value === 'object' &&
              value !== null &&
              'city' in value &&
              typeof value.city === 'string'
                ? { value: { city: value.city } }
                : { issues: [{ message: 'city must be a string' }] },
            jsonSchema: {
              output: () => ({
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              }),
            },
          },
        },
      },
    });
    const place: { city: string } = await reply.json();
    // @ts-expect-error the schema's output has no number in it
    const wrong: { city: number } = await reply.json();
    return [place, wrong];
  });

  expect([place, wrong]).toEqual([{ city: 'Oslo' }, { city: 'Oslo' }]);
  expect(host.sent('acme/small')).toEqual([
    {
      messages: [],
      output: {
        name: 'place',
        description: 'Where it is',
        strict: true,
        schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    },
  ]);
});

test('a callable Standard Schema inside the object form is sent as its JSON Schema', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: '{}' },
      { type: 'finish', reason: 'stop' },
    ],
  });

  await enter(host, () =>
    model('acme/small').complete({
      messages: [],
      output: {
        strict: true,
        schema: Object.assign(() => {}, {
          '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: (value: unknown) => ({ value }),
            jsonSchema: { output: () => ({ type: 'object' }) },
          },
        }),
      },
    }),
  );

  expect(host.sent('acme/small')).toEqual([
    { messages: [], output: { strict: true, schema: { type: 'object' } } },
  ]);
});
