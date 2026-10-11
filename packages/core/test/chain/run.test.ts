import { expect, spyOn, test } from 'bun:test';
import { version as sdk } from '../../package.json';
import type { AnyMotty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { reroute } from '../../src/chain/route.ts';
import { contractOf } from '../../src/chain/run.ts';
import type { EventStream, Host, RequestRecord } from '../../src/contract.ts';
import {
  Aborted,
  Blocked,
  InvalidRequest,
  LimitReached,
  MottyError,
  TimedOut,
  UpstreamFailed,
} from '../../src/data/errors.ts';
import type { Chunk, StreamEvent } from '../../src/data/event.ts';
import type { ChatRequest } from '../../src/data/message.ts';
import { answer } from '../../src/request/answer.ts';
import { current } from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { think } from '../../src/request/think.ts';
import { stubHost } from '../stub-host.ts';

function ask(headers = new Headers()): ChatRequest {
  return {
    id: 'req_1',
    model: 'motty/coder',
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers,
  };
}

function says(text: string): StreamEvent[] {
  return [
    { type: 'text', text },
    { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
  ];
}

async function told(
  served: AnyMotty,
  host: Host = stubHost(),
  request = ask(),
) {
  const seen = [];
  for await (const event of contractOf(served).run(request, host)) {
    seen.push(event);
  }
  return seen;
}

function text(events: Awaited<ReturnType<typeof told>>) {
  return events
    .flatMap((event) => (event.type === 'text' ? [event.text] : []))
    .join('');
}

function logging(order: string[]) {
  return motty({ name: 'logger' }).afterResponse(({ outcome }) => {
    order.push(`logger response ${outcome}`);
  });
}

async function* silent(signal: AbortSignal): EventStream {
  await new Promise((resolve) => signal.addEventListener('abort', resolve));
  yield { type: 'error', error: { code: 'aborted', message: 'Stopped' } };
}

class EmptyPrompt extends MottyError.define('empty_prompt', 400) {}

test('a handle answers the request with its chunks and one finish', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => answer('The lock order differs')),
  );

  expect(seen).toEqual([
    { type: 'text', text: 'The lock order differs' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
});

test('the contract of a motty is made once', () => {
  const served = motty({ name: 'coder' }).handle(() => answer('Hi'));

  expect(contractOf(served)).toBe(contractOf(served));
});

test('a motty grown from another has a contract of its own', () => {
  const served = motty({ name: 'coder' }).handle(() => answer('Hi'));

  expect(contractOf(served.afterHandle(() => {}))).not.toBe(contractOf(served));
});

test('the contract carries the version and the description', () => {
  const tenant = motty({ name: 'tenant' }).derive(() => ({ tenant: 'acme' }));

  const { version, description } = contractOf(
    motty({ name: 'coder' })
      .use(tenant)
      .handle(() => answer('Hi')),
  );

  expect(version).toBe(1);
  expect(description).toEqual({ sdk, name: 'coder', plugins: ['tenant'] });
});

test('a derived value is on the context of every hook after it', async () => {
  const seen: string[] = [];

  await told(
    motty({ name: 'coder' })
      .derive(async () => ({ tenant: 'acme' }))
      .derive(({ tenant }) => ({ greeting: `Hello ${tenant}` }))
      .beforeHandle(({ tenant }) => {
        seen.push(tenant);
      })
      .handle(({ greeting }) => answer(greeting))
      .afterHandle(({ tenant, greeting }) => {
        seen.push(tenant, greeting);
      }),
  );

  expect(seen).toEqual(['acme', 'acme', 'Hello acme']);
});

test('hooks run in the order they were registered, a part at its use', async () => {
  const order: string[] = [];
  const part = motty({ name: 'part' })
    .derive(() => {
      order.push('part derive');
      return {};
    })
    .beforeHandle(() => {
      order.push('part before');
    })
    .afterHandle(() => {
      order.push('part after');
    });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {
        order.push('first');
      })
      .use(part)
      .beforeHandle(() => {
        order.push('last');
      })
      .handle(() => {
        order.push('handle');
        return answer('Hi');
      })
      .afterHandle(() => {
        order.push('after');
      }),
  );

  expect(order).toEqual([
    'first',
    'part derive',
    'part before',
    'last',
    'handle',
    'part after',
    'after',
  ]);
});

test('a route brought by a used part answers', async () => {
  const tiers = motty({ name: 'tiers' }).route(() => 'quick', {
    quick: () => answer('From the quick tier'),
  });

  const seen = await told(motty({ name: 'coder' }).use(tiers));

  expect(text(seen)).toBe('From the quick tier');
});

test('a beforeHandle that returns nothing lets the request go on', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {})
      .handle(() => answer('From the handler')),
  );

  expect(text(seen)).toBe('From the handler');
});

test('a beforeHandle that returns an answer replies at once', async () => {
  const ran: string[] = [];

  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => answer('I only answer questions about software'))
      .beforeHandle(() => {
        ran.push('later hook');
      })
      .handle(() => {
        ran.push('handle');
        return answer('From the handler');
      }),
  );

  expect(text(seen)).toBe('I only answer questions about software');
  expect(ran).toEqual([]);
});

test('a prompt changed in beforeHandle is what goes upstream', async () => {
  const host = stubHost({ 'acme/small': says('Done') });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(({ prompt }) => {
        prompt.messages = [{ role: 'user', text: 'Compacted' }];
      })
      .handle(({ prompt }) => model('acme/small').complete(prompt)),
    host,
  );

  expect(host.sent('acme/small')[0]?.messages).toEqual([
    { role: 'user', text: 'Compacted' },
  ]);
});

test('the request stays as the caller sent it when the prompt changes', async () => {
  const request = ask();

  await told(
    motty({ name: 'coder' })
      .beforeHandle(({ prompt }) => {
        prompt.messages.push({ role: 'user', text: 'One more thing' });
        prompt.options = { temperature: 0 };
      })
      .handle(() => answer('Hi')),
    stubHost(),
    request,
  );

  expect(request.messages).toEqual([
    { role: 'user', text: 'Why does this deadlock?' },
  ]);
  expect(request.options).toEqual({});
});

test('the prompt starts as the request: messages, tools, options and output', async () => {
  const host = stubHost({ 'acme/small': says('{}') });

  await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    ),
    host,
    {
      ...ask(),
      tools: [{ type: 'function', name: 'search', input: {} }],
      options: { temperature: 0, provider: { openai: { store: false } } },
      output: { name: 'verdict', strict: true },
    },
  );

  expect(host.sent('acme/small')[0]).toEqual({
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [{ type: 'function', name: 'search', input: {} }],
    options: { temperature: 0, provider: { openai: { store: false } } },
    output: { name: 'verdict', strict: true },
  });
});

test('a beforeHandle that throws rejects the request with its error', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {
        throw new EmptyPrompt('The prompt has no text');
      })
      .handle(() => answer('From the handler')),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'empty_prompt',
        status: 400,
        message: 'The prompt has no text',
        retryable: false,
      },
      usage: {},
    },
  ]);
});

test('every header the caller sent is on the request', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(({ request }) =>
      answer(request.headers.get('x-team') ?? 'none'),
    ),
    stubHost(),
    ask(new Headers({ 'x-team': 'storage' })),
  );

  expect(text(seen)).toBe('storage');
});

test('a motty answers to whatever model name was asked for', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(({ request }) => answer(request.model)),
    stubHost(),
    { ...ask(), model: 'gpt-anything' },
  );

  expect(text(seen)).toBe('gpt-anything');
});

test('calls are on the context from the start and grow with each call', async () => {
  const counts: number[] = [];

  await told(
    motty({ name: 'coder' })
      .beforeHandle(({ calls }) => {
        counts.push(calls.made.length);
      })
      .handle(({ prompt }) => model('acme/small').complete(prompt))
      .afterHandle(async ({ calls, answer }) => {
        await answer.finish();
        counts.push(calls.made.length);
      }),
    stubHost({ 'acme/small': says('Done') }),
  );

  expect(counts).toEqual([0, 1]);
});

