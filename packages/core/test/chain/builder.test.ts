import { expect, test } from 'bun:test';
import {
  type AnsweringMotty,
  type AnyMotty,
  chain,
  type Motty,
} from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { reroute } from '../../src/chain/route.ts';
import {
  type Contract,
  isMarked,
  type Marked,
  mark,
} from '../../src/contract.ts';
import type { Chunk } from '../../src/data/event.ts';
import type { ChatRequest, Message, Prompt } from '../../src/data/message.ts';
import { type Answer, answer } from '../../src/request/answer.ts';

declare function complete(prompt: Prompt): Promise<Answer>;
declare function canned(reply: string | AsyncIterable<Chunk>): Answer;
declare function note(line: string): void;
declare function withPlan(prompt: Prompt): Promise<Message[]>;
declare function previousTier(
  request: ChatRequest,
): Promise<'quick' | 'standard' | 'deep' | undefined>;
declare function tierOf(
  request: ChatRequest,
  settings: { quickQuestionChars: number; deepProbability: number },
  previous?: 'quick' | 'standard' | 'deep',
): Promise<'quick' | 'standard' | 'deep'>;
declare function remember(
  request: ChatRequest,
  tier: 'quick' | 'standard' | 'deep',
  settings: { remembered: number },
): Promise<void>;
declare function sizeOf(
  request: ChatRequest,
  settings: { smallProbability: number },
): Promise<'small' | 'strong'>;

const tuning = motty({ name: 'settings' }).derive(() => ({
  settings: {
    compaction: { longThreadMessages: 80, keptMessages: 12 },
    offTopic: { onTopicProbability: 0.1 },
    tiers: {
      quickQuestionChars: 400,
      deepProbability: 0.35,
      remembered: 86_400_000,
    },
    structured: { smallProbability: 0.7 },
    deep: { firstChunk: 20_000 },
  },
}));

function auth() {
  return motty({ name: 'auth' }).derive(({ request }) => ({
    caller: { id: request.headers.get('x-caller') ?? 'tester' },
  }));
}

const emptyPrompt = motty({ name: 'empty-prompt' }).beforeHandle(
  ({ request }) => {
    if (request.messages.length === 0) throw new Error('No messages');
  },
);

const offTopic = motty({ name: 'off-topic' })
  .use(tuning)
  .beforeHandle(async ({ request, settings }) => {
    const threshold: number = settings.offTopic.onTopicProbability;
    return request.messages.length < threshold
      ? canned('I only answer questions about software and codebases.')
      : undefined;
  });

const compaction = motty({ name: 'compaction' })
  .use(tuning)
  .beforeHandle(async ({ prompt, settings }) => {
    const { messages } = prompt;
    const { longThreadMessages, keptMessages } = settings.compaction;
    if (messages.length <= longThreadMessages) return;

    const reply = await complete({ messages });
    prompt.messages = [
      { role: 'system', text: await reply.text() },
      ...messages.slice(-keptMessages),
    ];
  });

const hiddenReasoning = motty({ name: 'hidden-reasoning' }).afterHandle(
  (ctx) => {
    ctx.answer = canned(ctx.answer.chunks());
  },
);

const deep = motty({ name: 'deep' })
  .use(tuning)
  .beforeHandle(async ({ prompt }) => {
    prompt.messages = await withPlan(prompt);
    prompt.options = { ...prompt.options, reasoning: { effort: 'high' } };
  })
  .handle(({ prompt, settings }) => {
    const firstChunk: number = settings.deep.firstChunk;
    return complete({ ...prompt, options: { maxTokens: firstChunk } });
  });

const tiers = motty({ name: 'tiers' })
  .use(tuning)
  .derive(async ({ request }) => ({ previous: await previousTier(request) }))
  .route(
    ({ request, settings, previous }) => {
      const deepProbability: number = settings.tiers.deepProbability;
      const remembered: 'quick' | 'standard' | 'deep' | undefined = previous;
      return tierOf(
        request,
        { ...settings.tiers, deepProbability },
        remembered,
      );
    },
    {
      quick: ({ prompt }) => complete(prompt).catch(() => reroute('standard')),
      standard: ({ prompt }) => complete(prompt),
      deep: deep.catch(() => reroute('standard')),
    },
  )
  .afterResponse(({ request, route, outcome, settings }) => {
    if (outcome === 'completed') {
      const tier: 'quick' | 'standard' | 'deep' = route;
      return remember(request, tier, settings.tiers);
    }
    return undefined;
  });

