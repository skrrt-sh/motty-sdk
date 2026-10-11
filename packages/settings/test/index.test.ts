import { expect, test } from 'bun:test';
import {
  answer,
  type ChatRequest,
  type Motty,
  motty,
  type StandardSchema,
} from '@mottyjs/core';
import {
  type EventStream,
  type Host,
  mark,
  type RequestRecord,
} from '@mottyjs/core/host';
import { z } from 'zod';
import * as entry from '../src/index.ts';
import { type Settings, settings } from '../src/index.ts';

function ask(): ChatRequest {
  return {
    id: 'req_1',
    model: 'motty/coder',
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers: new Headers(),
  };
}

async function* unserved(): EventStream {
  yield {
    type: 'error',
    error: { code: 'unknown_model', status: 404, message: 'No model' },
  };
}

async function ran(served: Motty, rest: Partial<Host> = {}) {
  const record = Promise.withResolvers<RequestRecord>();
  const events = await Array.fromAsync(
    served[mark].run(ask(), {
      models: unserved,
      signal: new AbortController().signal,
      record: record.resolve,
      ...rest,
    }),
  );
  return { events, record: await record.promise };
}

function tuned() {
  return settings({
    offTopic: z.object({
      onTopicProbability: z.number().min(0).max(1).default(0.1),
    }),
    tiers: z.object({
      quickQuestionChars: z.number().int().min(0).default(400),
      deepProbability: z.number().min(0).max(1).default(0.35),
    }),
  });
}

test('with no overrides every setting is the default its schema defines', async () => {
  const read: unknown[] = [];

  await ran(
    motty({ name: 'coder' })
      .use(tuned())
      .handle(({ settings }) => {
        read.push(settings);
        return answer('Hi');
      }),
  );

  expect(read).toEqual([
    {
      offTopic: { onTopicProbability: 0.1 },
      tiers: { quickQuestionChars: 400, deepProbability: 0.35 },
    },
  ]);
});

test('the host overrides any subset, by group, and the rest keeps its defaults', async () => {
  const read: unknown[] = [];

  await ran(
    motty({ name: 'coder' })
      .use(tuned())
      .handle(({ settings }) => {
        read.push(settings);
        return answer('Hi');
      }),
    { settings: { tiers: { deepProbability: 0.6 } } },
  );

  expect(read).toEqual([
    {
      offTopic: { onTopicProbability: 0.1 },
      tiers: { quickQuestionChars: 400, deepProbability: 0.6 },
    },
  ]);
});

test('overrides are read per request, so two requests to one motty may differ', async () => {
  const read: number[] = [];
  const served = motty({ name: 'coder' })
    .use(tuned())
    .handle(({ settings }) => {
      read.push(settings.tiers.deepProbability);
      return answer('Hi');
    });

  await ran(served, { settings: { tiers: { deepProbability: 0.6 } } });
  await ran(served);
  await ran(served, { settings: { tiers: { deepProbability: 0.2 } } });

  expect(read).toEqual([0.6, 0.35, 0.2]);
});

test('an override its group refuses fails the request, and the record names the group', async () => {
  let reached = false;

  const { events, record } = await ran(
    motty({ name: 'coder' })
      .use(tuned())
      .handle(() => {
        reached = true;
        return answer('Hi');
      }),
    { settings: { tiers: { deepProbability: 7 } } },
  );

  expect(events).toEqual([
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'internal', status: 500 }),
    }),
  ]);
  expect(record.error?.message).toStartWith(
    'The host\'s settings for the group "tiers" are not valid: ',
  );
  expect(reached).toBe(false);
});

test('an override that is no group at all is refused like a wrong value', async () => {
  const { record } = await ran(
    motty({ name: 'coder' })
      .use(tuned())
      .handle(() => answer('Hi')),
    { settings: { offTopic: null } },
  );

  expect(record.error?.message).toStartWith(
    'The host\'s settings for the group "offTopic" are not valid: ',
  );
});

