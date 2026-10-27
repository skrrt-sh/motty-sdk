import { expect, spyOn, test } from 'bun:test';
import type { AnyMotty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { reroute } from '../../src/chain/route.ts';
import { contractOf } from '../../src/chain/run.ts';
import type { Host, RequestRecord } from '../../src/contract.ts';
import { UpstreamFailed } from '../../src/data/errors.ts';
import type { StreamEvent } from '../../src/data/event.ts';
import type { ChatRequest } from '../../src/data/message.ts';
import { answer, buffered } from '../../src/request/answer.ts';
import { model } from '../../src/request/model.ts';
import { fallback } from '../../src/request/switching.ts';
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

function says(text: string, input: number, output: number): StreamEvent[] {
  return [
    { type: 'text', text },
    { type: 'finish', reason: 'stop', usage: { input, output } },
  ];
}

async function told(served: AnyMotty, host: Host = stubHost()) {
  const seen = [];
  for await (const event of contractOf(served).run(ask(), host)) {
    seen.push(event);
  }
  return seen;
}

test('a completed request is recorded with its path, entries, calls, usage and times', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const deep = motty({ name: 'deep' }).route(() => 'plan', {
    plan: async ({ prompt }) => {
      await model('acme/small').complete(prompt);
      return reroute('write');
    },
    write: ({ prompt }) => model('acme/large').complete(prompt),
  });

  await told(
    motty({ name: 'coder' }).route(() => 'quick', {
      quick: () => reroute('deep'),
      deep,
    }),
    stubHost(
      {
        'acme/small': says('Plan', 3, 2),
        'acme/large': [
          { type: 'text', text: 'Done' },
          { type: 'finish', reason: 'stop', usage: { input: 7, cached: 0 } },
        ],
      },
      { record: over.resolve },
    ),
  );

  expect(await over.promise).toStrictEqual({
    outcome: 'completed',
    path: ['deep', 'write'],
    entries: ['quick', 'deep', 'plan', 'write'],
    calls: [
      {
        model: 'acme/small',
        time: { total: expect.any(Number), firstEvent: expect.any(Number) },
        input: 3,
        output: 2,
      },
      {
        model: 'acme/large',
        time: { total: expect.any(Number), firstEvent: expect.any(Number) },
        input: 7,
        cached: 0,
      },
    ],
    usage: { input: 10, output: 2, cached: 0 },
    time: { answer: expect.any(Number), total: expect.any(Number) },
    afterResponse: { failed: [], skipped: [], unreached: [] },
  });
});

test('the record arrives once, after the after-response work has finished', async () => {
  const order: string[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async () => {
        await Bun.sleep(5);
        order.push('hook');
      }),
    stubHost(
      {},
      {
        record: ({ outcome }) => {
          order.push(outcome);
        },
      },
    ),
  );
  await Bun.sleep(15);

  expect(order).toEqual(['hook', 'completed']);
});

test('the record holds the calls made in after-response work and the time it took', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/small').complete(prompt))
      .afterResponse(async ({ prompt }) => {
        await Bun.sleep(10);
        await model('acme/small').complete(prompt);
      }),
    stubHost({ 'acme/small': says('Hi', 4, 1) }, { record: over.resolve }),
  );
  const { calls, usage, time } = await over.promise;

  expect(calls.map((call) => call.model)).toEqual(['acme/small', 'acme/small']);
  expect(usage).toStrictEqual({ input: 8, output: 2 });
  expect(time.answer).toBeGreaterThan(0);
  expect(time.total - time.answer).toBeGreaterThan(8);
});

test('a failed request is recorded with the whole error as facts and the part that threw, and the caller is told it in the same words', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const tiers = motty({ name: 'tiers' }).derive(() => {
    throw new UpstreamFailed('The tier store is down');
  });

  const seen = await told(
    motty({ name: 'coder' }).route(() => 'deep', {
      deep: motty({ name: 'deep' })
        .use(tiers)
        .handle(() => answer('Hi')),
    }),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, error, part, path, entries } = await over.promise;

  expect({ outcome, part, path, entries }).toStrictEqual({
    outcome: 'failed',
    part: 'tiers',
    path: [],
    entries: ['deep'],
  });
  expect(error).toStrictEqual({
    code: 'upstream_failed',
    status: 502,
    message: 'The tier store is down',
    retryable: true,
  });
  expect(
    seen.map((event) => (event.type === 'error' ? event.error : undefined)),
  ).toEqual([
    {
      code: 'upstream_failed',
      status: 502,
      message: 'The tier store is down',
      retryable: true,
    },
  ]);
});

