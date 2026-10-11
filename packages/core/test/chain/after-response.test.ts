import { expect, jest, spyOn, test } from 'bun:test';
import type { AnyMotty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { contractOf } from '../../src/chain/run.ts';
import type { EventStream, Host, RequestRecord } from '../../src/contract.ts';
import { TimedOut, UpstreamFailed } from '../../src/data/errors.ts';
import type { ChatRequest } from '../../src/data/message.ts';
import { answer } from '../../src/request/answer.ts';
import { hosted } from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { stubHost } from '../stub-host.ts';

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

async function told(served: AnyMotty, host: Host = stubHost()) {
  const seen = [];
  for await (const event of contractOf(served).run(ask(), host)) {
    seen.push(event);
  }
  return seen;
}

async function* silent(signal: AbortSignal): EventStream {
  await new Promise((resolve) => signal.addEventListener('abort', resolve));
  yield { type: 'error', error: { code: 'aborted', message: 'Stopped' } };
}

test('a failed afterResponse hook is in the record with its part and the error as facts', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const audit = motty({ name: 'audit' }).afterResponse(() => {
    throw new UpstreamFailed('The audit log is down');
  });

  await told(
    motty({ name: 'coder' })
      .use(audit)
      .handle(() => answer('Hi')),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [
      {
        part: 'audit',
        error: {
          code: 'upstream_failed',
          status: 502,
          message: 'The audit log is down',
          retryable: true,
        },
      },
    ],
    skipped: [],
    unreached: [],
  });
});

test('a late failure that is no MottyError is recorded whole, with its message and stack', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async () => {
        throw new TypeError('db password leaked here');
      }),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse.failed).toStrictEqual([
    {
      part: 'coder',
      error: {
        code: 'internal',
        status: 500,
        message: 'db password leaked here',
        retryable: false,
        unexpected: true,
        stack: expect.stringContaining('TypeError: db password leaked here'),
      },
    },
  ]);
});

test('a failed afterResponse hook changes nothing in the stream or the outcome, and the next one runs', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const ran: string[] = [];

  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        throw new UpstreamFailed('The audit log is down');
      })
      .afterResponse(() => {
        ran.push('second');
      }),
    stubHost({}, { record: over.resolve }),
  );

  expect(seen).toEqual([
    { type: 'text', text: 'Hi' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
  expect((await over.promise).outcome).toBe('completed');
  expect(ran).toEqual(['second']);
});

test('a failed afterResponse hook stops nothing for a host that takes no record', async () => {
  const done = Promise.withResolvers<void>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        throw new UpstreamFailed('The audit log is down');
      })
      .afterResponse(() => {
        done.resolve();
      }),
  );

  expect(await done.promise).toBeUndefined();
});

test('afterResponse work does not follow the stop signal', async () => {
  const stop = new AbortController();
  const done = Promise.withResolvers<unknown[]>();

  await told(
    motty({ name: 'coder' })
      .handle(() => {
        stop.abort();
        return answer('Hi');
      })
      .afterResponse(async ({ outcome, signal, prompt }) => {
        const late = await model('acme/small').complete(prompt);
        done.resolve([outcome, signal.aborted, await late.text()]);
      }),
    stubHost(
      {
        'acme/small': [
          { type: 'text', text: 'Remembered' },
          { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
        ],
      },
      { signal: stop.signal },
    ),
  );

  expect(await done.promise).toEqual(['aborted', false, 'Remembered']);
});

test('an afterResponse hook that never returns is given up at limits.afterResponseMs and recorded as timed out', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const fired: boolean[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(({ signal }) => {
        signal.addEventListener('abort', () => fired.push(signal.aborted));
        return new Promise(() => {});
      }),
    stubHost({}, { limits: { afterResponseMs: 5 }, record: over.resolve }),
  );

  expect((await over.promise).afterResponse.failed).toStrictEqual([
    {
      part: 'coder',
      error: {
        code: 'timed_out',
        status: 504,
        message: 'After-response work passed its time limit',
        retryable: true,
      },
    },
  ]);
  expect(fired).toEqual([true]);
});