test('afterHandle reads the answer and may assign another', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => answer('secret plan'))
      .afterHandle(async (context) => {
        context.answer = answer(`${await context.answer.text()}, redacted`);
      }),
  );

  expect(text(seen)).toBe('secret plan, redacted');
});

test('an afterHandle sees the answer the one before it assigned', async () => {
  const seen: string[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => answer('First'))
      .afterHandle((context) => {
        context.answer = answer('Second');
      })
      .afterHandle(async (context) => {
        seen.push(await context.answer.text());
      }),
  );

  expect(seen).toEqual(['Second']);
});

test('afterHandle does not run when there is no answer', async () => {
  const ran: string[] = [];

  await told(
    motty({ name: 'coder' })
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      })
      .afterHandle(() => {
        ran.push('after');
      }),
  );

  expect(ran).toEqual([]);
});

test('a motty with no route or handle fails as an internal error', async () => {
  const seen = await told(motty({ name: 'coder' }).beforeHandle(() => {}));

  expect(seen).toMatchObject([
    { type: 'error', error: { code: 'internal', message: 'Internal error' } },
  ]);
});

test('an early answer skips the steps registered after it, runs the after hooks before it and every afterResponse', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const audit = motty({ name: 'audit' })
    .afterHandle(() => {
      order.push('audit after');
    })
    .afterResponse(() => {
      order.push('audit response');
    });

  const seen = await told(
    motty({ name: 'coder' })
      .use(audit)
      .beforeHandle(() => answer('Cached'))
      .handle(() => {
        order.push('handle');
        return answer('From the handler');
      })
      .afterHandle(() => {
        order.push('late after');
      })
      .afterResponse(() => {
        order.push('late response');
        done.resolve();
      }),
  );
  await done.promise;

  expect(text(seen)).toBe('Cached');
  expect(order).toEqual(['audit after', 'audit response', 'late response']);
});

test('afterResponse runs only once the caller has the whole answer', async () => {
  const ran: string[] = [];
  const reader = contractOf(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        ran.push('response');
      }),
  )
    .run(ask(), stubHost())
    [Symbol.asyncIterator]();

  await reader.next();
  await Bun.sleep(1);
  expect(ran).toEqual([]);
  expect((await reader.next()).value?.type).toBe('finish');
  await Bun.sleep(1);
  expect(ran).toEqual(['response']);
});

test('afterResponse sees completed with the route, the path and the answer', async () => {
  const done = Promise.withResolvers<unknown[]>();

  await told(
    motty({ name: 'coder' })
      .route(() => 'chat', { chat: () => answer('Hi') })
      .afterResponse(async (context) => {
        if (context.outcome !== 'completed') return;
        const { outcome, route, path, answer } = context;
        done.resolve([outcome, route, path, await answer.text()]);
      }),
  );

  expect(await done.promise).toEqual(['completed', 'chat', ['chat'], 'Hi']);
});

test('afterResponse sees every call the request made', async () => {
  const done = Promise.withResolvers<unknown>();

  await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/small').complete(prompt))
      .afterResponse(({ calls }) => {
        done.resolve([calls.made.map((call) => call.model), calls.total]);
      }),
    stubHost({ 'acme/small': says('Done') }),
  );

  expect(await done.promise).toEqual([['acme/small'], { input: 1, output: 1 }]);
});

test('afterResponse sees failed when an error reached the last boundary', async () => {
  const done = Promise.withResolvers<unknown[]>();

  await told(
    motty({ name: 'coder' })
      .derive(() => ({ tenant: 'acme' }))
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      })
      .afterResponse((context) => {
        done.resolve([
          context.outcome,
          context.tenant,
          context.path,
          'answer' in context,
        ]);
      }),
  );

  expect(await done.promise).toEqual(['failed', 'acme', [], false]);
});

test('afterResponse sees failed when the answer ended in an error', async () => {
  const done = Promise.withResolvers<string>();

  await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/small').complete(prompt))
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      }),
    stubHost({
      'acme/small': [
        { type: 'text', text: 'The lock' },
        { type: 'error', error: { code: 'overloaded', message: 'Busy' } },
      ],
    }),
  );

  expect(await done.promise).toBe('failed');
});

test('afterResponse hooks run innermost first', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const leaf = motty({ name: 'leaf' })
    .handle(() => answer('From the leaf'))
    .afterResponse(() => {
      order.push('leaf');
    });
  const middle = motty({ name: 'middle' })
    .route(() => 'b', { b: leaf })
    .afterResponse(() => {
      order.push('middle');
    });

  await told(
    motty({ name: 'root' })
      .route(() => 'a', { a: middle })
      .afterResponse(() => {
        order.push('root');
        done.resolve();
      }),
  );
  await done.promise;

  expect(order).toEqual(['leaf', 'middle', 'root']);
});

test('a nested motty that failed sees failed while the request completed', async () => {
  const outcomes: string[] = [];
  const done = Promise.withResolvers<void>();
  const deep = motty({ name: 'deep' })
    .handle(() => {
      throw new UpstreamFailed('Both strong models are down');
    })
    .afterResponse(({ outcome }) => {
      outcomes.push(`deep ${outcome}`);
    });

  await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', {
        deep: deep.catch(() => reroute('standard')),
        standard: () => answer('From the standard tier'),
      })
      .afterResponse(({ outcome }) => {
        outcomes.push(`tiers ${outcome}`);
        done.resolve();
      }),
  );
  await done.promise;

  expect(outcomes).toEqual(['deep failed', 'tiers completed']);
});

test('the request is found by code that runs after the first event was read', async () => {
  const gate = Promise.withResolvers<void>();
  const done = Promise.withResolvers<unknown>();
  const host = stubHost(
    { 'acme/small': says('Hi') },
    { record: ({ afterResponse }) => done.reject(afterResponse.failed) },
  );
  const reader = contractOf(
    motty({ name: 'coder' })
      .beforeHandle(async () => {
        think('Reading the request');
        await gate.promise;
      })
      .handle(({ prompt }) => {
        think(`The host is ${current().host === host ? 'found' : 'lost'}`);
        return model('acme/small').complete(prompt);
      })
      .afterResponse(async ({ prompt }) => {
        const again = await model('acme/small').complete(prompt);
        done.resolve([current().host === host, await again.text()]);
      }),
  )
    .run(ask(), host)
    [Symbol.asyncIterator]();

  expect((await reader.next()).value).toEqual({
    type: 'progress',
    piece: 0,
    text: 'Reading the request',
  });
  gate.resolve();
  expect((await reader.next()).value).toEqual({
    type: 'progress',
    piece: 1,
    text: 'The host is found',
  });
  expect((await reader.next()).value).toEqual({ type: 'text', text: 'Hi' });
  expect((await reader.next()).value?.type).toBe('finish');
  expect(await done.promise).toEqual([true, 'Hi']);
});

test('two requests running at once each find their own host', async () => {
  const served = motty({ name: 'coder' }).handle(async ({ prompt }) => {
    await Bun.sleep(1);
    return model('acme/small').complete(prompt);
  });

  const [one, two] = await Promise.all([
    told(served, stubHost({ 'acme/small': says('For the first') })),
    told(served, stubHost({ 'acme/small': says('For the second') })),
  ]);

  expect([text(one), text(two)]).toEqual(['For the first', 'For the second']);
});

test('onError gets what was thrown and the context so far', async () => {
  const seen: unknown[] = [];

  await told(
    motty({ name: 'coder' })
      .derive(() => ({ tenant: 'acme' }))
      .handle(() => {
        throw new Blocked('Refused by the content policy');
      })
      .onError((thrown, { tenant, request }) => {
        seen.push(thrown, tenant, request.id);
      }),
  );

  expect(seen[0]).toBeInstanceOf(Blocked);
  expect(seen.slice(1)).toEqual(['acme', 'req_1']);
});