const structured = motty({ name: 'structured' })
  .use(tuning)
  .route(({ request, settings }) => sizeOf(request, settings.structured), {
    small: ({ prompt }) => complete(prompt).catch(() => reroute('strong')),
    strong: ({ prompt }) => complete(prompt),
  });

const coder = motty({ name: 'coder' })
  .use(auth())
  .use(emptyPrompt)
  .use(offTopic)
  .use(compaction)
  .use(hiddenReasoning)
  .route(({ request }) => (request.output ? 'structured' : 'chat'), {
    structured,
    chat: tiers,
  });

test('a function that makes a part, used without being called, does not compile', () => {
  const root = motty({ name: 'root' });
  const sentence: Parameters<typeof root.use<typeof auth>>[0] =
    'A function that makes a part is called first: use(part())';

  expect(() =>
    // @ts-expect-error
    root.use(auth),
  ).toThrow('can use only another motty');
  expect(root.use(auth())[chain].steps).toHaveLength(1);
  expect(sentence).toContain('use(part())');
});

test('an entry that returns nothing does not compile', () => {
  const routed = motty({ name: 'routed' }).route(() => 'small', {
    // @ts-expect-error
    small: ({ prompt }) => {
      complete(prompt);
    },
    // @ts-expect-error
    strong: async ({ prompt }) => {
      await complete(prompt);
    },
  });

  expect(routed[chain].answers).toBe(true);
});

test('a hook before the answer sees a route that may be absent and any path', () => {
  const observed = motty({ name: 'observed' })
    .afterHandle(({ route, path }) => {
      const entry: string | undefined = route;
      const entries: readonly string[] = path;
      note(`${entry} ${entries.join('/')}`);
    })
    .afterResponse((ctx) => {
      const entries: readonly string[] = ctx.path;
      if (ctx.outcome === 'completed') {
        const entry: string | undefined = ctx.route;
        note(`${entry} ${entries.join('/')}`);
      }
    });

  expect(observed[chain].answers).toBe(false);
});

test('a hook before the answer reading its route as always there does not compile', () => {
  const observed = motty({ name: 'observed' })
    .afterHandle(({ route }) => {
      // @ts-expect-error
      note(route);
    })
    .afterResponse((ctx) => {
      // @ts-expect-error
      if (ctx.outcome === 'completed') note(ctx.route);
    });

  expect(observed[chain].answers).toBe(false);
});

test('a hook after a route is promised the entry that answered', () => {
  const observed = motty({ name: 'observed' })
    .use(motty({ name: 'audit' }).afterHandle(({ route }) => note(`${route}`)))
    .route(() => 'only', { only: ({ prompt }) => complete(prompt) })
    .afterHandle(({ route, path }) => {
      const entry: 'only' = route;
      const entries: readonly ['only'] = path;
      note(`${entry} ${entries.length}`);
    })
    .afterResponse((ctx) => {
      if (ctx.outcome === 'completed') {
        const entry: 'only' = ctx.route;
        note(entry);
      }
    });

  expect(observed[chain].answers).toBe(true);
});

test('a hook after a handle sees no route and an empty path', () => {
  const observed = deep.afterHandle(({ route, path }) => {
    const entry: undefined = route;
    const entries: readonly [] = path;
    note(`${entry} ${entries.length}`);
  });

  expect(observed[chain].answers).toBe(true);
});

