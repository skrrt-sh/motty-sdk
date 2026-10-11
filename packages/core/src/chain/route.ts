import { RouteLoop, UnknownRoute } from '../data/errors.ts';
import { type Answer, isAnswer } from '../request/answer.ts';
import { stepUnder, wait } from '../request/wait.ts';
import type { Entry, Lifecycle, Route } from './assemble.ts';
import type { Reroute, Supplied } from './builder.ts';
import { caught, type Trace } from './record.ts';

export type Routed = {
  readonly answer: Answer;
  readonly path: readonly string[];
  readonly early?: string;
};

type RunNested = (lifecycle: Lifecycle, context: Supplied) => Promise<Routed>;

export function reroute<Name extends string>(name: Name): Reroute<Name> {
  return { reroute: name };
}

function isReroute(value: unknown): value is Reroute {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reroute' in value &&
    typeof value.reroute === 'string'
  );
}

function given(result: unknown, name: string): Routed | Reroute {
  if (isReroute(result)) return result;
  if (isAnswer(result)) return { answer: result, path: [] };
  throw new Error(`The entry "${name}" gave neither an answer nor a reroute`);
}

async function entryRun(
  name: string,
  entry: Entry,
  context: Supplied,
  nested: RunNested,
  trace: Trace | undefined,
): Promise<Routed | Reroute> {
  if ('handler' in entry) {
    return given(await stepUnder(context.signal, entry.handler, context), name);
  }
  const { lifecycle, recover } = entry;
  if (recover === undefined) return nested(lifecycle, context);
  try {
    return await nested(lifecycle, context);
  } catch (thrown) {
    const fallback = await wait(recover(thrown, context), context.signal);
    if (fallback === undefined) throw thrown;
    caught(trace);
    return given(fallback, name);
  }
}

export async function routed(
  route: Route,
  context: Supplied,
  nested: RunNested,
  trace: Trace | undefined,
): Promise<Routed> {
  const ran = new Set<string>();
  let name: unknown = await stepUnder(context.signal, route.choose, context);
  while (true) {
    const entry = typeof name === 'string' ? route.table[name] : undefined;
    if (typeof name !== 'string' || entry === undefined) {
      throw new UnknownRoute(
        `The route of the motty "${route.owner}" has no entry named "${String(name)}"`,
      );
    }
    if (ran.has(name)) {
      throw new RouteLoop(
        `The entry "${name}" of the motty "${route.owner}" already ran for this request`,
      );
    }
    ran.add(name);
    trace?.entries.push(name);
    const result = await entryRun(name, entry, context, nested, trace);
    if ('reroute' in result) {
      name = result.reroute;
      continue;
    }
    return { ...result, path: [name, ...result.path] };
  }
}