test('an answer returned by onError is the fallback the caller gets', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      })
      .onError(() => answer('Try again in a minute')),
  );

  expect(seen).toEqual([
    { type: 'text', text: 'Try again in a minute' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
});

test('the nearest boundary is asked first and the outer one not at all once it recovered', async () => {
  const asked: string[] = [];
  const guard = motty({ name: 'guard' })
    .beforeHandle(() => {
      throw new EmptyPrompt('The prompt has no text');
    })
    .onError(() => {
      asked.push('guard');
      return answer('Say something first');
    });

  const seen = await told(
    motty({ name: 'coder' })
      .use(guard)
      .handle(() => answer('From the handler'))
      .onError(() => {
        asked.push('coder');
      }),
  );

  expect(text(seen)).toBe('Say something first');
  expect(asked).toEqual(['guard']);
});

test('a boundary that returns nothing passes the same error to the next one up', async () => {
  const seen: unknown[] = [];
  const guard = motty({ name: 'guard' })
    .beforeHandle(() => {
      throw new EmptyPrompt('The prompt has no text');
    })
    .onError((thrown) => {
      seen.push(thrown);
    });

  await told(
    motty({ name: 'coder' })
      .use(guard)
      .handle(() => answer('From the handler'))
      .onError((thrown) => {
        seen.push(thrown);
        return answer('Say something first');
      }),
  );

  expect(seen[0]).toBeInstanceOf(EmptyPrompt);
  expect(seen[1]).toBe(seen[0]);
});

test('a boundary that throws passes what it threw to the next one up', async () => {
  const seen: unknown[] = [];
  const guard = motty({ name: 'guard' })
    .beforeHandle(() => {
      throw new EmptyPrompt('The prompt has no text');
    })
    .onError(() => {
      throw new Blocked('The fallback was refused');
    });

  await told(
    motty({ name: 'coder' })
      .use(guard)
      .handle(() => answer('From the handler'))
      .onError((thrown) => {
        seen.push(thrown);
      }),
  );

  expect(seen[0]).toBeInstanceOf(Blocked);
});

test('what the last boundary threw is what the caller is told', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      })
      .onError(() => {
        throw new EmptyPrompt('The prompt has no text');
      }),
  );

  expect(seen).toMatchObject([
    { error: { code: 'empty_prompt', status: 400 } },
  ]);
});

test("a part's boundary is not asked about a hook outside the part", async () => {
  const asked: string[] = [];
  const guard = motty({ name: 'guard' })
    .beforeHandle(() => {})
    .onError(() => {
      asked.push('guard');
    });

  await told(
    motty({ name: 'coder' })
      .use(guard)
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      }),
  );

  expect(asked).toEqual([]);
});

test('a server failure handled by no boundary goes out with its code, its status and its own message', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      })
      .onError(() => {}),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        status: 502,
        message: 'Every model is down',
        retryable: true,
      },
      usage: {},
    },
  ]);
});

test('a mistake of the caller handled by no boundary goes out with the message of the error itself', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => {
      throw new InvalidRequest('The prompt names a tool that is not there');
    }),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'invalid_request',
        status: 400,
        message: 'The prompt names a tool that is not there',
        retryable: false,
      },
      usage: {},
    },
  ]);
});

test('something thrown that is no MottyError goes out as an undetailed internal error', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => {
      throw new TypeError('db password leaked here');
    }),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'internal',
        status: 500,
        message: 'Internal error',
        retryable: false,
      },
      usage: {},
    },
  ]);
});

test('recovering a failed before hook answers at that hook and skips what follows it', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const audit = motty({ name: 'audit' })
    .afterHandle(() => {
      order.push('audit after');
    })
    .afterResponse(() => {
      order.push('audit response');
      done.resolve();
    });

  const seen = await told(
    motty({ name: 'coder' })
      .use(audit)
      .derive((): { tier: string } => {
        throw new UpstreamFailed('The tier store is down');
      })
      .handle(() => {
        order.push('handle');
        return answer('From the handler');
      })
      .afterHandle(() => {
        order.push('late after');
      })
      .afterResponse(() => {
        order.push('late response');
      })
      .onError(() => answer('Try again in a minute')),
  );
  await done.promise;
  await Bun.sleep(1);

  expect(text(seen)).toBe('Try again in a minute');
  expect(order).toEqual(['audit after', 'audit response']);
});

test('recovering the failed answering step answers at that step and skips what follows it', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const audit = motty({ name: 'audit' })
    .afterHandle(async ({ answer, route, path }) => {
      order.push(`audit after ${await answer.text()} ${route} ${path.length}`);
    })
    .afterResponse(({ outcome, route, path }) => {
      order.push(`audit response ${outcome} ${route} ${path.length}`);
      done.resolve();
    });

  const seen = await told(
    motty({ name: 'coder' })
      .use(audit)
      .route(() => 'chat', {
        chat: () => {
          throw new UpstreamFailed('Every model is down');
        },
      })
      .afterHandle(() => {
        order.push('late after');
      })
      .afterResponse(() => {
        order.push('late response');
      })
      .onError(() => answer('Fallback')),
  );
  await done.promise;
  await Bun.sleep(1);

  expect(text(seen)).toBe('Fallback');
  expect(order).toEqual([
    'audit after Fallback undefined 0',
    'audit response completed undefined 0',
  ]);
});

test('recovering a failed afterHandle answers at that hook, skips the afterHandle hooks after it and keeps the route for every afterResponse', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const audit = motty({ name: 'audit' }).afterResponse(
    ({ outcome, route, path }) => {
      order.push(`audit response ${outcome} ${route} ${path.length}`);
    },
  );

  const seen = await told(
    motty({ name: 'coder' })
      .use(audit)
      .route(() => 'chat', { chat: () => answer('From the handler') })
      .afterHandle(({ route }) => {
        order.push(`first after ${route}`);
      })
      .afterHandle(() => {
        throw new Blocked('The answer broke a rule');
      })
      .afterHandle(() => {
        order.push('late after');
      })
      .afterResponse(() => {
        order.push('late response');
        done.resolve();
      })
      .onError(() => answer('Withheld')),
  );
  await done.promise;

  expect(text(seen)).toBe('Withheld');
  expect(order).toEqual([
    'first after chat',
    'audit response completed chat 1',
    'late response',
  ]);
});

test('a part that ran whole keeps its afterResponse when an afterHandle registered before it is recovered', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const guard = motty({ name: 'guard' }).afterHandle(() => {
    throw new Blocked('The answer broke a rule');
  });
  const audit = motty({ name: 'audit' })
    .beforeHandle(() => {
      order.push('audit before');
    })
    .afterHandle(() => {
      order.push('audit after');
    })
    .afterResponse(({ outcome }) => {
      order.push(`audit response ${outcome}`);
      done.resolve();
    });

  const seen = await told(
    motty({ name: 'coder' })
      .use(guard)
      .use(audit)
      .handle(() => {
        order.push('handle');
        return answer('From the handler');
      })
      .onError(() => answer('Withheld')),
  );
  await done.promise;
  await Bun.sleep(1);

  expect(text(seen)).toBe('Withheld');
  expect(order).toEqual(['audit before', 'handle', 'audit response completed']);
});

test('an afterResponse registered after the answering step runs when an earlier afterHandle is recovered', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const guard = motty({ name: 'guard' })
    .afterHandle(() => {
      throw new Blocked('The answer broke a rule');
    })
    .afterResponse(() => {
      order.push('guard response');
    });

  await told(
    motty({ name: 'coder' })
      .use(guard)
      .handle(() => answer('From the handler'))
      .afterResponse(({ outcome }) => {
        order.push(`late response ${outcome}`);
        done.resolve();
      })
      .onError(() => answer('Withheld')),
  );
  await done.promise;

  expect(order).toEqual(['guard response', 'late response completed']);
});

test('an afterHandle recovered after an early answer keeps the afterResponse hooks before that answer and the one after it', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const guard = motty({ name: 'guard' }).afterHandle(() => {
    throw new Blocked('The answer broke a rule');
  });
  const audit = motty({ name: 'audit' }).afterResponse(() => {
    order.push('audit response');
  });

  const seen = await told(
    motty({ name: 'coder' })
      .use(guard)
      .use(audit)
      .beforeHandle(() => answer('Cached'))
      .afterResponse(() => {
        order.push('late response');
        done.resolve();
      })
      .handle(() => answer('From the handler'))
      .onError(() => answer('Withheld')),
  );
  await done.promise;

  expect(text(seen)).toBe('Withheld');
  expect(order).toEqual(['audit response', 'late response']);
});