test('an override for a group the motty does not define is not a setting and is left out', async () => {
  const read: unknown[] = [];

  const { record } = await ran(
    motty({ name: 'coder' })
      .use(tuned())
      .handle(({ settings }) => {
        read.push(Object.keys(settings));
        return answer('Hi');
      }),
    { settings: { deep: { firstChunkMs: 1 }, toString: {} } },
  );

  expect(record.outcome).toBe('completed');
  expect(read).toEqual([['offTopic', 'tiers']]);
});

test('a group that does not accept {} fails the motty at load', () => {
  expect(() =>
    settings({ tiers: z.object({ deepProbability: z.number() }) }),
  ).toThrow(
    'The settings group "tiers" must accept {}, so that every setting has a default: ',
  );
});

test('a group that validates asynchronously fails the motty at load, which awaits nothing', () => {
  expect(() =>
    settings({
      tiers: z.object({
        deepProbability: z
          .number()
          .default(0.35)
          .refine(async (value) => value <= 1),
      }),
    }),
  ).toThrow(
    'The settings group "tiers" validates asynchronously, so it cannot be checked at load',
  );
});

test('a group is any Standard Schema, and its output is the setting', async () => {
  const limit: StandardSchema<unknown, { calls: number }> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) =>
        typeof value === 'object' &&
        value !== null &&
        'calls' in value &&
        typeof value.calls === 'number'
          ? { value: { calls: value.calls } }
          : { value: { calls: 3 } },
    },
  };
  const read: number[] = [];
  const served = motty({ name: 'coder' })
    .use(settings({ limit }))
    .handle(({ settings }) => {
      read.push(settings.limit.calls);
      return answer('Hi');
    });

  await ran(served);
  await ran(served, { settings: { limit: { calls: 9 } } });

  expect(read).toEqual([3, 9]);
});

test('one settings part used by a motty and by several of its parts is applied once per request', async () => {
  const validated: unknown[] = [];
  const tuning = settings({
    tiers: {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => {
          validated.push(value);
          return { value: { deepProbability: 0.35 } };
        },
      },
    },
  });
  const read: number[] = [];

  await ran(
    motty({ name: 'coder' })
      .use(tuning)
      .use(
        motty({ name: 'off-topic' })
          .use(tuning)
          .beforeHandle(({ settings }) => {
            read.push(settings.tiers.deepProbability);
          }),
      )
      .route(() => 'chat', {
        chat: motty({ name: 'tiers' })
          .use(tuning)
          .handle(({ settings }) => {
            read.push(settings.tiers.deepProbability);
            return answer('Hi');
          }),
      }),
    { settings: { tiers: { deepProbability: 0.6 } } },
  );

  expect(validated).toEqual([{}, { deepProbability: 0.6 }]);
  expect(read).toEqual([0.35, 0.35]);
});

test('one settings part used twice by one motty is one part', async () => {
  const tuning = tuned();
  const read: number[] = [];

  await ran(
    motty({ name: 'coder' })
      .use(tuning)
      .use(tuning)
      .handle(({ settings }) => {
        read.push(settings.tiers.deepProbability);
        return answer('Hi');
      }),
  );

  expect(read).toEqual([0.35]);
});

test('two settings parts of the same groups and other schemas are refused together', () => {
  expect(() =>
    motty({ name: 'coder' })
      .use(settings({ tiers: z.object({ deep: z.number().default(0.35) }) }))
      .use(settings({ tiers: z.object({ deep: z.string().default('no') }) })),
  ).toThrow('Two different parts share the name "settings"');
});

test('two settings parts of other groups are refused together', () => {
  expect(() =>
    motty({ name: 'coder' })
      .use(settings({ tiers: z.object({ deep: z.number().default(0.35) }) }))
      .use(settings({ limits: z.object({ turns: z.number().default(8) }) })),
  ).toThrow('Two different parts share the name "settings"');
});

