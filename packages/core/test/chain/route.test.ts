import { expect, test } from 'bun:test';
import type { AnyMotty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { reroute } from '../../src/chain/route.ts';
import { contractOf } from '../../src/chain/run.ts';
import type { Host } from '../../src/contract.ts';
import {
  RouteLoop,
  UnknownRoute,
  UpstreamFailed,
} from '../../src/data/errors.ts';
import type { StreamEvent } from '../../src/data/event.ts';
import type { ChatRequest } from '../../src/data/message.ts';
import { answer } from '../../src/request/answer.ts';
import { model } from '../../src/request/model.ts';
import { stubHost } from '../stub-host.ts';

function ask(model = 'motty/coder'): ChatRequest {
  return {
    id: 'req_1',
    model,
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers: new Headers(),
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

test('the chooser names the entry that answers', async () => {
  const seen = await told(
    motty({ name: 'tiers' }).route(() => 'quick', {
      quick: () => answer('From the quick tier'),
      deep: () => answer('From the deep tier'),
    }),
  );

  expect(text(seen)).toBe('From the quick tier');
});

test('a rerouted entry gets the prompt as the handler left it', async () => {
  const host = stubHost({ 'acme/standard': says('Done') });

  await told(
    motty({ name: 'tiers' }).route(() => 'quick', {
      quick: ({ prompt }) => {
        prompt.messages = [{ role: 'user', text: 'Shortened' }];
        return reroute('standard');
      },
      standard: ({ prompt }) => model('acme/standard').complete(prompt),
    }),
    host,
  );

  expect(host.sent('acme/standard')[0]?.messages).toEqual([
    { role: 'user', text: 'Shortened' },
  ]);
});

test('route is the entry that answered, not the one chosen', async () => {
  const routes: string[] = [];

  await told(
    motty({ name: 'tiers' })
      .route(() => 'quick', {
        quick: () => reroute('standard'),
        standard: () => answer('From the standard tier'),
      })
      .afterHandle(({ route }) => {
        routes.push(route);
      }),
  );

  expect(routes).toEqual(['standard']);
});

test('a reroute chain runs each entry once, in order', async () => {
  const ran: string[] = [];

  const seen = await told(
    motty({ name: 'tiers' }).route(() => 'quick', {
      quick: () => {
        ran.push('quick');
        return reroute('standard');
      },
      standard: () => {
        ran.push('standard');
        return reroute('deep');
      },
      deep: () => {
        ran.push('deep');
        return answer('From the deep tier');
      },
    }),
  );

  expect(ran).toEqual(['quick', 'standard', 'deep']);
  expect(text(seen)).toBe('From the deep tier');
});

test('a reroute to an entry that already ran fails with RouteLoop', async () => {
  const seen = await told(
    motty({ name: 'tiers' }).route(() => 'quick', {
      quick: () => reroute('standard'),
      standard: () => reroute('quick'),
    }),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'route_loop',
        status: 500,
        message:
          'The entry "quick" of the motty "tiers" already ran for this request',
        retryable: false,
      },
      usage: {},
    },
  ]);
});

test('a chooser result cast past the types fails with UnknownRoute', async () => {
  const seen = await told(
    motty({ name: 'tiers' }).route(({ request }) => request.model as 'quick', {
      quick: () => answer('From the quick tier'),
    }),
    stubHost(),
    ask('acme/whatever'),
  );

  expect(seen).toEqual([
    {
      type: 'error',
      error: {
        code: 'unknown_route',
        status: 500,
        message:
          'The route of the motty "tiers" has no entry named "acme/whatever"',
        retryable: false,
      },
      usage: {},
    },
  ]);
});

test('a name every object inherits is not an entry', async () => {
  const seen = await told(
    motty({ name: 'tiers' }).route(({ request }) => request.model as 'quick', {
      quick: () => answer('From the quick tier'),
    }),
    stubHost(),
    ask('toString'),
  );

  expect(seen).toMatchObject([{ error: { code: 'unknown_route' } }]);
});

test('a chooser that gives a number, not a name, fails with UnknownRoute', async () => {
  const seen = await told(
    motty({ name: 'tiers' }).route(() => 1 as never, {
      1: () => answer('From the first tier'),
    }),
  );

  expect(seen).toMatchObject([{ error: { code: 'unknown_route' } }]);
});