test('a part that answered early is named in the record', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const cache = motty({ name: 'cache' }).beforeHandle(() => answer('Cached'));

  await told(
    motty({ name: 'coder' })
      .use(cache)
      .handle(() => answer('Hi')),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, part } = await over.promise;

  expect({ outcome, part }).toStrictEqual({
    outcome: 'completed',
    part: 'cache',
  });
});

test('a throw a boundary recovered counts as an early answer from the step that threw', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const tiers = motty({ name: 'tiers' }).derive(() => {
    throw new UpstreamFailed('The tier store is down');
  });

  await told(
    motty({ name: 'coder' })
      .use(tiers)
      .handle(() => answer('Hi'))
      .onError(() => answer('Try again in a minute')),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, part } = await over.promise;

  expect({ outcome, part }).toStrictEqual({
    outcome: 'completed',
    part: 'tiers',
  });
});

test('an answer a boundary gave for a thrown afterHandle is recorded with no path below the motty whose hook threw, and the entry that ran stays in the entries', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const deep = motty({ name: 'deep' })
    .route(() => 'plan', { plan: () => answer('From the plan') })
    .afterHandle(() => {
      throw new UpstreamFailed('The rule check is down');
    })
    .onError(() => answer('Withheld'));

  await told(
    motty({ name: 'coder' }).route(() => 'deep', { deep }),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, path, entries } = await over.promise;

  expect({ outcome, path, entries }).toStrictEqual({
    outcome: 'completed',
    path: ['deep'],
    entries: ['deep', 'plan'],
  });
});

test('an answer that ended in an error is recorded as failed with that error and no part', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' }).handle(() =>
      buffered(
        (async function* (): AsyncGenerator<StreamEvent> {
          yield { type: 'text', text: 'The lock' };
          yield {
            type: 'error',
            error: { code: 'overloaded', status: 503, message: 'Busy' },
          };
        })(),
      ),
    ),
    stubHost({}, { record: over.resolve }),
  );
  const made = await over.promise;

  expect(made.outcome).toBe('failed');
  expect(made.error?.code).toBe('overloaded');
  expect(Object.hasOwn(made, 'part')).toBe(false);
});

test('a stopped request is recorded as aborted with the error the stream gave', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const stop = new AbortController();

  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => stop.abort())
      .handle(() => answer('Hi')),
    stubHost({}, { signal: stop.signal, record: over.resolve }),
  );
  const made = await over.promise;

  expect(made.outcome).toBe('aborted');
  expect(made.error).toStrictEqual({
    code: 'aborted',
    status: 499,
    message: 'The work was stopped',
    retryable: false,
  });
  expect(Object.hasOwn(made, 'part')).toBe(false);
  expect(
    seen.map((event) => (event.type === 'error' ? event.error : undefined)),
  ).toEqual([made.error]);
});

test('the record survives a JSON round trip', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' })
      .route(() => 'deep', {
        deep: async ({ prompt }) => {
          await model('acme/small').complete(prompt);
          throw new UpstreamFailed('Every model is down');
        },
      })
      .afterResponse(() => {
        throw new UpstreamFailed('The audit log is down');
      })
      .afterResponse(() => {}),
    stubHost(
      { 'acme/small': says('Hi', 4, 1) },
      { limits: { afterResponse: 1_000 }, record: over.resolve },
    ),
  );
  const made = await over.promise;

  expect(made.outcome).toBe('failed');
  expect(made.part).toBe('coder');
  expect(made.calls).toHaveLength(1);
  expect(made.afterResponse.failed).toHaveLength(1);
  expect(JSON.parse(JSON.stringify(made))).toStrictEqual(made);
});

test('a host whose record throws or rejects raises nothing', async () => {
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', note);

  await told(
    motty({ name: 'coder' }).handle(() => answer('Hi')),
    stubHost(
      {},
      {
        record: () => {
          throw new Error('The report sink is down');
        },
      },
    ),
  );
  await told(
    motty({ name: 'coder' }).handle(() => answer('Hi')),
    stubHost(
      {},
      {
        record: async () => {
          throw new Error('The report sink is down');
        },
      },
    ),
  );
  await Bun.sleep(5);
  process.off('unhandledRejection', note);

  expect(unhandled).toEqual([]);
});

