import { isMarked, mark } from '../contract.ts';
import type { ReadonlyJson } from '../data/message.ts';
import {
  type AnyMotty,
  type Base,
  type Builder,
  type Chain,
  chain,
  type Motty,
  type Step,
  type Target,
} from './builder.ts';
import { contractOf } from './run.ts';

type Given =
  | ((context: never) => unknown)
  | AnyMotty
  | {
      readonly entry: AnyMotty;
      readonly recover: (thrown: unknown, context: never) => unknown;
    }
  | string;

function asFunction<Fn extends (...given: never[]) => unknown>(
  given: Fn | string,
  owner: string,
  what: string,
): Fn {
  if (typeof given === 'function') return given;
  throw new Error(`The ${what} of the motty "${owner}" must be a function`);
}

function chainOf(given: AnyMotty | string): Chain | undefined {
  return typeof given === 'object' && given !== null && chain in given
    ? given[chain]
    : undefined;
}

// A motty of another copy of the SDK carries the mark and not this copy's
// chain, whose shape may differ by version, so it is refused by name.
function refusal(given: unknown, foreign: string, otherwise: string): Error {
  return new Error(
    isMarked(given)
      ? `${foreign} built by another copy of @mottyjs/core. A plugin must list @mottyjs/core as a peer dependency, so that one copy is installed`
      : otherwise,
  );
}

function canonical(name: string, seed: unknown, within: unknown[]): string {
  if (typeof seed === 'object' && seed !== null && !within.includes(seed)) {
    const inner = (value: unknown) => canonical(name, value, [...within, seed]);
    if (Array.isArray(seed)) return `[${Array.from(seed, inner).join(',')}]`;
    const kind = Object.getPrototypeOf(seed);
    if (kind === Object.prototype || kind === null) {
      const fields = Object.entries(seed)
        .sort(([left], [right]) => (left < right ? -1 : 1))
        .map(([key, value]) => `${JSON.stringify(key)}:${inner(value)}`);
      return `{${fields.join(',')}}`;
    }
  }
  if (
    seed === null ||
    typeof seed === 'string' ||
    typeof seed === 'boolean' ||
    (typeof seed === 'number' && Number.isFinite(seed))
  ) {
    return JSON.stringify(seed);
  }
  throw new Error(
    `The seed of the motty "${name}" must be plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects, with no cycle`,
  );
}

// An entry is no part of its user, but what it uses is defined once per motty.
function brought(step: Step): readonly Chain[] {
  if (step.kind === 'use') return [step.part, ...step.part.parts.values()];
  if (step.kind !== 'route') return [];
  return Object.values(step.table).flatMap((target) =>
    'part' in target ? [...target.part.parts.values()] : [],
  );
}

function merged(from: Chain, step: Step): Map<string, Chain> {
  const parts = new Map(from.parts);
  for (const part of brought(step)) {
    const known = parts.get(part.identity);
    if (step.kind === 'use' && part.identity === from.identity) {
      throw new Error(
        `The motty "${from.name}" cannot use a part with its own name and seed`,
      );
    }
    // Chains grown from one motty() call are told apart; a part made anew by
    // its function with the same seed is the same part.
    if (known !== undefined && known !== part && known.origin === part.origin) {
      throw new Error(
        `Two different parts share the name "${part.name}" and its seed: use one part everywhere, or make each from its own motty() call`,
      );
    }
    if (known === undefined) parts.set(part.identity, part);
  }
  return parts;
}

function extend(from: Chain, step: Step): Chain {
  const answers =
    step.kind === 'route' ||
    step.kind === 'handle' ||
    (step.kind === 'use' && step.part.answers);
  const after =
    step.kind === 'afterHandle' ||
    step.kind === 'afterResponse' ||
    step.kind === 'onError';
  if (from.answers && !after) {
    throw new Error(
      answers
        ? `The motty "${from.name}" already answers, so a second route or handle cannot be added`
        : `Only after hooks follow the answer of the motty "${from.name}", not ${step.kind}`,
    );
  }
  return Object.freeze({
    ...from,
    parts: merged(from, step),
    steps: Object.freeze([...from.steps, Object.freeze(step)]),
    answers: from.answers || answers,
  });
}