test('a handler that gives neither an answer nor a reroute is an internal error', async () => {
  const seen = await told(
    motty({ name: 'tiers' }).route(() => 'quick', {
      quick: () => 'From the quick tier' as never,
    }),
  );

  expect(seen).toMatchObject([
    { error: { code: 'internal', message: 'Internal error' } },
  ]);
});

test('path is empty and route absent when a hook answered before routing', async () => {
  const seen: unknown[] = [];
  const audit = motty({ name: 'audit' }).afterHandle((context) => {
    seen.push(context.path, 'route' in context);
  });

  await told(
    motty({ name: 'coder' })
      .use(audit)
      .beforeHandle(() => answer('I only answer questions about software'))
      .route(() => 'chat', { chat: () => answer('From the chat entry') }),
  );

  expect(seen).toEqual([[], false]);
});

test('routes nest three deep, each motty seeing its own route and path', async () => {
  const seen: unknown[] = [];
  const leaf = motty({ name: 'leaf' })
    .route(() => 'c', { c: () => answer('From the leaf') })
    .afterHandle(({ route, path }) => {
      seen.push(['leaf', route, path]);
    });
  const middle = motty({ name: 'middle' })
    .route(() => 'b', { b: leaf })
    .afterHandle(({ route, path }) => {
      seen.push(['middle', route, path]);
    });

  const events = await told(
    motty({ name: 'root' })
      .route(() => 'a', { a: middle })
      .afterHandle(({ route, path }) => {
        seen.push(['root', route, path]);
      }),
  );

  expect(text(events)).toBe('From the leaf');
  expect(seen).toEqual([
    ['leaf', 'c', ['c']],
    ['middle', 'b', ['b', 'c']],
    ['root', 'a', ['a', 'b', 'c']],
  ]);
});

test("a motty entry runs its whole lifecycle inside its parent's", async () => {
  const order: string[] = [];
  const tiers = motty({ name: 'tiers' })
    .beforeHandle(() => {
      order.push('nested before');
    })
    .handle(() => {
      order.push('nested handle');
      return answer('From the nested motty');
    })
    .afterHandle(() => {
      order.push('nested after');
    });

  await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {
        order.push('parent before');
      })
      .route(
        () => {
          order.push('parent chooser');
          return 'chat';
        },
        { chat: tiers },
      )
      .afterHandle(() => {
        order.push('parent after');
      }),
  );

  expect(order).toEqual([
    'parent before',
    'parent chooser',
    'nested before',
    'nested handle',
    'nested after',
    'parent after',
  ]);
});

test('an early answer in a nested motty ends only that motty', async () => {
  const order: string[] = [];
  const tiers = motty({ name: 'tiers' })
    .beforeHandle(() => answer('Cached'))
    .handle(() => {
      order.push('nested handle');
      return answer('From the nested motty');
    })
    .afterHandle(() => {
      order.push('nested after');
    });

  const seen = await told(
    motty({ name: 'coder' })
      .route(() => 'chat', { chat: tiers })
      .afterHandle(({ route, path }) => {
        order.push(`parent after ${route} ${path.join('/')}`);
      }),
  );

  expect(text(seen)).toBe('Cached');
  expect(order).toEqual(['parent after chat chat']);
});

test('a catch around a nested entry recovers it with an answer', async () => {
  const paths: unknown[] = [];
  const deep = motty({ name: 'deep' }).route(() => 'plan', {
    plan: () => {
      throw new UpstreamFailed('Both strong models are down');
    },
  });

  const seen = await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', {
        deep: deep.catch(() => answer('The deep tier is down')),
      })
      .afterHandle(({ path }) => {
        paths.push(path);
      }),
  );

  expect(text(seen)).toBe('The deep tier is down');
  expect(paths).toEqual([['deep']]);
});

test('a catch does not get what its entry derived', async () => {
  const seen: string[][] = [];
  const deep = motty({ name: 'deep' })
    .derive(() => ({ plan: 'Lock order first' }))
    .handle(() => {
      throw new UpstreamFailed('Both strong models are down');
    });

  await told(
    motty({ name: 'tiers' }).route(() => 'deep', {
      deep: deep.catch((_thrown, context) => {
        seen.push(Object.keys(context));
        return answer('The deep tier is down');
      }),
    }),
  );

  expect(seen).toEqual([['request', 'prompt', 'signal', 'calls', 'path']]);
});