test('no afterResponse hook starts once the limit has passed, and each is recorded as skipped', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const ran: string[] = [];
  const audit = motty({ name: 'audit' }).afterResponse(() => {
    ran.push('audit');
  });

  await told(
    motty({ name: 'coder' })
      .afterResponse(() => Bun.sleep(20))
      .use(audit)
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        ran.push('last');
      }),
    stubHost({}, { limits: { afterResponseMs: 5 }, record: over.resolve }),
  );
  const { afterResponse } = await over.promise;
  await Bun.sleep(25);

  expect(ran).toEqual([]);
  expect(afterResponse.failed.map((failure) => failure.part)).toEqual([
    'coder',
  ]);
  expect(afterResponse.skipped).toEqual(['audit', 'coder']);
});

test('a model call made in afterResponse is cancelled at the limit and fails with it, whatever its host answers to the stop', async () => {
  const caught = Promise.withResolvers<unknown>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async ({ prompt }) => {
        await model('acme/slow').complete(prompt).catch(caught.resolve);
      }),
    {
      ...stubHost({}, { limits: { afterResponseMs: 5 } }),
      models: (_model, _prompt, signal) => silent(signal),
    },
  );

  expect(await caught.promise).toBeInstanceOf(TimedOut);
});

test('no afterResponse hook starts after one that blocked past the limit', async () => {
  const ran: string[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        const until = performance.now() + 20;
        while (performance.now() < until);
        ran.push('first');
      })
      .afterResponse(() => {
        ran.push('second');
      }),
    stubHost({}, { limits: { afterResponseMs: 5 } }),
  );
  await Bun.sleep(30);

  expect(ran).toEqual(['first']);
});

test('with limits.afterResponseMs of zero no afterResponse hook starts and none is recorded as failed', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const ran: string[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        ran.push('response');
      }),
    stubHost({}, { limits: { afterResponseMs: 0 }, record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: ['coder'],
    unreached: [],
  });
  expect(ran).toEqual([]);
});

test('a hook after an early answer that had every value made for it runs and is not recorded as skipped', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const ran: string[] = [];

  await told(
    motty({ name: 'coder' })
      .beforeHandle(() => answer('Cached'))
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        ran.push('late');
      }),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: [],
  });
  expect(ran).toEqual(['late']);
});

test('an afterResponse hook that ends by itself when its signal fires is not recorded as failed', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async ({ signal }) => {
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve),
        );
      }),
    stubHost({}, { limits: { afterResponseMs: 5 }, record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: [],
  });
});

test('an afterResponse hook that throws its own error when its signal fires is recorded with that error', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async ({ signal }) => {
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve),
        );
        throw new UpstreamFailed('The tier store gave up half way');
      }),
    stubHost({}, { limits: { afterResponseMs: 5 }, record: over.resolve }),
  );

  expect(
    (await over.promise).afterResponse.failed.map(({ error }) => error.code),
  ).toEqual(['upstream_failed']);
});

test('with no limit from the host, an afterResponse hook that never returns is given up after thirty seconds', async () => {
  jest.useFakeTimers();
  const records: RequestRecord[] = [];

  try {
    await told(
      motty({ name: 'coder' })
        .handle(() => answer('Hi'))
        .afterResponse(() => new Promise(() => {})),
      stubHost(
        {},
        {
          record: (record) => {
            records.push(record);
          },
        },
      ),
    );
    // Fake timers leave setImmediate real, so this lets what is due run.
    await new Promise((resolve) => setImmediate(resolve));
    jest.advanceTimersByTime(29_999);
    await new Promise((resolve) => setImmediate(resolve));
    const before = records.length;
    jest.advanceTimersByTime(1);
    jest.runOnlyPendingTimers();
    await new Promise((resolve) => setImmediate(resolve));

    expect(before).toBe(0);
    expect(
      records.map(({ afterResponse }) =>
        afterResponse.failed.map(({ error }) => error.code),
      ),
    ).toEqual([['timed_out']]);
  } finally {
    jest.useRealTimers();
  }
});

test('a host limit replaces the thirty seconds', async () => {
  const timers = spyOn(globalThis, 'setTimeout');
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {}),
    stubHost({}, { limits: { afterResponseMs: 45_000 }, record: over.resolve }),
  );
  await over.promise;
  const delays = timers.mock.calls.map(([, delay]) => delay);
  timers.mockRestore();

  expect(delays).toEqual([45_000]);
});

