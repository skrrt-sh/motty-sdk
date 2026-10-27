import { expect, test } from 'bun:test';
import { version as sdk } from '../../package.json';
import { assemble, type Lifecycle } from '../../src/chain/assemble.ts';
import { chain } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { reroute } from '../../src/chain/route.ts';
import type { Prompt } from '../../src/data/message.ts';
import type { Answer } from '../../src/request/answer.ts';

declare function complete(prompt: Prompt): Promise<Answer>;
declare function canned(reply: string): Answer;

function tableOf(lifecycle: Lifecycle | undefined) {
  return lifecycle?.answer?.kind === 'route' ? lifecycle.answer.table : {};
}

function nestedIn(lifecycle: Lifecycle | undefined, name: string) {
  const entry = tableOf(lifecycle)[name];
  return entry !== undefined && 'lifecycle' in entry
    ? entry.lifecycle
    : undefined;
}

function tenant() {
  return motty({ name: 'tenant' }).derive(() => ({ tenant: 'acme' }));
}

test('before hooks keep registration order, a part inlined at its use', () => {
  const first = () => ({ first: 1 });
  const guard = () => {};
  const partDerive = () => ({ part: 1 });
  const partGuard = () => {};
  const last = () => ({ last: 1 });
  const part = motty({ name: 'part' })
    .derive(partDerive)
    .beforeHandle(partGuard);
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .derive(first)
      .beforeHandle(guard)
      .use(part)
      .derive(last)[chain],
  );

  expect(lifecycle.before.map(({ kind, run }) => [kind, run])).toEqual([
    ['derive', first],
    ['beforeHandle', guard],
    ['derive', partDerive],
    ['beforeHandle', partGuard],
    ['derive', last],
  ]);
});

test('a route is the answering step, with its chooser and its table', () => {
  const choose = (): 'small' | 'strong' => 'small';
  const small = ({ prompt }: { prompt: Prompt }) => complete(prompt);
  const strong = ({ prompt }: { prompt: Prompt }) => complete(prompt);
  const { lifecycle } = assemble(
    motty({ name: 'root' }).route(choose, { small, strong })[chain],
  );

  expect(lifecycle.answer).toEqual({
    kind: 'route',
    choose,
    table: { small: { handler: small }, strong: { handler: strong } },
    owner: 'root',
    own: true,
    at: 0,
    boundaries: [],
  });
});

test('a motty with no step assembles to empty phases', () => {
  expect(assemble(motty({ name: 'empty' })[chain]).lifecycle).toEqual({
    name: 'empty',
    before: [],
    answer: undefined,
    afterHandle: [],
    afterResponse: [],
  });
});

test('a used part may bring the answering step', () => {
  const handler = ({ prompt }: { prompt: Prompt }) => complete(prompt);
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .derive(() => ({ root: 1 }))
      .use(motty({ name: 'module' }).handle(handler))
      .afterHandle(() => {})[chain],
  );

  expect(lifecycle.answer).toMatchObject({
    kind: 'handle',
    run: handler,
    owner: 'module',
    at: 1,
  });
  expect(lifecycle.afterHandle.map((hook) => hook.owner)).toEqual(['root']);
});

test('after hooks keep registration order, each in its own phase', () => {
  const partAfter = () => {};
  const partSent = () => {};
  const after = () => {};
  const sent = () => {};
  const later = () => {};
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .use(
        motty({ name: 'part' }).afterResponse(partSent).afterHandle(partAfter),
      )
      .handle(({ prompt }) => complete(prompt))
      .afterResponse(sent)
      .afterHandle(after)
      .afterHandle(later)[chain],
  );

  expect(lifecycle.afterHandle.map((hook) => hook.run)).toEqual([
    partAfter,
    after,
    later,
  ]);
  expect(lifecycle.afterResponse.map((hook) => hook.run)).toEqual([
    partSent,
    sent,
  ]);
});