test('a catch that takes one kind of error passes the rest on', async () => {
  const caught: unknown[] = [];
  const deep = motty({ name: 'deep' }).handle(() => {
    throw new UpstreamFailed('Both strong models are down');
  });

  const seen = await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', {
        deep: deep.catch((thrown) =>
          thrown instanceof RouteLoop ? answer('Went in a circle') : undefined,
        ),
      })
      .onError((thrown) => {
        caught.push(thrown);
        return answer('Nothing is available');
      }),
  );

  expect(caught[0]).toBeInstanceOf(UpstreamFailed);
  expect(text(seen)).toBe('Nothing is available');
});

test("a catch may reroute within the parent's table", async () => {
  const routes: string[] = [];
  const deep = motty({ name: 'deep' }).handle(() => {
    throw new UpstreamFailed('Both strong models are down');
  });

  const seen = await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', {
        deep: deep.catch(() => reroute('standard')),
        standard: () => answer('From the standard tier'),
      })
      .afterHandle(({ route }) => {
        routes.push(route);
      }),
  );

  expect(text(seen)).toBe('From the standard tier');
  expect(routes).toEqual(['standard']);
});

test("a catch that throws passes what it threw to the parent's boundary", async () => {
  const caught: unknown[] = [];
  const deep = motty({ name: 'deep' }).handle(() => {
    throw new UpstreamFailed('Both strong models are down');
  });

  const seen = await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', {
        deep: deep.catch(() => {
          throw new RangeError('The fallback broke too');
        }),
      })
      .onError((thrown) => {
        caught.push(thrown);
        return answer('Nothing is available');
      }),
  );

  expect(caught[0]).toBeInstanceOf(RangeError);
  expect(text(seen)).toBe('Nothing is available');
});

test("a nested boundary that returns nothing passes the same error to the parent's", async () => {
  const seen: unknown[] = [];
  const deep = motty({ name: 'deep' })
    .handle(() => {
      throw new UpstreamFailed('Both strong models are down');
    })
    .onError((thrown) => {
      seen.push(thrown);
    });

  await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', { deep })
      .onError((thrown) => {
        seen.push(thrown);
      }),
  );

  expect(seen[0]).toBeInstanceOf(UpstreamFailed);
  expect(seen[1]).toBe(seen[0]);
});

test("a nested boundary that throws passes what it threw to the parent's", async () => {
  const caught: unknown[] = [];
  const deep = motty({ name: 'deep' })
    .handle(() => {
      throw new UpstreamFailed('Both strong models are down');
    })
    .onError(() => {
      throw new RangeError('The fallback broke too');
    });

  await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', { deep })
      .onError((thrown) => {
        caught.push(thrown);
      }),
  );

  expect(caught[0]).toBeInstanceOf(RangeError);
});

test("a nested motty's own boundary recovers before the catch is asked", async () => {
  const asked: string[] = [];
  const deep = motty({ name: 'deep' })
    .handle(() => {
      throw new UpstreamFailed('Both strong models are down');
    })
    .onError(() => {
      asked.push('boundary');
      return answer('Recovered inside');
    });

  const seen = await told(
    motty({ name: 'tiers' }).route(() => 'deep', {
      deep: deep.catch(() => {
        asked.push('catch');
        return answer('Recovered outside');
      }),
    }),
  );

  expect(text(seen)).toBe('Recovered inside');
  expect(asked).toEqual(['boundary']);
});

test('a nested motty starts from the prompt as its parent left it', async () => {
  const host = stubHost({ 'acme/large': says('Done') });
  const deep = motty({ name: 'deep' }).handle(({ prompt }) =>
    model('acme/large').complete(prompt),
  );

  await told(
    motty({ name: 'tiers' })
      .beforeHandle(({ prompt }) => {
        prompt.messages = [{ role: 'user', text: 'Compacted' }];
      })
      .route(() => 'deep', { deep }),
    host,
  );

  expect(host.sent('acme/large')[0]?.messages).toEqual([
    { role: 'user', text: 'Compacted' },
  ]);
});

test('a value derived in a nested motty stays out of its parent', async () => {
  const seen: boolean[] = [];
  const deep = motty({ name: 'deep' })
    .derive(() => ({ plan: 'Check the lock order' }))
    .handle(({ plan }) => answer(plan));

  await told(
    motty({ name: 'tiers' })
      .route(() => 'deep', { deep })
      .afterHandle((context) => {
        seen.push('plan' in context);
      }),
  );

  expect(seen).toEqual([false]);
});