test("a part's own early answer keeps the afterResponse it registered later, and one after the handle", async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const cache = motty({ name: 'cache' })
    .beforeHandle(() => answer('Cached'))
    .afterResponse(({ outcome }) => {
      order.push(`cache response ${outcome}`);
    });

  const seen = await told(
    motty({ name: 'coder' })
      .use(cache)
      .handle(() => answer('From the handler'))
      .afterResponse(({ outcome }) => {
        order.push(`late response ${outcome}`);
        done.resolve();
      }),
  );
  await done.promise;

  expect(text(seen)).toBe('Cached');
  expect(order).toEqual([
    'cache response completed',
    'late response completed',
  ]);
});

test('an afterResponse after a route no early answer reached is not run, and is named in the record as unreached and not as skipped', async () => {
  const order: string[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const cache = motty({ name: 'cache' })
    .beforeHandle(() => answer('Cached'))
    .afterResponse(() => {
      order.push('cache response');
    });

  await told(
    motty({ name: 'coder' })
      .use(cache)
      .route(() => 'chat', { chat: () => answer('From the handler') })
      .afterResponse(({ route }) => {
        order.push(`late response ${route}`);
      }),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: ['coder'],
  });
  expect(order).toEqual(['cache response']);
});

test('an afterResponse after a derive the early answer came before is not run, and is named in the record as unreached', async () => {
  const order: string[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const cache = motty({ name: 'cache' })
    .beforeHandle(() => answer('Cached'))
    .derive(() => ({ tenant: 'acme' }))
    .afterResponse(({ tenant }) => {
      order.push(`cache response ${tenant}`);
    });

  await told(
    motty({ name: 'coder' })
      .use(cache)
      .handle(() => answer('From the handler')),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: ['cache'],
  });
  expect(order).toEqual([]);
});

test.each([
  [
    'after',
    (logger: ReturnType<typeof logging>) =>
      motty({ name: 'coder' })
        .beforeHandle(() => answer('Cached'))
        .derive(() => ({ tenant: 'acme' }))
        .use(logger)
        .handle(() => answer('From the handler')),
  ],
  [
    'before',
    (logger: ReturnType<typeof logging>) =>
      motty({ name: 'coder' })
        .beforeHandle(() => answer('Cached'))
        .use(logger)
        .derive(() => ({ tenant: 'acme' }))
        .handle(() => answer('From the handler')),
  ],
])(
  'a part that only has an afterResponse, used %s a derive of its parent that an early answer came before, runs: the derive is not its own to read',
  async (_where, chained) => {
    const order: string[] = [];
    const over = Promise.withResolvers<RequestRecord>();

    await told(chained(logging(order)), stubHost({}, { record: over.resolve }));

    expect((await over.promise).afterResponse).toStrictEqual({
      failed: [],
      skipped: [],
      unreached: [],
    });
    expect(order).toEqual(['logger response completed']);
  },
);

test("an early answer leaves unreached the afterResponse of the chain whose derive never ran and of a chain that used that part, and runs a sibling part's", async () => {
  const order: string[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const tenant = motty({ name: 'tenant' })
    .derive(() => ({ tenant: 'acme' }))
    .afterResponse(({ tenant }) => {
      order.push(`tenant response ${tenant}`);
    });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(() => answer('Cached'))
      .use(tenant)
      .use(logging(order))
      .afterResponse(() => {
        order.push('coder response');
      })
      .handle(() => answer('From the handler')),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: ['tenant', 'coder'],
  });
  expect(order).toEqual(['logger response completed']);
});

test('an afterResponse of a second part that uses a part already applied is unreached with the first when that part made nothing', async () => {
  const order: string[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const tenant = motty({ name: 'tenant' }).derive(() => ({ tenant: 'acme' }));
  const billing = motty({ name: 'billing' })
    .use(tenant)
    .afterResponse(({ tenant }) => {
      order.push(`billing response ${tenant}`);
    });
  const audit = motty({ name: 'audit' })
    .use(tenant)
    .afterResponse(({ tenant }) => {
      order.push(`audit response ${tenant}`);
    });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(() => answer('Cached'))
      .use(billing)
      .use(audit)
      .handle(() => answer('From the handler')),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: ['billing', 'audit'],
  });
  expect(order).toEqual([]);
});

test('an afterResponse after a part that brought the route is unreached when an early answer came before that part', async () => {
  const order: string[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const tiers = motty({ name: 'tiers' }).route(() => 'chat', {
    chat: () => answer('From the handler'),
  });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(() => answer('Cached'))
      .use(tiers)
      .afterResponse(({ route }) => {
        order.push(`coder response ${route}`);
      }),
    stubHost({}, { record: over.resolve }),
  );

  expect((await over.promise).afterResponse).toStrictEqual({
    failed: [],
    skipped: [],
    unreached: ['coder'],
  });
  expect(order).toEqual([]);
});

test('an afterResponse after an early answer reads the value derived before that answer', async () => {
  const done = Promise.withResolvers<unknown[]>();
  const cache = motty({ name: 'cache' })
    .derive(() => ({ tenant: 'acme' }))
    .beforeHandle(() => answer('Cached'))
    .afterResponse((context) => {
      if (context.outcome === 'completed') {
        done.resolve([context.outcome, context.tenant]);
      }
    });

  await told(
    motty({ name: 'coder' })
      .use(cache)
      .handle(() => answer('From the handler')),
  );

  expect(await done.promise).toEqual(['completed', 'acme']);
});

test('an afterResponse registered first runs once whether the request completed, was answered early, failed or was stopped', async () => {
  const seen: string[] = [];
  const stop = new AbortController();
  const audit = motty({ name: 'audit' }).afterResponse(({ outcome }) => {
    seen.push(outcome);
  });

  await told(
    motty({ name: 'coder' })
      .use(audit)
      .handle(() => answer('Hi')),
  );
  await told(
    motty({ name: 'coder' })
      .use(audit)
      .beforeHandle(() => answer('Cached'))
      .derive(() => ({ tenant: 'acme' }))
      .route(() => 'chat', { chat: () => answer('Hi') }),
  );
  await told(
    motty({ name: 'coder' })
      .use(audit)
      .handle(() => {
        throw new UpstreamFailed('Every model is down');
      }),
  );
  await told(
    motty({ name: 'coder' })
      .use(audit)
      .handle(({ prompt }) => {
        setTimeout(() => stop.abort(), 1);
        return model('acme/slow').complete(prompt);
      }),
    {
      ...stubHost({}, { signal: stop.signal }),
      models: (_model, _prompt, signal) => silent(signal),
    },
  );
  await Bun.sleep(1);

  expect(seen).toEqual(['completed', 'completed', 'failed', 'aborted']);
});

test('an afterResponse after a route keeps the route and the path it is typed to hold when a later afterHandle is recovered', async () => {
  const done = Promise.withResolvers<unknown[]>();

  const seen = await told(
    motty({ name: 'coder' })
      .route(() => 'chat', { chat: () => answer('From the handler') })
      .afterResponse(async (context) => {
        if (context.outcome === 'completed') {
          const route: 'chat' = context.route;
          const path: readonly ['chat'] = context.path;
          done.resolve([route, path, await context.answer.text()]);
        }
      })
      .afterHandle(() => {
        throw new Blocked('The answer broke a rule');
      })
      .onError(() => answer('Withheld')),
  );

  expect(text(seen)).toBe('Withheld');
  expect(await done.promise).toEqual(['chat', ['chat'], 'Withheld']);
});