test('the root sees every used part, its entries and the nested paths', () => {
  const observed = coder
    .afterHandle(({ route, path, caller, settings }) => {
      const entry: 'structured' | 'chat' = route;
      const entries:
        | readonly ['structured']
        | readonly ['structured', 'small']
        | readonly ['structured', 'strong']
        | readonly ['chat']
        | readonly ['chat', 'quick']
        | readonly ['chat', 'standard']
        | readonly ['chat', 'deep'] = path;
      const id: string = caller.id;
      const kept: number = settings.compaction.keptMessages;
      note(`${entry} ${entries.join('/')} ${id} ${kept}`);
    })
    .afterResponse((ctx) => {
      const outcome: 'completed' | 'aborted' | 'failed' = ctx.outcome;
      const input: number | undefined = ctx.calls.total.input;
      note(`${outcome} ${input}`);
      if (ctx.outcome === 'completed') {
        const entry: 'structured' | 'chat' = ctx.route;
        const reply: Answer = ctx.answer;
        note(`${entry} ${reply === ctx.answer}`);
        return;
      }
      const entry: 'structured' | 'chat' | undefined = ctx.route;
      const reply: Answer | undefined = ctx.answer;
      const entries: readonly string[] = ctx.path;
      note(`${entry} ${reply === undefined} ${entries.length}`);
    })
    .onError((thrown, { request, caller }) =>
      thrown instanceof Error
        ? canned(`${caller?.id ?? request.id}: ${thrown.message}`)
        : undefined,
    );

  expect(observed[chain].steps.map((step) => step.kind)).toEqual([
    'use',
    'use',
    'use',
    'use',
    'use',
    'route',
    'afterHandle',
    'afterResponse',
    'onError',
  ]);
});

test('a chooser naming an entry the table lacks does not compile', () => {
  const routed = motty({ name: 'routed' })
    // @ts-expect-error
    .route(({ request }) => (request.output ? 'small' : 'huge'), {
      small: ({ prompt }) => complete(prompt),
      strong: ({ prompt }) => complete(prompt),
    });

  expect(routed[chain].answers).toBe(true);
});

test('a handler rerouting outside its table does not compile', () => {
  const routed = motty({ name: 'routed' }).route(() => 'small', {
    // @ts-expect-error
    small: ({ prompt }) => complete(prompt).catch(() => reroute('huge')),
    strong: ({ prompt }) => complete(prompt),
  });

  expect(routed[chain].answers).toBe(true);
});

test('a catch rerouting outside the parent table does not compile', () => {
  const routed = motty({ name: 'routed' }).route(() => 'deep', {
    strong: ({ prompt }) => complete(prompt),
    // @ts-expect-error
    deep: deep.catch(() => reroute('standard')),
  });

  expect(routed[chain].answers).toBe(true);
});

test('a route narrowed to fewer entries than the table does not compile', () => {
  const routed = structured.afterResponse(({ route, outcome }) => {
    if (outcome === 'completed') {
      // @ts-expect-error
      const entry: 'small' = route;
      note(entry);
    }
  });

  expect(routed[chain].answers).toBe(true);
});

test('a value no part derived does not compile', () => {
  const underived = motty({ name: 'underived' })
    .use(emptyPrompt)
    // @ts-expect-error settings come only with the part that derives them
    .beforeHandle(({ settings }) => note(String(settings)));

  expect(underived[chain].steps).toHaveLength(2);
});

test('a failure may come before a derived value exists', () => {
  const observed = coder
    .onError(
      (_thrown, { request, prompt, signal, calls, caller, settings }) => {
        const id: string | undefined = caller?.id;
        const kept: number | undefined = settings?.compaction.keptMessages;
        // @ts-expect-error
        const always: { id: string } = caller;
        // @ts-expect-error
        const threshold: number = settings.offTopic.onTopicProbability;
        note(
          `${id} ${kept} ${always} ${threshold} ${request.id} ${signal.aborted}`,
        );
        note(`${prompt.messages.length} ${calls.total.input}`);
      },
    )
    .afterResponse((ctx) => {
      if (ctx.outcome === 'completed') {
        const id: string = ctx.caller.id;
        note(id);
        return;
      }
      const id: string | undefined = ctx.caller?.id;
      // @ts-expect-error
      const kept: number = ctx.settings.compaction.keptMessages;
      note(`${id} ${kept} ${ctx.request.id} ${ctx.calls.total.input}`);
    });

  expect(observed[chain].steps).toHaveLength(8);
});