test('a second settings part in a module, used or routed to, is refused', () => {
  const coder = motty({ name: 'coder' }).use(tuned());

  expect(() =>
    coder.use(
      motty({ name: 'off-topic' }).use(
        motty({ name: 'threshold' }).use(tuned()),
      ),
    ),
  ).toThrow('Two different parts share the name "settings"');
  expect(() =>
    coder.route(() => 'chat', {
      chat: motty({ name: 'tiers' })
        .use(motty({ name: 'threshold' }).use(tuned()))
        .handle(() => answer('Hi')),
    }),
  ).toThrow('Two different parts share the name "settings"');
});

test('two modules routed to, each with a settings part of its own, are refused', () => {
  expect(() =>
    motty({ name: 'coder' }).route(() => 'quick', {
      quick: motty({ name: 'quick' })
        .use(tuned())
        .handle(() => answer('Hi')),
      deep: motty({ name: 'deep' })
        .use(tuned())
        .handle(() => answer('Hi')),
    }),
  ).toThrow('Two different parts share the name "settings"');
});

test('a second settings part fails at load, before the host reads the motty, and says what to do', () => {
  const read = { mark: false };

  try {
    const served = motty({ name: 'coder' })
      .use(tuned())
      .use(motty({ name: 'tiers' }).use(tuned()))
      .handle(() => answer('Hi'));
    read.mark = served[mark] !== undefined;
  } catch (thrown) {
    expect(thrown).toEqual(
      new Error(
        'Two different parts share the name "settings" and its seed: use one part everywhere, or make each from its own motty() call',
      ),
    );
  }

  expect(read.mark).toBe(false);
  expect.assertions(2);
});

test('the settings are in after-response work and in the description as one plugin', async () => {
  const read: number[] = [];
  const served = motty({ name: 'coder' })
    .use(tuned())
    .handle(() => answer('Hi'))
    .afterResponse(({ settings }) => {
      if (settings !== undefined) read.push(settings.tiers.quickQuestionChars);
    });

  await ran(served);

  expect(read).toEqual([400]);
  expect(served[mark].description.plugins).toEqual(['settings']);
});

test('the types check every setting a motty reads, and none can be changed', () => {
  const tuning = tuned();
  const tiers: Settings<typeof tuning>['tiers'] = {
    quickQuestionChars: 400,
    deepProbability: 0.35,
  };
  // @ts-expect-error
  const partial: Settings<typeof tuning>['tiers'] = { deepProbability: 0.35 };
  // @ts-expect-error
  const unknown: Settings<typeof tuning>['deep'] = {};

  motty({ name: 'coder' })
    .use(tuning)
    .handle(({ settings }) => {
      const chars: number = settings.tiers.quickQuestionChars;
      // @ts-expect-error
      const text: string = settings.tiers.quickQuestionChars;
      // @ts-expect-error
      settings.tiers.slowQuestionChars;
      // @ts-expect-error
      settings.deep;
      // @ts-expect-error
      settings.tiers.deepProbability = 1;
      // @ts-expect-error
      settings.tiers = tiers;
      return answer(`${chars}${text}${partial}${unknown}`);
    });
  motty({ name: 'coder' }).handle((context) => {
    // @ts-expect-error
    context.settings;
    return answer('Hi');
  });
  // Never called: what the types refuse here would throw when run.
  () => {
    // @ts-expect-error
    settings({ tiers: { deepProbability: 0.35 } });
    // @ts-expect-error
    settings(z.object({ deepProbability: z.number().default(0.35) }));
  };
});

test('the entry exports exactly the held values', () => {
  expect(Object.keys(entry).sort()).toEqual(['settings']);
});

test('the entry exports exactly the held types', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(
    [...text.matchAll(/export type (\w+)/g)].map(([, name]) => name),
  ).toEqual(['Settings']);
});