test('a part used after the part that answered early keeps its afterResponse and nothing else', async () => {
  const order: string[] = [];
  const done = Promise.withResolvers<void>();
  const cache = motty({ name: 'cache' })
    .afterResponse(() => {
      order.push('cache response');
    })
    .beforeHandle(() => answer('Cached'));
  const audit = motty({ name: 'audit' })
    .beforeHandle(() => {
      order.push('audit before');
    })
    .afterHandle(() => {
      order.push('audit after');
    })
    .afterResponse(() => {
      order.push('audit response');
      done.resolve();
    });

  await told(
    motty({ name: 'coder' })
      .use(cache)
      .use(audit)
      .handle(() => answer('From the handler')),
  );
  await done.promise;

  expect(order).toEqual(['cache response', 'audit response']);
});

test("a nested motty recovered by its parent's boundary answers at the parent's route", async () => {
  const order: string[] = [];
  const deep = motty({ name: 'deep' }).handle(() => {
    throw new UpstreamFailed('Both strong models are down');
  });

  const seen = await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', { deep })
      .afterHandle(() => {
        order.push('late after');
      })
      .afterResponse(() => {
        order.push('late response');
      })
      .onError(() => answer('Nothing is available')),
  );
  await Bun.sleep(1);

  expect(text(seen)).toBe('Nothing is available');
  expect(order).toEqual([]);
});

test('a failed afterHandle nobody recovered fails the request', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => answer('From the handler'))
      .afterHandle(() => {
        throw new Blocked('The answer broke a rule');
      }),
  );

  expect(seen).toMatchObject([{ type: 'error', error: { code: 'blocked' } }]);
});

test('an SDK call made after the caller left throws Aborted to the boundary', async () => {
  const stop = new AbortController();
  const caught = Promise.withResolvers<unknown>();

  await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => {
        stop.abort();
        return model('acme/small').complete(prompt);
      })
      .onError((thrown) => {
        caught.resolve(thrown);
      }),
    stubHost({ 'acme/small': says('Hi') }, { signal: stop.signal }),
  );

  expect(await caught.promise).toBeInstanceOf(Aborted);
});

test('a fallback answer for a caller who already left is not sent', async () => {
  const stop = new AbortController();

  const seen = await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => {
        stop.abort();
        return model('acme/small').complete(prompt);
      })
      .onError(() => answer('Sorry, something went wrong')),
    stubHost({ 'acme/small': says('Hi') }, { signal: stop.signal }),
  );

  expect(seen).toMatchObject([{ type: 'error', error: { code: 'aborted' } }]);
});

test('passing limits.calls throws LimitReached to the boundary', async () => {
  const caught: unknown[] = [];

  const seen = await told(
    motty({ name: 'coder' })
      .handle(async ({ prompt }) => {
        await model('acme/small').complete(prompt);
        return model('acme/small').complete(prompt);
      })
      .onError((thrown) => {
        caught.push(thrown);
        return answer('That took too many calls');
      }),
    stubHost({ 'acme/small': says('Hi') }, { limits: { calls: 1 } }),
  );

  expect(caught[0]).toBeInstanceOf(LimitReached);
  expect(text(seen)).toBe('That took too many calls');
});

test('LimitReached nobody recovered goes out with the usage so far', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(async ({ prompt }) => {
      await model('acme/small').complete(prompt);
      return model('acme/small').complete(prompt);
    }),
    stubHost({ 'acme/small': says('Hi') }, { limits: { calls: 1 } }),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'limit_reached',
        status: 500,
        message: 'The request reached its limit of 1 calls',
        retryable: false,
      },
      usage: { input: 1, output: 1 },
    },
  ]);
});

test.each(['derive', 'beforeHandle', 'chooser', 'handler', 'afterHandle'])(
  'a caller leaving during %s gets one aborted event and the outcome is aborted',
  async (phase) => {
    const stop = new AbortController();
    const done = Promise.withResolvers<string>();
    const leave = (at: string) => {
      if (at === phase) stop.abort();
    };

    const seen = await told(
      motty({ name: 'coder' })
        .derive(() => {
          leave('derive');
          return {};
        })
        .beforeHandle(() => leave('beforeHandle'))
        .route(
          () => {
            leave('chooser');
            return 'chat';
          },
          {
            chat: () => {
              leave('handler');
              return answer('Hi');
            },
          },
        )
        .afterHandle(() => leave('afterHandle'))
        .afterResponse(({ outcome }) => {
          done.resolve(outcome);
        }),
      stubHost({}, { signal: stop.signal }),
    );

    expect(seen).toEqual([
      {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The work was stopped',
          retryable: false,
        },
        usage: {},
      },
    ]);
    expect(await done.promise).toBe('aborted');
  },
);

test('a signal fired after the caller has everything leaves the outcome completed', async () => {
  const stop = new AbortController();
  const done = Promise.withResolvers<string>();
  const reader = contractOf(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(async ({ outcome }) => {
        await Bun.sleep(1);
        done.resolve(outcome);
      }),
  )
    .run(ask(), stubHost({}, { signal: stop.signal }))
    [Symbol.asyncIterator]();

  await reader.next();
  await reader.next();
  stop.abort();

  expect(await done.promise).toBe('completed');
});

test('a call in flight is cancelled when the signal fires and still counted', async () => {
  const stop = new AbortController();
  const done = Promise.withResolvers<unknown>();

  const seen = await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => {
        setTimeout(() => stop.abort(), 1);
        return model('acme/slow').complete(prompt);
      })
      .afterResponse(({ outcome, calls }) => {
        done.resolve([outcome, calls.made.map((call) => call.model)]);
      }),
    {
      ...stubHost({}, { signal: stop.signal }),
      models: (_model, _prompt, signal) => silent(signal),
    },
  );

  expect(seen).toMatchObject([{ type: 'error', error: { code: 'aborted' } }]);
  expect(await done.promise).toEqual(['aborted', ['acme/slow']]);
});

test('every line of progress offered before the answer goes out', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => {
      think('one');
      think('two');
      think('three');
      return answer('Hi');
    }),
  );

  expect(seen.map((event) => event.type)).toEqual([
    'progress',
    'progress',
    'progress',
    'text',
    'finish',
  ]);
});

test('progress does not depend on when the reader starts', async () => {
  const reader = contractOf(
    motty({ name: 'coder' })
      .beforeHandle(() => think('one'))
      .handle(() => {
        think('two');
        return answer('Hi');
      }),
  )
    .run(ask(), stubHost())
    [Symbol.asyncIterator]();
  await Bun.sleep(1);

  const seen = [];
  for (let read = await reader.next(); !read.done; read = await reader.next()) {
    seen.push(read.value.type);
  }

  expect(seen).toEqual(['progress', 'progress', 'text', 'finish']);
});

test('lines and whole answers queued behind a forwarded answer still arriving go out after it is cut', async () => {
  const gate = Promise.withResolvers<void>();
  async function* arriving(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'Planning' };
    await gate.promise;
    yield { type: 'text', text: ' the rest' };
  }

  const seen = await told(
    motty({ name: 'coder' }).handle(async () => {
      think(answer(arriving()));
      think('Following the plan');
      think(answer('A second plan, all of it here'));
      think('Answering');
      await Bun.sleep(1);
      return answer('Hi');
    }),
  );
  gate.resolve();

  expect(seen).toEqual([
    { type: 'progress', piece: 0, text: 'Planning' },
    { type: 'progress', piece: 1, text: 'Following the plan' },
    { type: 'progress', piece: 2, text: 'A second plan, all of it here' },
    { type: 'progress', piece: 3, text: 'Answering' },
    { type: 'text', text: 'Hi' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
});

test('a forwarded answer cut at the close is not cancelled by the cut', async () => {
  const gate = Promise.withResolvers<void>();
  async function* arriving(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'Planning' };
    await gate.promise;
    yield { type: 'text', text: ' the rest' };
  }
  const plan = answer(arriving());

  const seen = await told(
    motty({ name: 'coder' }).handle(async () => {
      think(plan);
      await Bun.sleep(1);
      return answer('Hi');
    }),
  );
  gate.resolve();

  expect(seen.map((event) => event.type)).toEqual([
    'progress',
    'text',
    'finish',
  ]);
  expect(await plan.text()).toBe('Planning the rest');
});

test('a look-alike of an answer passed to think is no progress and none of its code runs', async () => {
  const ran: string[] = [];
  const plan = answer('Planning');

  const seen = await told(
    motty({ name: 'coder' }).handle(async () => {
      think({
        ...plan,
        chunks: () => {
          ran.push('chunks');
          return plan.chunks();
        },
      });
      await Bun.sleep(1);
      return answer('Hi');
    }),
  );

  expect(seen.map((event) => event.type)).toEqual(['text', 'finish']);
  expect(ran).toEqual([]);
});

test('a message edited in place leaves the request as the caller sent it', async () => {
  const request = ask();
  const host = stubHost({ 'acme/small': says('Done') });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(({ prompt }) => {
        const [first] = prompt.messages;
        if (first?.text !== undefined) first.text = 'Compacted';
      })
      .handle(({ prompt }) => model('acme/small').complete(prompt)),
    host,
    request,
  );

  expect(host.sent('acme/small')[0]?.messages).toEqual([
    { role: 'user', text: 'Compacted' },
  ]);
  expect(request.messages).toEqual([
    { role: 'user', text: 'Why does this deadlock?' },
  ]);
});