test('a request that did not complete may have no route and no answer', () => {
  const observed = structured.afterResponse((ctx) => {
    if (ctx.outcome === 'completed') {
      // @ts-expect-error
      ctx.answer = canned('Rewritten too late.');
      return;
    }
    // @ts-expect-error
    const entry: 'small' | 'strong' = ctx.route;
    // @ts-expect-error
    const reply: Answer = ctx.answer;
    // @ts-expect-error
    const entries: readonly ['small'] | readonly ['strong'] = ctx.path;
    // @ts-expect-error
    const never: 'completed' = ctx.outcome;
    note(`${entry} ${reply} ${entries} ${never}`);
  });

  expect(observed[chain].answers).toBe(true);
});

test('an entry that is a motty may answer before its own entries', () => {
  const observed = coder.afterHandle(({ path }) => {
    // @ts-expect-error
    const entries:
      | readonly ['structured', 'small' | 'strong']
      | readonly ['chat', 'quick' | 'standard' | 'deep'] = path;
    // @ts-expect-error
    const empty: readonly [] = path;
    note(`${entries} ${empty}`);
  });
  const caught = motty({ name: 'caught' })
    .route(() => 'chat', {
      chat: tiers.catch(() => reroute('plain')),
      plain: ({ prompt }) => complete(prompt),
    })
    .afterHandle(({ path }) => {
      const entries:
        | readonly ['plain']
        | readonly ['chat']
        | readonly ['chat', 'quick' | 'standard' | 'deep'] = path;
      // @ts-expect-error
      const inner: readonly ['plain'] | readonly ['chat', string] = path;
      note(`${entries} ${inner}`);
    });

  expect(observed[chain].answers).toBe(true);
  expect(caught[chain].answers).toBe(true);
});

test('a handler sees the values derived before its table', () => {
  const routed = motty({ name: 'routed' })
    .use(tuning)
    .derive(() => ({ tenant: 'acme' }))
    .route(() => 'only', {
      only: ({ prompt, settings, tenant }) => {
        const firstChunk: number = settings.deep.firstChunk;
        const named: string = tenant;
        note(`${firstChunk} ${named}`);
        return complete(prompt);
      },
      // @ts-expect-error
      other: ({ prompt, caller }) => complete({ ...prompt, user: caller }),
    });

  expect(routed[chain].answers).toBe(true);
});

test('a used part replaces a value derived before it, with its own type', () => {
  const overridden = motty({ name: 'overridden' })
    .derive(() => ({ caller: 'anonymous' }))
    .use(auth())
    .beforeHandle(({ caller }) => {
      const id: string = caller.id;
      // @ts-expect-error
      const earlier: string = caller;
      note(`${id} ${earlier}`);
    });

  expect(overridden[chain].steps).toHaveLength(3);
});

test('a derive cannot take the name of a value a used part or an earlier derive made', () => {
  const refused = [
    motty({ name: 'parent' })
      .use(tuning)
      // @ts-expect-error
      .derive(() => ({ settings: 42 })),
    motty({ name: 'parent' })
      .use(motty({ name: 'wrapper' }).use(auth()))
      // @ts-expect-error
      .derive(() => ({ tenant: 'acme', caller: 'anonymous' })),
    motty({ name: 'twice' })
      .derive(() => ({ tenant: 7, region: 'eu' }))
      // @ts-expect-error
      .derive(() => ({ tenant: { id: 'acme' } })),
  ];
  const kept = motty({ name: 'parent' })
    .use(tuning)
    .derive(({ settings }) => ({ kept: settings.compaction.keptMessages }))
    .beforeHandle(({ settings, kept }) => {
      const messages: number = settings.compaction.keptMessages + kept;
      note(`${messages}`);
    });

  expect(refused).toHaveLength(3);
  expect(kept[chain].steps).toHaveLength(3);
});

test('a derive that gives one of two shapes written in place, neither with a taken name, is accepted, and so is the derive after it', () => {
  const either = motty({ name: 'either' })
    .derive(() => ({ tenant: 'acme' }))
    .derive(({ tenant }) => (tenant === 'acme' ? { plan: 1 } : { seats: 2 }))
    .derive(() => ({ region: 'eu' }))
    .beforeHandle(({ tenant, plan, seats, region }) => {
      const held: number | undefined = plan ?? seats;
      note(`${tenant} ${held} ${region}`);
    });

  expect(either[chain].steps).toHaveLength(4);
});

