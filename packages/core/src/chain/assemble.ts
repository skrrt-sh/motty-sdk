import type { Description } from '../contract.ts';
import { version as sdk } from '../version.ts';
import type { Chain, Step, Target } from './builder.ts';

type HookRun = Extract<Step, { kind: 'route' }>['choose'];

type Boundary = {
  readonly run: Extract<Step, { kind: 'onError' }>['run'];
  readonly owner: string;
};

// One numbering across the phases of a lifecycle, the answering step included,
// so an early answer can tell what was registered after it. A step is the
// lifecycle's own when its chain registered it, and not a part that chain used.
export type Placed = {
  readonly owner: string;
  readonly own: boolean;
  readonly at: number;
  readonly boundaries: readonly Boundary[];
};

export type Hook<Kind extends string> = Placed & {
  readonly kind: Kind;
  readonly run: HookRun;
};

export type Entry =
  | Extract<Target, { handler: unknown }>
  | {
      readonly lifecycle: Lifecycle;
      readonly recover?: NonNullable<
        Extract<Target, { part: unknown }>['recover']
      >;
    };

// A derive or the route types what a later hook reads, so the hook holds the
// place of the last one its own chain has before it, its parts' included, and
// is not run when that step made nothing.
export type Late = Hook<'afterResponse'> & { readonly needs: number };

export type Route = Placed & {
  readonly kind: 'route';
  readonly choose: HookRun;
  readonly table: { readonly [name: string]: Entry };
};

export type Lifecycle = {
  readonly name: string;
  readonly before: readonly Hook<'derive' | 'beforeHandle'>[];
  readonly answer: Hook<'handle'> | Route | undefined;
  readonly afterHandle: readonly Hook<'afterHandle'>[];
  readonly afterResponse: readonly Late[];
};

type Assembled = {
  readonly lifecycle: Lifecycle;
  readonly description: Description;
};

function hook<Kind extends string>(
  kind: Kind,
  run: HookRun,
  placed: Placed,
): Hook<Kind> {
  return Object.freeze({ kind, run, ...placed });
}

function lifecycle(
  root: Chain,
  applied: ReadonlySet<string>,
  plugins: Set<string>,
): Lifecycle {
  const seen = new Set(applied);
  const before: Hook<'derive' | 'beforeHandle'>[] = [];
  const afterHandle: Hook<'afterHandle'>[] = [];
  const afterResponse: Late[] = [];
  let answer: Lifecycle['answer'];
  let at = 0;
  // The place of the last derive or route each part walked here has.
  const reach = new Map<string, number>();

  const entry = (target: Target): Entry => {
    if ('handler' in target) return target;
    plugins.add(target.part.name);
    const nested = lifecycle(target.part, seen, plugins);
    return Object.freeze(
      target.recover === undefined
        ? { lifecycle: nested }
        : { lifecycle: nested, recover: target.recover },
    );
  };

  const walk = (part: Chain, outer: readonly Boundary[]): number => {
    let needs = -1;
    const own = part.steps.flatMap((step) =>
      step.kind === 'onError'
        ? [Object.freeze({ run: step.run, owner: part.name })]
        : [],
    );
    const boundaries =
      own.length === 0 ? outer : Object.freeze([...own, ...outer]);
    for (const step of part.steps) {
      if (step.kind === 'onError') continue;
      if (step.kind === 'use') {
        plugins.add(step.part.name);
        const { identity } = step.part;
        if (!seen.has(identity)) {
          seen.add(identity);
          reach.set(identity, walk(step.part, boundaries));
        }
        needs = Math.max(needs, reach.get(identity) ?? -1);
        continue;
      }
      const placed: Placed = {
        owner: part.name,
        own: part === root,
        at: at++,
        boundaries,
      };
      if (step.kind === 'route' || step.kind === 'derive') needs = placed.at;
      if (step.kind === 'route') {
        const table: { [name: string]: Entry } = Object.create(null);
        for (const [name, target] of Object.entries(step.table)) {
          table[name] = entry(target);
        }
        answer = Object.freeze({
          kind: step.kind,
          choose: step.choose,
          table: Object.freeze(table),
          ...placed,
        });
      } else if (step.kind === 'handle') {
        answer = hook(step.kind, step.run, placed);
      } else if (step.kind === 'afterHandle') {
        afterHandle.push(hook(step.kind, step.run, placed));
      } else if (step.kind === 'afterResponse') {
        afterResponse.push(
          Object.freeze({ ...hook(step.kind, step.run, placed), needs }),
        );
      } else {
        before.push(hook(step.kind, step.run, placed));
      }
    }
    return needs;
  };
  walk(root, Object.freeze([]));

  return Object.freeze({
    name: root.name,
    before: Object.freeze(before),
    answer,
    afterHandle: Object.freeze(afterHandle),
    afterResponse: Object.freeze(afterResponse),
  });
}

export function assemble(root: Chain): Assembled {
  const plugins = new Set<string>();
  const assembled = lifecycle(root, new Set<string>(), plugins);
  const description: Description = {
    sdk,
    name: root.name,
    plugins: [...plugins],
  };
  Object.freeze(description.plugins);
  return Object.freeze({
    lifecycle: assembled,
    description: Object.freeze(description),
  });
}