test("a message edited in place in a nested motty does not reach its parent's reroute", async () => {
  const seen: unknown[] = [];
  const deep = motty({ name: 'deep' })
    .beforeHandle(({ prompt }) => {
      const [first] = prompt.messages;
      if (first?.text !== undefined) first.text = 'Follow this plan';
    })
    .handle(() => {
      throw new UpstreamFailed('Both strong models are down');
    });

  await told(
    motty({ name: 'tiers' }).route(() => 'deep', {
      deep: deep.catch(() => reroute('standard')),
      standard: ({ prompt }) => {
        seen.push(prompt.messages[0]?.text);
        return answer('Done');
      },
    }),
  );

  expect(seen).toEqual(['Why does this deadlock?']);
});

test("a nested motty's early answer skips only its own afterResponse that follows a derive never run, and none of the parent's", async () => {
  const ran: string[] = [];
  const done = Promise.withResolvers<void>();
  const tiers = motty({ name: 'tiers' })
    .beforeHandle(() => answer('Cached'))
    .afterResponse(() => {
      ran.push('nested, after the early answer');
    })
    .derive(() => ({ tenant: 'acme' }))
    .handle(() => answer('From the nested motty'))
    .afterResponse(({ tenant }) => {
      ran.push(`nested, after the derive ${tenant}`);
    });

  await told(
    motty({ name: 'coder' })
      .afterResponse(() => {
        ran.push('parent, first');
      })
      .route(() => 'chat', { chat: tiers })
      .afterResponse(({ route }) => {
        ran.push(`parent, after the route ${route}`);
        done.resolve();
      }),
  );
  await done.promise;

  expect(ran).toEqual([
    'nested, after the early answer',
    'parent, first',
    'parent, after the route chat',
  ]);
});

test("a nested reroute to a name only the parent's table has fails with UnknownRoute", async () => {
  const caught: unknown[] = [];
  const tiers = motty({ name: 'tiers' }).route(() => 'quick', {
    quick: () => reroute('standard' as never),
  });

  const seen = await told(
    motty({ name: 'coder' })
      .route(() => 'chat', {
        chat: tiers,
        standard: () => answer('From the parent standard'),
      })
      .onError((thrown) => {
        caught.push(thrown);
      }),
  );

  expect(caught[0]).toBeInstanceOf(UnknownRoute);
  expect(seen).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'unknown_route',
        message: 'The route of the motty "tiers" has no entry named "standard"',
      },
    },
  ]);
});

test('a part used by the parent and by the nested entry runs its hook once on that path', async () => {
  const ran: string[] = [];
  const tenant = motty({ name: 'tenant' }).derive(() => {
    ran.push('tenant');
    return { tenant: 'acme' };
  });
  const deep = motty({ name: 'deep' })
    .use(tenant)
    .handle(({ tenant }) => answer(tenant));

  const seen = await told(
    motty({ name: 'coder' })
      .use(tenant)
      .route(() => 'deep', { deep }),
  );

  expect(text(seen)).toBe('acme');
  expect(ran).toEqual(['tenant']);
});

test('of two unrelated parts with one name and seed, the parent one is applied and the nested entry reads its value', async () => {
  const ran: string[] = [];
  const theirs = motty({ name: 'tenant' }).derive(() => {
    ran.push('theirs');
    return { tenant: 'theirs' };
  });
  const ours = motty({ name: 'tenant' }).derive(() => {
    ran.push('ours');
    return { tenant: 'ours' };
  });
  const deep = motty({ name: 'deep' })
    .use(ours)
    .handle(({ tenant }) => answer(tenant));

  const seen = await told(
    motty({ name: 'coder' })
      .use(theirs)
      .route(() => 'deep', { deep }),
  );

  expect(text(seen)).toBe('theirs');
  expect(ran).toEqual(['theirs']);
});

test('a part seeded one way by the parent and another by the nested entry runs in both, and the entry reads its own', async () => {
  const ran: number[] = [];
  const quota = (seed: number) =>
    motty({ name: 'quota', seed }).derive(() => {
      ran.push(seed);
      return { quota: seed };
    });
  const deep = motty({ name: 'deep' })
    .use(quota(2))
    .handle(({ quota }) => answer(`${quota}`));

  const seen = await told(
    motty({ name: 'coder' })
      .use(quota(1))
      .route(() => 'deep', { deep })
      .afterHandle(async ({ quota, answer }) => {
        ran.push(quota + Number(await answer.text()));
      }),
  );

  expect(text(seen)).toBe('2');
  expect(ran).toEqual([1, 2, 3]);
});