test('an afterResponse after a derive holds its value once the request completed, wherever an early answer may have come', () => {
  const cached = motty({ name: 'cached' })
    .beforeHandle(() => canned('Cached.'))
    .derive(() => ({ tenant: 'acme' }))
    .afterResponse((ctx) => {
      if (ctx.outcome === 'completed') {
        const held: string = ctx.tenant;
        note(held);
      } else {
        const maybe: string | undefined = ctx.tenant;
        // @ts-expect-error
        const held: string = ctx.tenant;
        note(`${maybe} ${held}`);
      }
    });

  expect(cached[chain].steps).toHaveLength(3);
});

test('a nested motty reads a value of its parent only through the part that derives it', () => {
  const shared = motty({ name: 'deep' })
    .use(tuning)
    .handle(({ prompt, settings }) => {
      const firstChunk: number = settings.deep.firstChunk;
      note(`${firstChunk}`);
      return complete(prompt);
    });
  const alone = motty({ name: 'alone' })
    // @ts-expect-error
    .handle(({ prompt, settings }) => complete({ ...prompt, user: settings }));
  const parent = motty({ name: 'parent' })
    .use(tuning)
    .route(() => 'shared', { shared, alone });

  expect(parent[chain].answers).toBe(true);
});

test('a derived value cannot take a name the context has', () => {
  const root = motty({ name: 'root' });
  const refused = [
    // @ts-expect-error
    root.derive(() => ({ request: 'mine' })),
    // @ts-expect-error
    root.derive(() => ({ prompt: 'mine' })),
    // @ts-expect-error
    root.derive(() => ({ signal: 'mine' })),
    // @ts-expect-error
    root.derive(() => ({ calls: 'mine' })),
    // @ts-expect-error
    root.derive(() => ({ route: 'mine' })),
    // @ts-expect-error
    root.derive(() => ({ path: 'mine' })),
    // @ts-expect-error
    root.derive(() => ({ answer: 'mine' })),
    // @ts-expect-error
    root.derive(async () => ({ tenant: 'acme', outcome: 'mine' })),
  ];

  expect(refused).toHaveLength(8);
});

test('a derive that does not return an object does not compile', () => {
  const root = motty({ name: 'root' });
  const refused = [
    // @ts-expect-error
    root.derive(() => 'acme'),
    // @ts-expect-error
    root.derive(() => ['acme']),
    // @ts-expect-error
    root.derive(() => undefined),
  ];

  expect(refused).toHaveLength(3);
});

test('a reroute to its own entry does not compile', () => {
  const routed = motty({ name: 'routed' }).route(() => 'small', {
    // @ts-expect-error
    small: ({ prompt }) => complete(prompt).catch(() => reroute('small')),
    strong: ({ prompt }) => complete(prompt),
    // @ts-expect-error
    deep: deep.catch(() => reroute('deep')),
  });

  expect(routed[chain].answers).toBe(true);
});

test('any motty is an AnyMotty', () => {
  const hooksOnly: AnyMotty = emptyPrompt;
  const deriving: AnyMotty = tuning;
  const handled: AnyMotty = deep;
  const routed: AnyMotty = structured;
  const nested: AnyMotty = coder;
  // @ts-expect-error
  const caught: AnyMotty = deep.catch(() => reroute('standard'));

  expect(
    [hooksOnly, deriving, handled, routed, nested].map(
      (any) => any[chain].name,
    ),
  ).toEqual(['empty-prompt', 'settings', 'deep', 'structured', 'coder']);
  expect(chain in caught).toBe(false);
});