test('every hook has its place in the registration order of the lifecycle', () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .use(
        motty({ name: 'observer' })
          .afterHandle(() => {})
          .afterResponse(() => {}),
      )
      .beforeHandle(() => canned('Cached.'))
      .derive(() => ({ late: 1 }))
      .handle(({ prompt }) => complete(prompt))
      .afterHandle(() => {})
      .afterResponse(() => {})[chain],
  );

  expect(lifecycle.afterHandle.map((hook) => hook.at)).toEqual([0, 5]);
  expect(lifecycle.afterResponse.map((hook) => hook.at)).toEqual([1, 6]);
  expect(lifecycle.before.map((hook) => hook.at)).toEqual([2, 3]);
  expect(lifecycle.answer?.at).toBe(4);
});

test("an afterResponse hook holds the place of the last derive its own chain has before it, its parts' included and no other chain's", () => {
  const tenant = motty({ name: 'tenant' }).derive(() => ({ tenant: 'acme' }));
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .derive(() => ({ region: 'eu' }))
      .use(motty({ name: 'logger' }).afterResponse(() => {}))
      .use(
        motty({ name: 'billing' })
          .use(tenant)
          .afterResponse(() => {}),
      )
      .use(
        motty({ name: 'audit' })
          .use(tenant)
          .afterResponse(() => {}),
      )
      .derive(() => ({ plan: 'free' }))
      .use(motty({ name: 'late' }).afterResponse(() => {}))
      .afterResponse(() => {})
      .handle(({ prompt }) => complete(prompt))[chain],
  );

  expect(
    lifecycle.afterResponse.map((hook) => [hook.owner, hook.needs]),
  ).toEqual([
    ['logger', -1],
    ['billing', 2],
    ['audit', 2],
    ['late', -1],
    ['root', 5],
  ]);
});

test("a step is the lifecycle's own when its chain registered it, and a used part's is not", () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .derive(() => ({ region: 'eu' }))
      .use(motty({ name: 'tenant' }).derive(() => ({ tenant: 'acme' })))
      .route(() => 'only', {
        only: motty({ name: 'entry' })
          .derive(() => ({ plan: 'free' }))
          .handle(({ prompt }) => complete(prompt)),
      })[chain],
  );

  expect(lifecycle.before.map((hook) => [hook.owner, hook.own])).toEqual([
    ['root', true],
    ['tenant', false],
  ]);
  expect(nestedIn(lifecycle, 'only')?.before.map((hook) => hook.own)).toEqual([
    true,
  ]);
});

test('an afterResponse hook holds the place of the last derive or route before it, and no other step counts', () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .afterResponse(() => {})
      .beforeHandle(() => {})
      .afterResponse(() => {})
      .derive(() => ({ tenant: 'acme' }))
      .afterResponse(() => {})
      .route(() => 'only', { only: ({ prompt }) => complete(prompt) })
      .afterHandle(() => {})
      .afterResponse(() => {})[chain],
  );
  const handled = assemble(
    motty({ name: 'root' })
      .handle(({ prompt }) => complete(prompt))
      .afterResponse(() => {})[chain],
  );

  expect(lifecycle.afterResponse.map((hook) => hook.needs)).toEqual([
    -1, -1, 3, 5,
  ]);
  expect(handled.lifecycle.afterResponse.map((hook) => hook.needs)).toEqual([
    -1,
  ]);
});

test('an onError covers its whole motty wherever it was registered', () => {
  const failed = () => undefined;
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .derive(() => ({ early: 1 }))
      .handle(({ prompt }) => complete(prompt))
      .afterHandle(() => {})
      .afterResponse(() => {})
      .onError(failed)[chain],
  );

  expect(
    [
      ...lifecycle.before,
      lifecycle.answer,
      ...lifecycle.afterHandle,
      ...lifecycle.afterResponse,
    ].map((hook) => hook?.boundaries),
  ).toEqual(Array(4).fill([{ run: failed, owner: 'root' }]));
});