test('a write to a default throws in the motty that makes it, and the next request reads the defaults', async () => {
  const read: unknown[] = [];
  const served = motty({ name: 'coder' })
    .use(
      settings({
        tiers: z.object({
          threshold: z.number().default(0.5),
          names: z.array(z.string()).default(['a']),
        }),
      }),
    )
    .handle(({ request, settings }) => {
      if (request.id === 'req_write') {
        Object.assign(settings.tiers.names, { 1: 'evil' });
        Object.assign(settings.tiers, { threshold: 99 });
      }
      read.push(structuredClone(settings));
      return answer('Hi');
    });
  const record = Promise.withResolvers<RequestRecord>();

  await Array.fromAsync(
    served[mark].run(
      { ...ask(), id: 'req_write' },
      {
        models: unserved,
        signal: new AbortController().signal,
        record: record.resolve,
      },
    ),
  );
  await ran(served);

  expect((await record.promise).outcome).toBe('failed');
  expect(read).toEqual([{ tiers: { threshold: 0.5, names: ['a'] } }]);
});

test('with overrides, a write to any group or to the settings themselves throws, and the next request reads what the host set', async () => {
  const read: unknown[] = [];
  const written: string[] = [];
  const served = motty({ name: 'coder' })
    .use(
      settings({
        tiers: z.object({ names: z.array(z.string()).default(['a']) }),
        limits: z.object({ turns: z.array(z.number()).default([8]) }),
        raw: {
          '~standard': {
            version: 1,
            vendor: 'test',
            validate: (value: unknown) => ({ value }),
          },
        },
      }),
    )
    .handle(({ request, settings }) => {
      if (request.id === 'req_write') {
        for (const [name, write] of [
          ['a default', () => Object.assign(settings.tiers.names, { 1: 'x' })],
          ['an override', () => Object.assign(settings.limits.turns, [99])],
          [
            'what the host passed',
            () =>
              typeof settings.raw === 'object' &&
              settings.raw !== null &&
              Object.assign(settings.raw, { x: 1 }),
          ],
          ['the settings', () => Object.assign(settings, { tiers: {} })],
        ] as const) {
          try {
            write();
            written.push(name);
          } catch {}
        }
      }
      read.push(structuredClone(settings));
      return answer('Hi');
    });
  const overrides = { limits: { turns: [3] }, raw: { deep: { list: [1] } } };

  await Array.fromAsync(
    served[mark].run(
      { ...ask(), id: 'req_write' },
      {
        models: unserved,
        signal: new AbortController().signal,
        settings: overrides,
      },
    ),
  );
  await ran(served, { settings: overrides });

  expect(written).toEqual([]);
  expect(read[1]).toEqual({
    tiers: { names: ['a'] },
    limits: { turns: [3] },
    raw: { deep: { list: [1] } },
  });
});

test('a group named as the prototype is a group like any other, and the settings inherit nothing', async () => {
  const read: unknown[] = [];
  const served = motty({ name: 'coder' })
    .use(
      settings({
        ['__proto__']: z.object({ threshold: z.number().default(0.5) }),
        tiers: z.object({ deep: z.number().default(0.35) }),
      }),
    )
    .handle(({ settings }) => {
      read.push([
        Object.keys(settings).sort(),
        Object.getOwnPropertyDescriptor(settings, '__proto__')?.value,
        'threshold' in settings,
        'toString' in settings,
      ]);
      return answer('Hi');
    });

  const plain = await ran(served);
  const overridden = await ran(served, {
    settings: JSON.parse('{"__proto__":{"threshold":0.9}}'),
  });

  expect([plain.record.outcome, overridden.record.outcome]).toEqual([
    'completed',
    'completed',
  ]);
  expect(read).toEqual([
    [['__proto__', 'tiers'], { threshold: 0.5 }, false, false],
    [['__proto__', 'tiers'], { threshold: 0.9 }, false, false],
  ]);
});

test('a group whose validation gives a thenable that is no Promise fails the motty at load like any asynchronous one', () => {
  const later = Promise.resolve({ value: { deepProbability: 0.35 } });

  expect(() =>
    settings({
      tiers: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({
            // biome-ignore lint/suspicious/noThenProperty: a thenable that is no Promise is the case
            then: later.then.bind(later),
            catch: later.catch.bind(later),
            finally: later.finally.bind(later),
            [Symbol.toStringTag]: 'Thenable',
          }),
        },
      },
    }),
  ).toThrow(
    'The settings group "tiers" validates asynchronously, so it cannot be checked at load',
  );
});