test('the time limit is dropped once the hooks are done, so nothing fires later', async () => {
  const cleared = spyOn(globalThis, 'clearTimeout');
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {}),
    stubHost({}, { record: over.resolve }),
  );
  await over.promise;
  const dropped = cleared.mock.calls.length;
  cleared.mockRestore();

  expect(dropped).toBe(1);
});

test('the signal of after-response work fires when its hooks are done', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const kept: AbortSignal[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(({ signal }) => {
        kept.push(signal);
      }),
    stubHost({}, { record: over.resolve }),
  );
  await over.promise;

  expect(kept.map((signal) => signal.aborted)).toEqual([true]);
});

test('a call still open when after-response work is done is cancelled and settled before the record', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const reasons: unknown[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(({ prompt }) => {
        model('acme/slow').complete(prompt);
      }),
    {
      ...stubHost({}, { record: over.resolve }),
      models: (_model, _prompt, signal) => {
        signal.addEventListener('abort', () => reasons.push(signal.reason));
        return silent(signal);
      },
    },
  );

  expect((await over.promise).calls).toStrictEqual([
    {
      model: 'acme/slow',
      latencyMs: expect.any(Number),
      code: 'aborted',
      message: 'The call was given up',
    },
  ]);
  expect(reasons).toHaveLength(1);
});

test('a host function that never answers in after-response work is given up at the limit', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async () => {
        await hosted().storage?.set('tier', 'deep');
      }),
    stubHost(
      {},
      {
        limits: { afterResponseMs: 5 },
        record: over.resolve,
        storage: {
          get: () => new Promise(() => {}),
          set: () => new Promise(() => {}),
          delete: () => new Promise(() => {}),
        },
      },
    ),
  );

  expect(
    (await over.promise).afterResponse.failed.map(({ error }) => error.code),
  ).toEqual(['timed_out']);
});

test('storage works in after-response work after the caller left', async () => {
  const stop = new AbortController();
  const over = Promise.withResolvers<RequestRecord>();
  const kept = new Map<string, unknown>();

  await told(
    motty({ name: 'coder' })
      .handle(() => {
        stop.abort();
        return answer('Hi');
      })
      .afterResponse(async ({ outcome }) => {
        await hosted().storage?.set('last', outcome);
      }),
    stubHost(
      {},
      {
        signal: stop.signal,
        record: over.resolve,
        storage: {
          get: async () => undefined,
          set: async (key, value) => {
            await Bun.sleep(1);
            kept.set(key, value);
          },
          delete: async () => {},
        },
      },
    ),
  );
  await over.promise;

  expect([...kept]).toEqual([['last', 'aborted']]);
});

test.each([
  [
    'an error whose message throws when it is read',
    () =>
      Object.defineProperty(new Error('Hidden'), 'message', {
        get: () => {
          throw new Error('No message for you');
        },
      }),
  ],
  [
    'a value that throws on any read',
    () =>
      new Proxy(
        {},
        {
          get: () => {
            throw new Error('No read for you');
          },
          has: () => {
            throw new Error('No look for you');
          },
          getPrototypeOf: () => {
            throw new Error('No kind for you');
          },
        },
      ),
  ],
])(
  'an afterResponse hook that throws %s is recorded as an internal failure, and the record still arrives once',
  async (_what, thrown) => {
    const unhandled: unknown[] = [];
    const noted = (reason: unknown) => {
      unhandled.push(reason);
    };
    const records: RequestRecord[] = [];
    process.on('unhandledRejection', noted);

    try {
      const events = await told(
        motty({ name: 'coder' })
          .handle(() => answer('Hi'))
          .afterResponse(() => {
            throw thrown();
          }),
        stubHost(
          {},
          {
            record: (record) => {
              records.push(record);
            },
          },
        ),
      );
      await Bun.sleep(5);

      expect(events.map((event) => event.type)).toEqual(['text', 'finish']);
      expect(
        records.map(({ outcome, afterResponse }) => ({
          outcome,
          failed: afterResponse.failed,
        })),
      ).toEqual([
        {
          outcome: 'completed',
          failed: [
            {
              part: 'coder',
              error: {
                code: 'internal',
                status: 500,
                message: 'Internal error',
                retryable: false,
                unexpected: true,
              },
            },
          ],
        },
      ]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', noted);
    }
  },
  1_000,
);