test('several onError of one motty stay in registration order', () => {
  const first = () => undefined;
  const second = () => undefined;
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .onError(first)
      .beforeHandle(() => {})
      .onError(second)[chain],
  );

  expect(
    lifecycle.before[0]?.boundaries.map((boundary) => boundary.run),
  ).toEqual([first, second]);
});

test('the boundaries of a hook are nearest first', () => {
  const innerFailed = () => undefined;
  const outerFailed = () => undefined;
  const rootFailed = () => undefined;
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .onError(rootFailed)
      .use(
        motty({ name: 'outer' })
          .use(
            motty({ name: 'inner' })
              .beforeHandle(() => {})
              .onError(innerFailed),
          )
          .beforeHandle(() => {})
          .onError(outerFailed),
      )
      .beforeHandle(() => {})[chain],
  );

  expect(lifecycle.before.map((hook) => hook.boundaries)).toEqual([
    [
      { run: innerFailed, owner: 'inner' },
      { run: outerFailed, owner: 'outer' },
      { run: rootFailed, owner: 'root' },
    ],
    [
      { run: outerFailed, owner: 'outer' },
      { run: rootFailed, owner: 'root' },
    ],
    [{ run: rootFailed, owner: 'root' }],
  ]);
});

test('an entry is a handler, a nested lifecycle or one with a recover', () => {
  const plain = ({ prompt }: { prompt: Prompt }) => complete(prompt);
  const recover = () => reroute('plain');
  const deep = motty({ name: 'deep' }).handle(({ prompt }) => complete(prompt));
  const table = tableOf(
    assemble(
      motty({ name: 'root' }).route(() => 'plain', {
        plain,
        nested: deep,
        caught: deep.catch(recover),
      })[chain],
    ).lifecycle,
  );

  expect(table).toMatchObject({
    plain: { handler: plain },
    nested: { lifecycle: { name: 'deep', answer: { kind: 'handle', at: 0 } } },
    caught: { lifecycle: { name: 'deep' }, recover },
  });
  expect(Object.values(table).map((entry) => Object.keys(entry))).toEqual([
    ['handler'],
    ['lifecycle'],
    ['lifecycle', 'recover'],
  ]);
});

test('a nested motty is a whole lifecycle with boundaries of its own', () => {
  const nestedFailed = () => undefined;
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .beforeHandle(() => {})
      .route(() => 'nested', {
        nested: motty({ name: 'nested' })
          .beforeHandle(() => {})
          .handle(({ prompt }) => complete(prompt))
          .afterResponse(() => {})
          .onError(nestedFailed),
      })
      .onError(() => undefined)[chain],
  );
  const nested = nestedIn(lifecycle, 'nested');

  expect(lifecycle.before.map((hook) => hook.owner)).toEqual(['root']);
  expect(nested?.before.map((hook) => [hook.owner, hook.at])).toEqual([
    ['nested', 0],
  ]);
  expect(nested?.answer?.at).toBe(1);
  expect(nested?.afterResponse.map((hook) => hook.at)).toEqual([2]);
  expect(nested?.answer?.boundaries).toEqual([
    { run: nestedFailed, owner: 'nested' },
  ]);
});

test('an assembled table has no inherited entries', () => {
  const table = tableOf(
    assemble(
      motty({ name: 'root' }).route(() => 'only', {
        only: ({ prompt }) => complete(prompt),
      })[chain],
    ).lifecycle,
  );

  expect(Object.getPrototypeOf(table)).toBeNull();
  expect('constructor' in table).toBe(false);
});

test('a part reached twice in one motty runs once, where it came first', () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .use(tenant())
      .use(
        motty({ name: 'billing' })
          .use(tenant())
          .derive(() => ({ plan: 'pro' })),
      )
      .use(tenant())
      .derive(() => ({ root: 1 }))[chain],
  );

  expect(lifecycle.before.map((hook) => hook.owner)).toEqual([
    'tenant',
    'billing',
    'root',
  ]);
});