test('a call still open when the answer has been sent is cancelled, and what it reports is in the usage the caller is told and in the record alike', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const reasons: unknown[] = [];
  const host = stubHost(
    { 'acme/small': says('Plan', 3, 2) },
    { record: over.resolve },
  );

  const seen = await told(
    motty({ name: 'coder' }).handle(async ({ prompt }) => {
      await model('acme/large').complete(prompt);
      await (await model('acme/small').complete(prompt)).finish();
      return answer('Hi');
    }),
    {
      ...host,
      models: async function* (name, prompt, signal) {
        if (name !== 'acme/large')
          return yield* host.models(name, prompt, signal);
        yield { type: 'text', text: 'Half' };
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve),
        );
        reasons.push(signal.reason);
        yield {
          type: 'error',
          error: { code: 'aborted', status: 499, message: 'Cancelled' },
          usage: { input: 40, output: 1 },
        };
      },
    },
  );
  const { calls, usage } = await over.promise;

  expect(calls).toStrictEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      input: 3,
      output: 2,
    },
    {
      model: 'acme/large',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      input: 40,
      output: 1,
      code: 'aborted',
      message: 'The call was given up',
    },
  ]);
  expect(usage).toStrictEqual({ input: 43, output: 3 });
  expect(seen.at(-1)).toEqual({
    type: 'finish',
    reason: 'stop',
    usage: { input: 43, output: 3 },
  });
  expect(reasons).toHaveLength(1);
});

test('a call a fallback moved past is recorded with the message of its failure beside its code, for the motty and the host alike', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const read: unknown[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) =>
        fallback(model('acme/strict'), model('acme/small')).complete(prompt),
      )
      .afterResponse(({ calls }) => {
        read.push(...calls.made);
      }),
    stubHost(
      {
        'acme/strict': [
          {
            type: 'error',
            error: {
              code: 'unsupported',
              status: 400,
              message: 'This API takes no previous_response_id',
            },
          },
        ],
        'acme/small': says('Hi', 3, 2),
      },
      { record: over.resolve },
    ),
  );
  const { outcome, error, calls } = await over.promise;

  expect([outcome, error]).toEqual(['completed', undefined]);
  expect(calls).toStrictEqual([
    {
      model: 'acme/strict',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'unsupported',
      message: 'This API takes no previous_response_id',
    },
    {
      model: 'acme/small',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      input: 3,
      output: 2,
    },
  ]);
  expect(read).toStrictEqual(calls);
});

test('an early answer the caller did not get names no part', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const cache = motty({ name: 'cache' })
    .afterHandle(() => {
      throw new UpstreamFailed('The cache is down');
    })
    .beforeHandle(() => answer('Cached'))
    .handle(() => answer('Fresh'));

  await told(
    motty({ name: 'coder' }).route(() => 'cache', {
      cache: cache.catch(() => reroute('quick')),
      quick: () => answer('Hi'),
    }),
    stubHost({}, { record: over.resolve }),
  );
  const made = await over.promise;

  expect(made.outcome).toBe('completed');
  expect(made.path).toEqual(['quick']);
  expect(Object.hasOwn(made, 'part')).toBe(false);
});

test('a part that threw undefined is still named', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const tiers = motty({ name: 'tiers' }).derive(() => {
    throw undefined;
  });

  await told(
    motty({ name: 'coder' })
      .use(tiers)
      .handle(() => answer('Hi')),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, part } = await over.promise;

  expect({ outcome, part }).toStrictEqual({ outcome: 'failed', part: 'tiers' });
});

test('one error thrown again after a boundary recovered it names the part that threw last', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const down = new UpstreamFailed('The tier store is down');
  const audit = motty({ name: 'audit' }).afterHandle(() => {
    throw down;
  });
  const tiers = motty({ name: 'tiers' })
    .route(() => 'deep', {
      deep: motty({ name: 'deep' }).handle(() => {
        throw down;
      }),
    })
    .onError(() => answer('Try again in a minute'));

  await told(
    motty({ name: 'coder' })
      .use(audit)
      .route(() => 'tiers', { tiers }),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, part } = await over.promise;

  expect({ outcome, part }).toStrictEqual({ outcome: 'failed', part: 'audit' });
});

test('one error thrown again after a route entry recovered it names the part that threw last', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const down = new UpstreamFailed('Every model is down');
  const deep = motty({ name: 'deep' }).handle(() => {
    throw down;
  });

  await told(
    motty({ name: 'coder' }).route(() => 'deep', {
      deep: deep.catch(() => reroute('quick')),
      quick: () => {
        throw down;
      },
    }),
    stubHost({}, { record: over.resolve }),
  );
  const { outcome, part } = await over.promise;

  expect({ outcome, part }).toStrictEqual({ outcome: 'failed', part: 'coder' });
});

test('a request without a record function reads no clock for one', async () => {
  const served = motty({ name: 'coder' }).handle(() => answer('Hi'));
  const clock = spyOn(performance, 'now');

  await told(served);
  const without = clock.mock.calls.length;
  await told(served, stubHost({}, { record: () => {} }));
  const recording = clock.mock.calls.length - without;
  clock.mockRestore();

  expect(without).toBe(0);
  expect(recording).toBeGreaterThan(0);
});
