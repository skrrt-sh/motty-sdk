import { expect, test } from 'bun:test';
import { type Base, chain, type Motty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { reroute } from '../../src/chain/route.ts';
import { contractOf } from '../../src/chain/run.ts';
import { mark } from '../../src/contract.ts';
import type { Chunk } from '../../src/data/event.ts';
import type {
  ChatRequest,
  Json,
  Message,
  Prompt,
} from '../../src/data/message.ts';
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

test('use returns a new motty and leaves the receiver unchanged', () => {
  const root = motty({ name: 'root' });
  const added = root.use(motty({ name: 'part' }));

  expect(added).not.toBe(root);
  expect(root[chain].steps).toEqual([]);
  expect(root[chain].parts.size).toBe(0);
  expect(added[chain].steps.map((step) => step.kind)).toEqual(['use']);
});

test('the same name and seed is the same part', () => {
  expect(motty({ name: 'auth', seed: { realm: 'a' } })[chain].identity).toBe(
    motty({ name: 'auth', seed: { realm: 'a' } })[chain].identity,
  );
  expect(motty({ name: 'auth' })[chain].identity).toBe(auth()[chain].identity);
});

test.each([[{ name: 'auth', seed: { realm: 'b' } }], [{ name: 'auth' }]])(
  '%j is another part than auth seeded with realm a',
  (options) => {
    expect(motty(options)[chain].identity).not.toBe(
      motty({ name: 'auth', seed: { realm: 'a' } })[chain].identity,
    );
  },
);

test('the order of the keys of a seed does not change the part', () => {
  expect(
    motty({
      name: 'auth',
      seed: { realm: 'a', scopes: [{ read: 1, write: 2 }] },
    })[chain].identity,
  ).toBe(
    motty({
      name: 'auth',
      seed: { scopes: [{ write: 2, read: 1 }], realm: 'a' },
    })[chain].identity,
  );
});

test('the order of the items of a seed changes the part', () => {
  expect(motty({ name: 'auth', seed: ['a', 'b'] })[chain].identity).not.toBe(
    motty({ name: 'auth', seed: ['b', 'a'] })[chain].identity,
  );
});

test.each([
  [{ name: 'a"b"' }, { name: 'a', seed: 'b' }],
  [
    { name: 'a', seed: '1' },
    { name: 'a', seed: 1 },
  ],
  [
    { name: 'a', seed: [] },
    { name: 'a', seed: {} },
  ],
  [{ name: 'a', seed: null }, { name: 'a' }],
])('%j and %j are two parts', (one, other) => {
  expect(motty(one)[chain].identity).not.toBe(motty(other)[chain].identity);
});

test('a seed that is not plain JSON data is refused', () => {
  const cycle: Json[] = [];
  cycle.push({ self: cycle });
  const shared = { realm: 'a' };

  expect(() => motty({ name: 'auth', seed: Number.NaN })).toThrow(
    'The seed of the motty "auth" must be plain JSON data',
  );
  expect(() => motty({ name: 'auth', seed: cycle })).toThrow('with no cycle');
  expect(() =>
    // @ts-expect-error
    motty({ name: 'auth', seed: new Date(0) }),
  ).toThrow('must be plain JSON data');
  expect(motty({ name: 'auth', seed: [shared, shared] })[chain].identity).toBe(
    '["auth",[{"realm":"a"},{"realm":"a"}]]',
  );
});

test('a name that is missing or empty is refused', () => {
  expect(() => motty({ name: '' })).toThrow('A motty needs a name');
  expect(() =>
    // @ts-expect-error
    motty(),
  ).toThrow('A motty needs a name');
});

test('the parts of a used part are merged into its user, each once', () => {
  expect([...coder[chain].parts.keys()].sort()).toEqual(
    [auth(), compaction, emptyPrompt, hiddenReasoning, offTopic, tuning]
      .map((part) => part[chain].identity)
      .sort(),
  );
  expect(coder[chain].parts.get(tuning[chain].identity)).toBe(tuning[chain]);
});

test('a part made again by its function with the same seed is one part', () => {
  const twice = motty({ name: 'root' })
    .use(auth())
    .use(motty({ name: 'billing' }).use(auth()));

  expect([...twice[chain].parts.keys()]).toEqual(['["auth"]', '["billing"]']);
});

test('two different parts grown from one motty are refused together', () => {
  const base = motty({ name: 'base' });
  const one = base.derive(() => ({ tenant: 'acme' }));
  const two = base.derive(() => ({ tenant: 'other' }));

  expect(() => motty({ name: 'root' }).use(one).use(two)).toThrow(
    'Two different parts share the name "base" and its seed',
  );
  expect(() =>
    motty({ name: 'root' })
      .use(motty({ name: 'first' }).use(one))
      .use(motty({ name: 'second' }).use(two)),
  ).toThrow('Two different parts share the name "base" and its seed');
});

test('two different parts grown from one motty are refused through a route, in one entry or in two', () => {
  const base = motty({ name: 'base' });
  const one = base.derive(() => ({ tenant: 'acme' }));
  const two = base.derive(() => ({ tenant: 'other' }));

  expect(() =>
    motty({ name: 'root' })
      .use(one)
      .route(() => 'chat', {
        chat: motty({ name: 'chat' })
          .use(two)
          .handle(() => answer('Hi')),
      }),
  ).toThrow(
    new Error(
      'Two different parts share the name "base" and its seed: use one part everywhere, or make each from its own motty() call',
    ),
  );
  expect(() =>
    motty({ name: 'root' }).route(() => 'quick', {
      quick: motty({ name: 'quick' })
        .use(one)
        .handle(() => answer('Hi')),
      deep: motty({ name: 'deep' })
        .use(two)
        .handle(() => answer('Hi')),
    }),
  ).toThrow('Two different parts share the name "base" and its seed');
  expect(() =>
    motty({ name: 'outer' })
      .use(two)
      .use(
        motty({ name: 'root' }).route(() => 'chat', {
          chat: motty({ name: 'chat' })
            .use(one)
            .handle(() => answer('Hi')),
        }),
      ),
  ).toThrow('Two different parts share the name "base" and its seed');
});

test('one part used by a motty and by the entries it routes to is one part', () => {
  const one = motty({ name: 'base' }).derive(() => ({ tenant: 'acme' }));
  const routed = motty({ name: 'root' })
    .use(one)
    .use(auth())
    .route(() => 'quick', {
      quick: motty({ name: 'quick' })
        .use(one)
        .use(auth())
        .handle(() => answer('Hi')),
      deep: motty({ name: 'deep' })
        .use(one)
        .use(auth())
        .handle(() => answer('Hi')),
    });

  expect([...routed[chain].parts.keys()]).toEqual(['["base"]', '["auth"]']);
  expect(routed[chain].parts.get('["base"]')).toBe(one[chain]);
});

test('a part with the name and seed of its user is refused', () => {
  const root = motty({ name: 'root', seed: { realm: 'a' } });

  expect(() => root.use(motty({ name: 'root', seed: { realm: 'a' } }))).toThrow(
    'The motty "root" cannot use a part with its own name and seed',
  );
  expect(() =>
    root.use(
      motty({ name: 'wrapper' }).use(
        motty({ name: 'root', seed: { realm: 'a' } }),
      ),
    ),
  ).toThrow('cannot use a part with its own name and seed');
  expect(root.use(motty({ name: 'root' }))[chain].parts.size).toBe(1);
});

test('after hooks may follow the answer', () => {
  const observed = deep
    .afterHandle(() => {})
    .afterResponse(() => {})
    .onError(() => {});

  expect(observed[chain].steps).toHaveLength(6);
});

test('a second way to answer is refused when it is added', () => {
  expect(() =>
    // @ts-expect-error
    structured.route(() => 'only', { only: () => complete({ messages: [] }) }),
  ).toThrow('already answers');
  expect(() =>
    motty({ name: 'root' })
      .use(deep)
      // @ts-expect-error
      .use(structured),
  ).toThrow('already answers');
});

test('a before hook or a part after the answer is refused', () => {
  expect(() =>
    // @ts-expect-error
    deep.derive(() => ({ tenant: 'acme' })),
  ).toThrow('Only after hooks follow');
  expect(() =>
    // @ts-expect-error
    deep.use(emptyPrompt),
  ).toThrow('Only after hooks follow');
  expect(() =>
    motty({ name: 'root' })
      .use(deep)
      // @ts-expect-error
      .beforeHandle(() => {}),
  ).toThrow('Only after hooks follow');
});

test('an entry that is a motty without an answer is refused', () => {
  expect(() =>
    // @ts-expect-error
    motty({ name: 'root' }).route(() => 'only', { only: emptyPrompt }),
  ).toThrow('has no route or handle');
  expect(() =>
    motty({ name: 'root' }).route(() => 'only', {
      // @ts-expect-error
      only: emptyPrompt.catch(() => canned('Nothing answered.')),
    }),
  ).toThrow('The entry "only" is the motty "empty-prompt", which has no');
});

test('an empty table is refused', () => {
  expect(() =>
    // @ts-expect-error
    motty({ name: 'root' }).route(() => 'only', {}),
  ).toThrow('A route of the motty "root" needs at least one entry');
});

test('an entry named by a symbol is refused', () => {
  const hidden = Symbol('hidden');

  expect(() =>
    motty({ name: 'root' }).route(() => 'only', {
      only: ({ prompt }) => complete(prompt),
      // @ts-expect-error
      [hidden]: ({ prompt }: { prompt: Prompt }) => complete(prompt),
    }),
  ).toThrow('An entry of the motty "root" is named by a symbol');
});

test('an entry named by a number is named by its string form', () => {
  const routed = motty({ name: 'routed' })
    .route(({ request }) => (request.output ? '1' : '2'), {
      1: ({ prompt }) => complete(prompt).catch(() => reroute('2')),
      2: deep,
    })
    .afterHandle(({ route, path }) => {
      const entry: '1' | '2' = route;
      const entries: readonly ['1'] | readonly ['2'] = path;
      note(`${entry} ${entries.join('/')}`);
    });
  const route = routed[chain].steps.find((step) => step.kind === 'route');

  expect(Object.keys(route?.table ?? {})).toEqual(['1', '2']);
});

test.each([
  [
    'derive',
    // @ts-expect-error
    (root: Motty<Base>) => root.derive({ tenant: 'acme' }),
  ],
  [
    'catch',
    // @ts-expect-error
    (root: Motty<Base>) => root.catch(reroute('standard')),
  ],
] as const)('a %s that is not a function is refused', (what, add) => {
  expect(() => add(motty({ name: 'root' }))).toThrow(
    `The ${what} of the motty "root" must be a function`,
  );
});

test('an entry that is neither a handler nor a motty is refused', () => {
  expect(() =>
    // @ts-expect-error
    motty({ name: 'root' }).route(() => 'only', { only: 7 }),
  ).toThrow(
    'The entry "only" of the motty "root" must be a handler function, a motty or a motty with a catch',
  );
  expect(() =>
    motty({ name: 'root' }).route(() => 'only', {
      // @ts-expect-error
      only: { entry: deep, recover: 'standard' },
    }),
  ).toThrow('The catch of the motty "deep" must be a function');
  expect(() =>
    // @ts-expect-error
    motty({ name: 'root' }).route(() => 'only', null),
  ).toThrow('needs at least one entry');
});

test('using something that is not a motty is refused', () => {
  expect(() =>
    // @ts-expect-error
    motty({ name: 'root' }).use({ name: 'part' }),
  ).toThrow('The motty "root" can use only another motty');
});

test('a part built by another copy of the SDK is refused with what to do', async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/../../src/index.ts`],
    target: 'bun',
  });
  const copy: typeof import('../../src/index.ts') = await import(
    URL.createObjectURL(new Blob([(await bundle.outputs[0]?.text()) ?? '']))
  );
  const part = copy.motty({ name: 'auth' }).beforeHandle(() => {});
  const module = copy.motty({ name: 'deep' }).handle(() => copy.answer('Deep'));

  expect(() => motty({ name: 'root' }).use(part)).toThrow(
    'The motty "root" was given a part built by another copy of @mottyjs/core. A plugin must list @mottyjs/core as a peer dependency, so that one copy is installed',
  );
  expect(() =>
    motty({ name: 'root' }).route(() => 'only', { only: module }),
  ).toThrow(
    'The entry "only" of the motty "root" is a motty built by another copy of @mottyjs/core. A plugin must list',
  );
  expect(() =>
    motty({ name: 'root' }).route(() => 'only', {
      only: module.catch(() => canned('Down.')),
    }),
  ).toThrow('is a motty built by another copy of @mottyjs/core');
});

test('the mark gives the one contract of the motty on every read', () => {
  const served = motty({ name: 'root' }).handle(() => answer('Handled'));

  expect(served[mark]).toBe(served[mark]);
  expect(served[mark]).toBe(contractOf(served));
});

test('the mark of a frozen motty cannot be given another contract', () => {
  const served = motty({ name: 'root' }).handle(() => answer('Handled'));
  const other = motty({ name: 'other' }).handle(() => answer('Other'));

  expect(Object.isFrozen(served)).toBe(true);
  expect(() => {
    // @ts-expect-error
    served[mark] = other[mark];
  }).toThrow(TypeError);
  expect(() =>
    Object.defineProperty(served, mark, { value: other[mark] }),
  ).toThrow(TypeError);
  expect(served[mark]).toBe(contractOf(served));
});