test('parts with one name and different seeds are both applied', () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .use(motty({ name: 'limit', seed: 1 }).beforeHandle(() => {}))
      .use(motty({ name: 'limit', seed: 2 }).beforeHandle(() => {}))[chain],
  );

  expect(lifecycle.before.map((hook) => hook.owner)).toEqual([
    'limit',
    'limit',
  ]);
});

test('a part applied by the parent is not applied again in an entry', () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' })
      .use(tenant())
      .route(() => 'nested', {
        nested: motty({ name: 'nested' })
          .use(tenant())
          .use(motty({ name: 'own' }).beforeHandle(() => {}))
          .handle(({ prompt }) => complete(prompt)),
      })[chain],
  );

  expect(lifecycle.before.map((hook) => hook.owner)).toEqual(['tenant']);
  expect(
    nestedIn(lifecycle, 'nested')?.before.map((hook) => hook.owner),
  ).toEqual(['own']);
});

test('a part applied in one entry is still applied in its sibling', () => {
  const { lifecycle } = assemble(
    motty({ name: 'root' }).route(() => 'one', {
      one: motty({ name: 'one' })
        .use(tenant())
        .handle(({ prompt }) => complete(prompt)),
      other: motty({ name: 'other' })
        .use(tenant())
        .handle(({ prompt }) => complete(prompt)),
    })[chain],
  );

  expect(nestedIn(lifecycle, 'one')?.before).toHaveLength(1);
  expect(nestedIn(lifecycle, 'other')?.before).toHaveLength(1);
});

test('the description names every part used in the tree, first seen first', () => {
  const { description } = assemble(
    motty({ name: 'root' })
      .use(motty({ name: 'billing' }).use(tenant()))
      .use(tenant())
      .use(motty({ name: 'limit', seed: 1 }))
      .use(motty({ name: 'limit', seed: 2 }))
      .route(() => 'nested', {
        plain: ({ prompt }) => complete(prompt),
        nested: motty({ name: 'nested' })
          .use(tenant())
          .route(() => 'deep', {
            deep: motty({ name: 'deep' })
              .use(motty({ name: 'audit' }))
              .handle(({ prompt }) => complete(prompt)),
            again: motty({ name: 'deep' })
              .handle(({ prompt }) => complete(prompt))
              .catch(() => canned('Try again in a minute')),
          }),
      })[chain],
  );

  expect(description).toStrictEqual({
    sdk,
    name: 'root',
    plugins: ['billing', 'tenant', 'limit', 'nested', 'deep', 'audit'],
  });
});

test('everything assembled is frozen', () => {
  const assembled = assemble(
    motty({ name: 'root' })
      .use(tenant())
      .beforeHandle(() => {})
      .route(() => 'plain', {
        plain: ({ prompt }) => complete(prompt),
        nested: motty({ name: 'nested' })
          .handle(({ prompt }) => complete(prompt))
          .onError(() => undefined)
          .catch(() => canned('Down.')),
      })
      .afterHandle(() => {})
      .afterResponse(() => {})
      .onError(() => undefined)[chain],
  );
  const { lifecycle, description } = assembled;
  const table = tableOf(lifecycle);
  const nested = nestedIn(lifecycle, 'nested');

  expect(
    [
      assembled,
      description,
      description.plugins,
      lifecycle,
      lifecycle.before,
      ...lifecycle.before,
      ...lifecycle.before.map((hook) => hook.boundaries),
      ...lifecycle.before.flatMap((hook) => hook.boundaries),
      lifecycle.answer,
      table,
      ...Object.values(table),
      lifecycle.afterHandle,
      ...lifecycle.afterHandle,
      lifecycle.afterResponse,
      ...lifecycle.afterResponse,
      nested,
      nested?.before,
      nested?.answer,
      nested?.answer?.boundaries,
      ...(nested?.answer?.boundaries ?? []),
      assemble(motty({ name: 'empty' })[chain]).lifecycle.before,
    ].map(Object.isFrozen),
  ).not.toContain(false);
});