test('an option and a tool edited in place leave the request as the caller sent it', async () => {
  const request: ChatRequest = {
    ...ask(),
    tools: [{ type: 'function', name: 'search', input: { type: 'object' } }],
    options: { stop: ['END'], provider: { openai: { store: false } } },
  };
  const host = stubHost({ 'acme/small': says('Done') });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(({ prompt }) => {
        prompt.options?.stop?.push('STOP');
        Object.assign(prompt.options?.provider ?? {}, { openai: null });
        const [tool] = prompt.tools ?? [];
        if (tool?.type === 'function') Object.assign(tool.input, { a: 1 });
      })
      .handle(({ prompt }) => model('acme/small').complete(prompt)),
    host,
    request,
  );

  expect(host.sent('acme/small')[0]).toEqual({
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [
      { type: 'function', name: 'search', input: { type: 'object', a: 1 } },
    ],
    options: { stop: ['END', 'STOP'], provider: { openai: null } },
  });
  expect(request.tools).toEqual([
    { type: 'function', name: 'search', input: { type: 'object' } },
  ]);
  expect(request.options).toEqual({
    stop: ['END'],
    provider: { openai: { store: false } },
  });
});

test('the output schema reaches the prompt as the object the caller sent', async () => {
  const request: ChatRequest = { ...ask(), output: { name: 'verdict' } };
  const same: boolean[] = [];

  await told(
    motty({ name: 'coder' }).handle(({ prompt }) => {
      same.push(prompt.output === request.output);
      return answer('{}');
    }),
    stubHost(),
    request,
  );

  expect(same).toEqual([true]);
});

test('a part used early reads no route under a handle and the entry under a route', async () => {
  const routes: (string | undefined)[] = [];
  const audit = motty({ name: 'audit' }).afterHandle(({ route }) => {
    routes.push(route);
  });

  await told(
    motty({ name: 'coder' })
      .use(audit)
      .handle(() => answer('Hi')),
  );
  await told(
    motty({ name: 'coder' })
      .use(audit)
      .route(() => 'chat', { chat: () => answer('Hi') }),
  );

  expect(routes).toEqual([undefined, 'chat']);
});

test('once the stop signal fired no later step starts', async () => {
  const stop = new AbortController();
  const ran: string[] = [];
  const caught: unknown[] = [];
  const done = Promise.withResolvers<string>();

  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {
        ran.push('first before');
        stop.abort();
      })
      .beforeHandle(() => {
        ran.push('second before');
      })
      .route(
        () => {
          ran.push('chooser');
          return 'chat';
        },
        {
          chat: () => {
            ran.push('handler');
            return answer('Hi');
          },
        },
      )
      .afterHandle(() => {
        ran.push('afterHandle');
      })
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      })
      .onError((thrown) => {
        caught.push(thrown);
      }),
    stubHost({}, { signal: stop.signal }),
  );

  expect(ran).toEqual(['first before']);
  expect(seen).toHaveLength(1);
  expect(seen).toMatchObject([{ type: 'error', error: { code: 'aborted' } }]);
  expect(caught).toHaveLength(1);
  expect(caught[0]).toBeInstanceOf(Aborted);
  expect(await done.promise).toBe('aborted');
});

test.each([
  'derive',
  'beforeHandle',
  'chooser',
  'quick',
  'standard',
  'afterHandle',
  'late afterHandle',
])(
  'the step in which the signal fired is the last to start: %s',
  async (at) => {
    const stop = new AbortController();
    const ran: string[] = [];
    const step = (name: string) => {
      ran.push(name);
      if (name === at) stop.abort();
    };

    await told(
      motty({ name: 'coder' })
        .derive(() => {
          step('derive');
          return {};
        })
        .beforeHandle(() => step('beforeHandle'))
        .route(
          () => {
            step('chooser');
            return 'quick';
          },
          {
            quick: () => {
              step('quick');
              return reroute('standard');
            },
            standard: () => {
              step('standard');
              return answer('Hi');
            },
          },
        )
        .afterHandle(() => step('afterHandle'))
        .afterHandle(() => step('late afterHandle')),
      stubHost({}, { signal: stop.signal }),
    );

    expect(ran.at(-1)).toBe(at);
  },
);

test('a nested motty does not start once the signal fired', async () => {
  const stop = new AbortController();
  const ran: string[] = [];
  const caught: unknown[] = [];
  const deep = motty({ name: 'deep' })
    .handle(() => {
      ran.push('nested handle');
      return answer('Hi');
    })
    .onError((thrown) => {
      caught.push(thrown);
    });

  await told(
    motty({ name: 'coder' }).route(
      () => {
        stop.abort();
        return 'deep';
      },
      { deep },
    ),
    stubHost({}, { signal: stop.signal }),
  );

  expect(ran).toEqual([]);
  expect(caught[0]).toBeInstanceOf(Aborted);
});

test('a boundary asked about a step that never started may answer, and it is not sent', async () => {
  const stop = new AbortController();
  const asked: unknown[] = [];

  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => stop.abort())
      .handle(() => answer('Hi'))
      .onError((thrown) => {
        asked.push(thrown);
        return answer('Sorry, something went wrong');
      }),
    stubHost({}, { signal: stop.signal }),
  );

  expect(asked[0]).toBeInstanceOf(Aborted);
  expect(seen).toMatchObject([{ type: 'error', error: { code: 'aborted' } }]);
});

test("a hook's signal fires with the host's, at once", async () => {
  const stop = new AbortController();
  const seen: boolean[] = [];

  await told(
    motty({ name: 'coder' })
      .beforeHandle(({ signal }) => {
        seen.push(signal.aborted);
        stop.abort();
        seen.push(signal.aborted);
      })
      .handle(() => answer('Hi')),
    stubHost({}, { signal: stop.signal }),
  );

  expect(seen).toEqual([false, true]);
});

test.each([
  'request',
  'prompt',
  'signal',
  'calls',
  'route',
  'path',
  'answer',
  'outcome',
  '__proto__',
])('a derive that names %s past the types fails the request', async (key) => {
  const caught: unknown[] = [];

  const seen = await told(
    motty({ name: 'coder' })
      .use(
        motty({ name: 'tenant' }).derive(() =>
          Object.defineProperty({}, key, { value: 'acme', enumerable: true }),
        ),
      )
      .handle(() => answer('Hi'))
      .onError((thrown) => {
        caught.push(thrown);
      }),
  );

  expect(seen).toMatchObject([
    { type: 'error', error: { code: 'internal', message: 'Internal error' } },
  ]);
  expect(caught).toEqual([
    new Error(`A derive of "tenant" named a value "${key}", which is reserved`),
  ]);
});