function target(owner: string, name: string, entry: Given): Target {
  if (typeof entry === 'function') return Object.freeze({ handler: entry });
  const caught =
    typeof entry === 'object' && entry !== null && 'recover' in entry;
  const part = chainOf(caught ? entry.entry : entry);
  if (part === undefined) {
    throw refusal(
      caught ? entry.entry : entry,
      `The entry "${name}" of the motty "${owner}" is a motty`,
      `The entry "${name}" of the motty "${owner}" must be a handler function, a motty or a motty with a catch`,
    );
  }
  if (!part.answers) {
    throw new Error(
      `The entry "${name}" is the motty "${part.name}", which has no route or handle`,
    );
  }
  return Object.freeze(
    caught
      ? { part, recover: asFunction(entry.recover, part.name, 'catch') }
      : { part },
  );
}

function tabled(
  owner: string,
  given: { readonly [name: string]: Given } | string,
): { readonly [name: string]: Target } {
  const entries = typeof given === 'object' && given !== null ? given : {};
  if (Object.getOwnPropertySymbols(entries).length > 0) {
    throw new Error(
      `An entry of the motty "${owner}" is named by a symbol, and an entry is named by a string`,
    );
  }
  if (Object.keys(entries).length === 0) {
    throw new Error(`A route of the motty "${owner}" needs at least one entry`);
  }
  // No prototype, so a name cast past the types never finds an inherited entry.
  const table: { [name: string]: Target } = Object.create(null);
  for (const [name, entry] of Object.entries(entries)) {
    table[name] = target(owner, name, entry);
  }
  return Object.freeze(table);
}

function build<Context, Paths extends string[]>(
  self: Chain,
): Motty<Context, Paths> {
  const hooked = <Next, NextPaths extends string[]>(
    kind: Exclude<Step['kind'], 'use' | 'route' | 'onError'>,
    run: ((context: never) => unknown) | string,
  ): Motty<Next, NextPaths> =>
    build(extend(self, { kind, run: asFunction(run, self.name, kind) }));
  const built: Builder<Context, Paths> = {
    [chain]: self,
    // Read by a host, which may hold another copy of the SDK. A getter, so a
    // motty that is only ever a part is never assembled.
    get [mark]() {
      return contractOf(built);
    },
    use: (given) => {
      const part = chainOf(given);
      if (part === undefined) {
        throw refusal(
          given,
          `The motty "${self.name}" was given a part`,
          `The motty "${self.name}" can use only another motty`,
        );
      }
      return build(extend(self, { kind: 'use', part }));
    },
    derive: (run) => hooked('derive', run),
    beforeHandle: (run) => hooked('beforeHandle', run),
    route: (choose, table) =>
      build(
        extend(self, {
          kind: 'route',
          choose: asFunction(choose, self.name, 'chooser'),
          table: tabled(self.name, table),
        }),
      ),
    handle: (run) => hooked('handle', run),
    afterHandle: (run) => hooked('afterHandle', run),
    afterResponse: (run) => hooked('afterResponse', run),
    onError: (run) =>
      build(
        extend(self, {
          kind: 'onError',
          run: asFunction<(thrown: unknown, context: never) => unknown>(
            run,
            self.name,
            'onError',
          ),
        }),
      ),
    catch: (recover) =>
      Object.freeze({
        entry: built,
        recover: asFunction(recover, self.name, 'catch'),
      }),
  };
  return Object.freeze(built);
}

export function motty(options: {
  name: string;
  seed?: ReadonlyJson;
}): Motty<Base> {
  const name = options?.name;
  if (typeof name !== 'string' || name === '') {
    throw new Error('A motty needs a name: a string that is not empty');
  }
  const seed = options.seed;
  return build(
    Object.freeze({
      name,
      identity:
        seed === undefined
          ? JSON.stringify([name])
          : `[${JSON.stringify(name)},${canonical(name, seed, [])}]`,
      origin: Symbol(name),
      parts: new Map<string, Chain>(),
      steps: Object.freeze([]),
      answers: false,
    }),
  );
}
