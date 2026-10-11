const lengths = [0, 1, 5, 15];
const requestsPerSample = 50_000;
const samples = 9;

function request() {
  return { input: 'hello', turn: 3, seen: 0 };
}

type Context = ReturnType<typeof request>;
type Added = Partial<Context> | undefined;
type Hook = (context: Context) => Added | Promise<Added>;

const guards: Hook = (context) =>
  context.input.length === 0 ? { seen: -1 } : undefined;
const counts: Hook = (context) => ({ seen: context.seen + 1 });
const skips: Hook = (context) => (context.turn < 0 ? { turn: 0 } : undefined);
const advances: Hook = (context) => ({
  seen: context.seen + 1,
  turn: context.turn + 1,
});
const looksUp: Hook = async (context) => {
  await Promise.resolve();
  return { seen: context.seen + 1 };
};
const audits: Hook = async (context) => {
  await Promise.resolve();
  return context.turn < 0 ? { turn: 0 } : undefined;
};

const counting = new Set([counts, advances, looksUp]);

function ready(index: number) {
  if (index % 4 === 0) return guards;
  if (index % 4 === 1) return counts;
  if (index % 4 === 2) return skips;
  return advances;
}

function chain(
  length: number,
  awaited: (index: number, length: number) => boolean,
) {
  return Array.from({ length }, (_, index) => {
    if (!awaited(index, length)) return ready(index);
    return index % 2 === 0 ? looksUp : audits;
  });
}

async function handler(context: Context) {
  await Promise.resolve();
  return { text: context.input, seen: context.seen };
}

function merge(context: Context, added: Added) {
  if (added !== undefined) Object.assign(context, added);
}

async function awaitedHooks(hooks: Hook[], context: Context) {
  for (const hook of hooks) merge(context, await hook(context));
  return context;
}

async function awaitedRequest(hooks: Hook[], context: Context) {
  for (const hook of hooks) merge(context, await hook(context));
  const answer = await handler(context);
  return answer;
}

async function resumedHooks(
  hooks: Hook[],
  context: Context,
  from: number,
  pending: Promise<Added>,
) {
  merge(context, await pending);
  for (let index = from; index < hooks.length; index++) {
    const hook = hooks[index];
    if (hook !== undefined) merge(context, await hook(context));
  }
  return context;
}

function laneHooks(hooks: Hook[], context: Context) {
  let index = 0;
  for (const hook of hooks) {
    index += 1;
    const added = hook(context);
    if (added instanceof Promise) {
      return resumedHooks(hooks, context, index, added);
    }
    merge(context, added);
  }
  return context;
}

// The handler is awaited in the synchronous lane too, not returned as it is:
// the real runner has after hooks to run on the answer.
async function answered(context: Context) {
  const answer = await handler(context);
  return answer;
}

async function resumedRequest(
  hooks: Hook[],
  context: Context,
  from: number,
  pending: Promise<Added>,
) {
  merge(context, await pending);
  for (let index = from; index < hooks.length; index++) {
    const hook = hooks[index];
    if (hook !== undefined) merge(context, await hook(context));
  }
  const answer = await handler(context);
  return answer;
}

function laneRequest(hooks: Hook[], context: Context) {
  let index = 0;
  for (const hook of hooks) {
    index += 1;
    const added = hook(context);
    if (added instanceof Promise) {
      return resumedRequest(hooks, context, index, added);
    }
    merge(context, added);
  }
  return answered(context);
}

type Outcome = { seen: number };
type Run = (hooks: Hook[]) => Outcome | Promise<Outcome>;

// The first lane of each scope is the one the other is compared to.
const scopes: Record<string, Record<string, Run>> = {
  'hooks only': {
    'always async': (hooks) => awaitedHooks(hooks, request()),
    'synchronous lane': (hooks) => laneHooks(hooks, request()),
  },
  'hooks and handler': {
    'always async': (hooks) => awaitedRequest(hooks, request()),
    'synchronous lane': (hooks) => laneRequest(hooks, request()),
  },
};

const shapes: Record<string, (index: number, length: number) => boolean> = {
  'all ready': () => false,
  'awaited first': (index) => index === 0,
  'awaited middle': (index, length) => index === length >> 1,
  'awaited last': (index, length) => index === length - 1,
  'all awaited': () => true,
};

async function sample(run: Run, hooks: Hook[], counted: number) {
  const start = Bun.nanoseconds();
  for (let done = 0; done < requestsPerSample; done++) {
    const outcome = run(hooks);
    const { seen } = outcome instanceof Promise ? await outcome : outcome;
    if (seen !== counted) throw new Error(`counted ${seen} of ${counted}`);
  }
  return (Bun.nanoseconds() - start) / requestsPerSample;
}

async function timing(run: Run, hooks: Hook[], counted: number) {
  await sample(run, hooks, counted);
  const taken: number[] = [];
  for (let done = 0; done < samples; done++) {
    taken.push(await sample(run, hooks, counted));
  }
  taken.sort((left, right) => left - right);
  const median = taken.at(samples >> 1) ?? Number.NaN;
  const spread = ((taken.at(-1) ?? Number.NaN) - (taken.at(0) ?? 0)) / median;
  return { median, spread };
}

const cases = Object.entries(shapes).map(([shape, awaited]) => ({
  shape,
  chains: lengths.map((length) => {
    const hooks = chain(length, awaited);
    const counted = hooks.filter((hook) => counting.has(hook)).length;
    return { length, hooks, counted };
  }),
}));

// One discarded pass over everything first, so that every lane is timed with
// its call sites already having seen every kind of hook.
for (const lanes of Object.values(scopes)) {
  for (const run of Object.values(lanes)) {
    for (const { chains } of cases) {
      for (const { hooks, counted } of chains)
        await sample(run, hooks, counted);
    }
  }
}

const rows: Record<string, string>[] = [];
for (const [scope, lanes] of Object.entries(scopes)) {
  for (const { shape, chains } of cases) {
    const reference: number[] = [];
    for (const [lane, run] of Object.entries(lanes)) {
      const row: Record<string, string> = { scope, hooks: shape, lane };
      let widest = 0;
      for (const [column, { length, hooks, counted }] of chains.entries()) {
        const { median, spread } = await timing(run, hooks, counted);
        reference[column] ??= median;
        row[`ns/request ${length}`] = median.toFixed(0);
        row[`ratio ${length}`] = (
          median / (reference[column] ?? median)
        ).toFixed(2);
        widest = Math.max(widest, spread);
      }
      row['widest spread'] = `${(widest * 100).toFixed(0)}%`;
      rows.push(row);
    }
  }
}

console.log(
  `bun ${Bun.version}, ${samples} samples of ${requestsPerSample} requests, median nanoseconds per request by chain length`,
);
console.table(rows);