test.each([
  [
    'the same name again',
    () =>
      motty({ name: 'coder' })
        .derive(() => ({ user: 'ada' }))
        // @ts-expect-error the chain already has a user
        .derive(() => ({ user: 7 })),
  ],
  [
    'a map of any names that holds it',
    () =>
      motty({ name: 'coder' })
        .derive(() => ({ user: 'ada' }))
        .derive((): { [name: string]: boolean } =>
          // @ts-expect-error a map of any names is no known name
          Object.fromEntries([['user', true]]),
        ),
  ],
  [
    'one of two shapes that holds it',
    () =>
      motty({ name: 'coder' })
        .derive(() => ({ user: 'ada' }))
        // @ts-expect-error one of the two shapes names a user
        .derive((): { user: number } | { plan: number } => ({ user: 7 })),
  ],
  [
    'the name a part it used made',
    () =>
      motty({ name: 'coder' })
        .use(motty({ name: 'auth' }).derive(() => ({ user: 'ada' })))
        // @ts-expect-error the part made a user
        .derive(() => ({ user: 7 })),
  ],
])(
  'a chain that derives a user and then %s is refused by the types, and past them fails the request, named by the value',
  async (_how, chained) => {
    const caught: unknown[] = [];

    const seen = await told(
      chained()
        .handle(({ user }) => answer(`Hi ${user}`))
        .onError((thrown) => {
          caught.push(thrown);
        }),
    );

    expect(seen).toMatchObject([
      { type: 'error', error: { code: 'internal', message: 'Internal error' } },
    ]);
    expect(caught).toEqual([
      new Error(
        'A derive of "coder" named a value "user", which the chain already has',
      ),
    ]);
  },
);

test('a used part replaces a value its user derived before it, and the request reads the part’s', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .derive(() => ({ user: 'anonymous' }))
      .use(motty({ name: 'auth' }).derive(() => ({ user: 'ada' })))
      .handle(({ user }) => answer(`Hi ${user}`)),
  );

  expect(text(seen)).toBe('Hi ada');
});

test('an entry that is a motty derives a name its parent derived for itself, and each reads its own', async () => {
  const read = Promise.withResolvers<string>();
  const tiers = motty({ name: 'tiers' })
    .derive(() => ({ tenant: 'nested' }))
    .handle(({ tenant }) => answer(`Hi ${tenant}`));

  const seen = await told(
    motty({ name: 'coder' })
      .derive(() => ({ tenant: 'parent' }))
      .route(() => 'chat', { chat: tiers })
      .afterResponse(({ tenant }) => {
        read.resolve(tenant ?? 'none');
      }),
  );

  expect(text(seen)).toBe('Hi nested');
  expect(await read.promise).toBe('parent');
});

test('an entry that is a motty and derives one name twice past the types fails as a root does', async () => {
  const caught: unknown[] = [];
  const tiers = motty({ name: 'tiers' })
    .derive(() => ({ tenant: 'acme' }))
    // @ts-expect-error the chain already has a tenant
    .derive(() => ({ tenant: 7 }))
    .handle(() => answer('Hi'));

  await told(
    motty({ name: 'coder' })
      .route(() => 'chat', { chat: tiers })
      .onError((thrown) => {
        caught.push(thrown);
      }),
  );

  expect(caught).toEqual([
    new Error(
      'A derive of "tiers" named a value "tenant", which the chain already has',
    ),
  ]);
});

test.each([
  ['nothing', undefined],
  ['a string', 'acme'],
  ['a list', [{ tenant: 'acme' }]],
  ['a map', new Map([['tenant', 'acme']])],
])(
  'a derive that gives %s past the types fails the request',
  async (_name, given) => {
    const caught: unknown[] = [];

    const seen = await told(
      motty({ name: 'coder' })
        .derive(() => given as never)
        .handle(() => answer('Hi'))
        .onError((thrown) => {
          caught.push(thrown);
        }),
    );

    expect(seen).toMatchObject([
      { type: 'error', error: { code: 'internal', message: 'Internal error' } },
    ]);
    expect(caught).toEqual([
      new Error(
        'A derive of "coder" gave something that is not a plain object',
      ),
    ]);
  },
);

test('a derived object with no prototype is taken as it is', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .derive(() => {
        const bare = { tenant: 'acme' };
        Object.setPrototypeOf(bare, null);
        return bare;
      })
      .handle(({ tenant }) => answer(tenant)),
  );

  expect(text(seen)).toBe('acme');
});

test('a hook cannot change the usage the caller is told', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/small').complete(prompt))
      .afterHandle(async ({ calls, answer }) => {
        await answer.finish();
        const view: { total: unknown; made: unknown } = calls;
        const total: { input?: number } = calls.total;
        const [call]: readonly { model: string }[] = calls.made;
        expect(() => {
          total.input = 1_000_000;
        }).toThrow(TypeError);
        expect(() => {
          view.total = { input: 1_000_000, output: 0 };
        }).toThrow(TypeError);
        expect(() => {
          view.made = [];
        }).toThrow(TypeError);
        expect(() => {
          if (call !== undefined) call.model = 'acme/free';
        }).toThrow(TypeError);
      }),
    stubHost({ 'acme/small': says('Done') }),
  );

  expect(seen.at(-1)).toEqual({
    type: 'finish',
    reason: 'stop',
    usage: { input: 1, output: 1 },
  });
});

test('a call made in afterResponse counts toward limits.calls', async () => {
  const caught = Promise.withResolvers<unknown>();

  await told(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/small').complete(prompt))
      .afterResponse(async ({ prompt }) => {
        await model('acme/small').complete(prompt).catch(caught.resolve);
      }),
    stubHost({ 'acme/small': says('Hi') }, { limits: { calls: 1 } }),
  );

  expect(await caught.promise).toBeInstanceOf(LimitReached);
});

test.each([
  'derive',
  'beforeHandle',
  'chooser',
  'handler',
  'afterHandle',
  'onError',
  'catch',
])(
  'a %s that never returns does not hold a stopped request: it fails with Aborted, after-response work runs and the record arrives',
  async (stuck) => {
    const stop = new AbortController();
    const over = Promise.withResolvers<RequestRecord>();
    const seen: string[] = [];
    const never = (at: string) =>
      at === stuck ? new Promise<never>(() => {}) : undefined;
    const failing = motty({ name: 'failing' }).handle(() => {
      throw new UpstreamFailed('Every model is down');
    });

    const reading = told(
      motty({ name: 'coder' })
        .derive(async () => {
          await never('derive');
          return { tier: 'deep' };
        })
        .beforeHandle(async () => {
          await never('beforeHandle');
        })
        .route(
          async () => {
            await never('chooser');
            return stuck === 'catch' || stuck === 'onError' ? 'broken' : 'ok';
          },
          {
            ok: async () => {
              await never('handler');
              return answer('Hi');
            },
            broken:
              stuck === 'catch'
                ? failing.catch(() => new Promise<never>(() => {}))
                : failing,
          },
        )
        .afterHandle(async () => {
          await never('afterHandle');
        })
        .onError(async () => {
          await never('onError');
        })
        .afterResponse(({ outcome }) => {
          seen.push(outcome);
        }),
      stubHost({}, { signal: stop.signal, record: over.resolve }),
    );
    // Long enough for the request to reach the step that never returns.
    await Bun.sleep(1);
    stop.abort();
    const events = await reading;
    const { outcome, error, afterResponse } = await over.promise;

    expect(events).toMatchObject([
      { type: 'error', error: { code: 'aborted' } },
    ]);
    expect(outcome).toBe('aborted');
    expect(error?.code).toBe('aborted');
    expect(seen).toEqual(['aborted']);
    expect(afterResponse).toEqual({ failed: [], skipped: [], unreached: [] });
  },
);

test('a hook that never returns does not hold a request whose stream the host closed', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const reader = contractOf(
    motty({ name: 'coder' })
      .beforeHandle(async () => {
        await new Promise(() => {});
      })
      .handle(() => answer('Hi')),
  )
    .run(ask(), stubHost({}, { record: over.resolve }))
    [Symbol.asyncIterator]();

  await reader.return?.();

  expect(await over.promise).toMatchObject({
    outcome: 'aborted',
    error: { code: 'aborted', status: 499 },
  });
});