test('any motty, finished or not, is held and taken as a Motty', () => {
  const fresh: Motty = motty({ name: 'fresh' });
  const handled: Motty = motty({ name: 'done' }).handle(() => answer('Done'));
  const nameOf = (part: Motty) => part[chain].name;
  const served: Marked = handled;
  // @ts-expect-error
  const caught: Motty = deep.catch(() => reroute('standard'));

  expect(
    [fresh, handled, emptyPrompt, tuning, structured, coder].map(nameOf),
  ).toEqual([
    'fresh',
    'done',
    'empty-prompt',
    'settings',
    'structured',
    'coder',
  ]);
  expect(isMarked(served)).toBe(true);
  expect(chain in caught).toBe(false);
});

test('a motty held as any motty has no builder methods and is no part or entry', () => {
  const held: Motty = deep;
  const root = motty({ name: 'root' });
  const sentence: Parameters<typeof root.use<Motty>>[0] =
    'A part is used with the types it was built with, not held as any motty';
  // @ts-expect-error
  const handle = held.handle;
  // @ts-expect-error
  const used = root.use(held);
  // @ts-expect-error
  const routed = root.route(() => 'only', { only: held });

  expect(handle).toBe(deep.handle);
  expect([used[chain].answers, routed[chain].answers]).toEqual([true, true]);
  expect(sentence).toContain('held as any motty');
});

test('a parameter that names the context and the paths keeps what was built', () => {
  const kept = <Context, Paths extends string[]>(part: Motty<Context, Paths>) =>
    part;
  const observed = kept(structured).afterHandle(({ route, settings }) => {
    const entry: 'small' | 'strong' = route;
    note(`${entry} ${settings.structured.smallProbability}`);
  });

  expect(() =>
    // @ts-expect-error
    kept(structured).handle(() => canned('Twice.')),
  ).toThrow('already answers');
  expect(observed[chain].steps).toHaveLength(3);
});

test('only a motty that answers is an AnsweringMotty', () => {
  const handled: AnsweringMotty = deep;
  const routed: AnsweringMotty = structured;
  const nested: AnsweringMotty = coder;
  const observed: AnsweringMotty = coder.afterHandle(() => {});
  const user: AnsweringMotty = motty({ name: 'root' }).use(deep);
  // @ts-expect-error
  const hooksOnly: AnsweringMotty = emptyPrompt;
  // @ts-expect-error
  const deriving: AnsweringMotty = tuning;
  // @ts-expect-error
  const unanswered: AnsweringMotty = motty({ name: 'root' }).use(auth());

  expect(
    [
      handled,
      routed,
      nested,
      observed,
      user,
      hooksOnly,
      deriving,
      unanswered,
    ].map((answering) => answering[chain].answers),
  ).toEqual([true, true, true, true, true, false, false, false]);
});

test('the mark is typed as the contract', () => {
  const served = motty({ name: 'root' }).handle(() => answer('Handled'));
  const contract: Contract = served[mark];
  // @ts-expect-error
  const wrong: string = served[mark];

  expect<unknown>(wrong).toBe(contract);
});

test('a catch reads what the parent derived and may return nothing', () => {
  const routed = motty({ name: 'routed' })
    .use(auth())
    .route(() => 'deep', {
      strong: ({ prompt }) => complete(prompt),
      deep: deep.catch((thrown, { request, calls, caller }) => {
        const id: string = caller.id;
        note(
          `${id} sent ${request.messages.length}, ${calls.made.length} calls`,
        );
        return thrown instanceof RangeError ? reroute('strong') : undefined;
      }),
    });

  expect(routed[chain].answers).toBe(true);
});

test('an async catch may return nothing', () => {
  const routed = motty({ name: 'routed' }).route(() => 'deep', {
    deep: deep.catch(async () => {}),
  });

  expect(routed[chain].answers).toBe(true);
});

test('a catch reading what only its own entry derived does not compile', () => {
  const routed = motty({ name: 'routed' }).route(() => 'deep', {
    // @ts-expect-error
    deep: deep.catch((_thrown, { settings }) => canned(String(settings))),
  });

  expect(routed[chain].answers).toBe(true);
});

test('a catch made outside a table reads the base context alone', () => {
  const caught = deep.catch((_thrown, context) => {
    note(`${context.request.messages.length}`);
    // @ts-expect-error
    note(context.settings);
  });

  expect(caught.entry).toBe(deep);
});