test('the error the host gave as the reason of its stop is the one raised: the boundary sees it, and the caller and the record are told it in its own words', async () => {
  const stop = new AbortController();
  const over = Promise.withResolvers<RequestRecord>();
  const caught = Promise.withResolvers<unknown>();
  const reason = new TimedOut('The host gives a request two minutes');

  const reader = contractOf(
    motty({ name: 'coder' })
      .handle(() => new Promise<never>(() => {}))
      .onError((thrown) => {
        caught.resolve(thrown);
      }),
  )
    .run(ask(), stubHost({}, { signal: stop.signal, record: over.resolve }))
    [Symbol.asyncIterator]();
  const waiting = reader.next();
  stop.abort(reason);

  expect(await waiting).toEqual({
    done: false,
    value: {
      type: 'error',
      error: {
        code: 'timed_out',
        status: 504,
        message: 'The host gives a request two minutes',
        retryable: true,
      },
      usage: {},
    },
  });
  expect(await caught.promise).toBe(reason);
  expect(await over.promise).toMatchObject({
    outcome: 'aborted',
    error: {
      code: 'timed_out',
      message: 'The host gives a request two minutes',
    },
  });
});

test.each([
  [
    'a call limit that is a fraction',
    { limits: { calls: 1.5 } },
    'limits.calls',
  ],
  [
    'an after-response limit below zero',
    { limits: { afterResponse: -1 } },
    'limits.afterResponse',
  ],
  ['no stop signal', { signal: JSON.parse('null') }, 'signal'],
])(
  'running a motty on a host with %s does not throw: the stream holds one error and the record says what was wrong',
  async (_name, wrong, named) => {
    const over = Promise.withResolvers<RequestRecord>();
    const ran: string[] = [];

    const events = await told(
      motty({ name: 'coder' })
        .handle(() => {
          ran.push('handle');
          return answer('Hi');
        })
        .afterResponse(() => {
          ran.push('afterResponse');
        }),
      { ...stubHost({}, { record: over.resolve }), ...wrong },
    );
    const { outcome, error, calls } = await over.promise;

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'internal',
          status: 500,
          message: 'Internal error',
          retryable: false,
        },
        usage: {},
      },
    ]);
    expect(outcome).toBe('failed');
    expect(error?.message).toContain(named);
    expect(error?.stack).toContain(named);
    expect(calls).toEqual([]);
    expect(ran).toEqual([]);
  },
);

test('ten thousand requests on one signal of a long-lived host leave no listener on it, and a stop during one still stops it', async () => {
  const host = new AbortController();
  const added = spyOn(host.signal, 'addEventListener');
  const removed = spyOn(host.signal, 'removeEventListener');
  const over = Promise.withResolvers<RequestRecord>();
  const served = motty({ name: 'coder' })
    .handle(async ({ prompt }) => {
      if (prompt.messages.length > 1) await new Promise(() => {});
      return model('acme/small').complete(prompt);
    })
    .afterResponse(() => {});

  for (let sent = 0; sent < 10_000; sent += 1) {
    const done = Promise.withResolvers<RequestRecord>();
    await told(
      served,
      stubHost(
        { 'acme/small': says('Hi') },
        { signal: host.signal, record: done.resolve },
      ),
    );
    await done.promise;
  }
  const left = added.mock.calls.filter(
    ([, listener]) => !removed.mock.calls.some(([, gone]) => gone === listener),
  ).length;
  const reader = contractOf(served)
    .run(
      { ...ask(), messages: [...ask().messages, ...ask().messages] },
      stubHost({}, { signal: host.signal, record: over.resolve }),
    )
    [Symbol.asyncIterator]();
  const waiting = reader.next();
  host.abort();

  expect(left).toBe(0);
  expect((await waiting).value).toMatchObject({ error: { code: 'aborted' } });
  expect((await over.promise).outcome).toBe('aborted');
  expect(added).toHaveBeenCalledTimes(10_001);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test.each([
  ['undefined', JSON.parse('[null]')[1], 'host'],
  ['null', JSON.parse('null'), 'host'],
  ['a number', JSON.parse('7'), 'host'],
])(
  'running a motty on a host that is %s does not throw: the stream holds one error and nothing is left unhandled',
  async (_name, host, named) => {
    const unhandled: unknown[] = [];
    const heard = (thrown: unknown) => unhandled.push(thrown);
    process.on('unhandledRejection', heard);

    const events = await Array.fromAsync(
      contractOf(motty({ name: 'coder' }).handle(() => answer('Hi'))).run(
        ask(),
        host,
      ),
    );
    await Bun.sleep(1);
    process.off('unhandledRejection', heard);

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'internal',
          status: 500,
          message: 'Internal error',
          retryable: false,
        },
        usage: {},
      },
    ]);
    expect(named).toBe('host');
    expect(unhandled).toEqual([]);
  },
  1_000,
);

test.each([
  ['limits that are text', { limits: JSON.parse('"x"') }, 'limits'],
  ['limits that are a number', { limits: JSON.parse('5') }, 'limits'],
  ['models that are no function', { models: JSON.parse('{}') }, 'models'],
])(
  'running a motty on a host with %s does not throw: the stream holds one error and the record says what was wrong',
  async (_name, wrong, named) => {
    const over = Promise.withResolvers<RequestRecord>();
    const ran: string[] = [];

    const events = await told(
      motty({ name: 'coder' }).handle(() => {
        ran.push('handle');
        return answer('Hi');
      }),
      { ...stubHost({}, { record: over.resolve }), ...wrong },
    );
    const { outcome, error } = await over.promise;

    expect(events).toMatchObject([
      { type: 'error', error: { code: 'internal' } },
    ]);
    expect(outcome).toBe('failed');
    expect(error?.message).toContain(named);
    expect(ran).toEqual([]);
  },
  1_000,
);

test('a record that is no function is a mistake of the host: the stream holds one error, and there is nobody to send a record to', async () => {
  const ran: string[] = [];

  const events = await told(
    motty({ name: 'coder' }).handle(() => {
      ran.push('handle');
      return answer('Hi');
    }),
    { ...stubHost(), record: JSON.parse('"yes"') },
  );

  expect(events).toMatchObject([
    { type: 'error', error: { code: 'internal' } },
  ]);
  expect(ran).toEqual([]);
});

test('a request that ends normally with a model call still open constructs no error', async () => {
  const served = motty({ name: 'coder' }).handle(({ prompt }) => {
    model('acme/slow').complete(prompt);
    return answer('Hi');
  });
  const host = () => ({
    ...stubHost(),
    models: async function* (): EventStream {
      yield { type: 'text', text: 'Half' };
      await new Promise(() => {});
    },
  });
  await told(served, host());
  let made = 0;
  const plain = globalThis.Error;
  const counting = new Proxy(plain, {
    construct(target, given, madeAs) {
      made += 1;
      return Reflect.construct(target, given, madeAs);
    },
  });
  globalThis.Error = counting;
  Object.setPrototypeOf(MottyError, counting);

  const events = await told(served, host())
    .finally(() => Bun.sleep(1))
    .finally(() => {
      globalThis.Error = plain;
      Object.setPrototypeOf(MottyError, plain);
    });

  expect(events.map((event) => event.type)).toEqual(['text', 'finish']);
  expect(made).toBe(0);
});

test.each([
  ['no messages', { messages: JSON.parse('[null]')[1] }],
  ['messages that are text', { messages: JSON.parse('"Hi"') }],
  ['no tools', { tools: JSON.parse('[null]')[1] }],
])(
  'a request with %s is a mistake of the host: the request fails as an internal error and no step runs',
  async (_name, wrong) => {
    const ran: string[] = [];

    const events = await told(
      motty({ name: 'coder' }).handle(() => {
        ran.push('handle');
        return answer('Hi');
      }),
      stubHost(),
      { ...ask(), ...wrong },
    );

    expect(events).toMatchObject([
      { type: 'error', error: { code: 'internal', status: 500 } },
    ]);
    expect(ran).toEqual([]);
  },
);
