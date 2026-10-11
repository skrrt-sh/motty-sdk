import { type Contract, version } from '../contract.ts';
import type { ChatRequest, Draft, Message, Tool } from '../data/message.ts';
import { type Answer, isAnswer } from '../request/answer.ts';
import {
  admitted,
  current,
  enter,
  type RequestState,
} from '../request/context.ts';
import { stepUnder, wait } from '../request/wait.ts';
import { afterwards, type Finished } from './after-response.ts';
import { assemble, type Lifecycle, type Placed } from './assemble.ts';
import { type AnyMotty, type Chain, chain, type Supplied } from './builder.ts';
import { type Delivery, delivery, type Ended } from './delivery.ts';
import {
  answered,
  caught,
  recorded,
  type Trace,
  threw,
  tracing,
} from './record.ts';
import { type Routed, routed } from './route.ts';

type CutAnswer = Routed & { readonly cut: number };

const reserved = [
  'request',
  'prompt',
  'signal',
  'calls',
  'route',
  'path',
  'answer',
  'outcome',
  '__proto__',
] as const;

const contracts = new WeakMap<Chain, Contract>();

function isPlain(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const kind: unknown = Object.getPrototypeOf(value);
  return kind === Object.prototype || kind === null;
}

// Strings are shared, not copied: a long conversation or an inlined image
// costs its node count, not its bytes.
function copied<Data>(data: Data): Data;
function copied(data: unknown): unknown {
  if (typeof data !== 'object' || data === null) return data;
  if (Array.isArray(data)) {
    const items: unknown[] = new Array(data.length);
    for (let at = 0; at < data.length; at += 1) items[at] = copied(data[at]);
    return items;
  }
  if (!isPlain(data)) return data;
  // Spread first: a key named __proto__ stays a key of its own.
  const made: { [key: string]: unknown } = { ...data };
  for (const key in made) made[key] = copied(made[key]);
  return made;
}

// A copy is nobody else's, so what the caller sent closed is open in it.
function openList(sent: ChatRequest['messages']): Message[];
function openList(sent: ChatRequest['tools']): Tool[];
function openList(sent: readonly unknown[]): unknown[] {
  return sent.map(copied);
}

function openOptions(
  sent: ChatRequest['options'],
): NonNullable<Draft['options']>;
function openOptions(sent: unknown): unknown {
  return copied(sent);
}

// The output schema is shared: a Standard Schema holds functions.
function sent({ messages, tools, options, output }: ChatRequest): Draft {
  return {
    messages: openList(messages),
    tools: openList(tools),
    options: openOptions(options),
    ...(output === undefined ? {} : { output }),
  };
}

function own({ output, ...data }: Draft): Draft {
  return { ...copied(data), ...(output === undefined ? {} : { output }) };
}

// A part may replace a value its user derived before it. A chain's own derive
// may not replace one made in its lifecycle, which its types refuse: what an
// entry was handed by its parent is not the entry's, so it may be named again.
function derived(
  result: unknown,
  { owner, own }: Placed,
  context: Supplied,
  outer: Supplied | undefined,
): object {
  if (!isPlain(result)) {
    throw new Error(
      `A derive of "${owner}" gave something that is not a plain object`,
    );
  }
  for (const key of reserved) {
    if (Object.hasOwn(result, key)) {
      throw new Error(
        `A derive of "${owner}" named a value "${key}", which is reserved`,
      );
    }
  }
  if (own) {
    for (const key in result) {
      if (
        Object.hasOwn(context, key) &&
        !(outer !== undefined && Object.hasOwn(outer, key))
      ) {
        throw new Error(
          `A derive of "${owner}" named a value "${key}", which the chain already has`,
        );
      }
    }
  }
  return result;
}

function early(answer: Answer, { at, owner }: Placed): CutAnswer {
  return { answer, path: [], cut: at, early: owner };
}

async function recovered(
  thrown: unknown,
  { owner, boundaries }: Placed,
  context: Supplied,
  trace: Trace | undefined,
): Promise<Answer> {
  let passed = thrown;
  for (const boundary of boundaries) {
    try {
      const fallback = await wait(
        boundary.run(passed, context),
        context.signal,
      );
      if (isAnswer(fallback)) {
        caught(trace);
        return fallback;
      }
    } catch (rethrown) {
      passed = rethrown;
    }
  }
  threw(trace, owner, passed);
  throw passed;
}

async function before(
  lifecycle: Lifecycle,
  context: Supplied,
  trace: Trace | undefined,
  outer: Supplied | undefined,
): Promise<CutAnswer | undefined> {
  for (const hook of lifecycle.before) {
    try {
      const result = await stepUnder(context.signal, hook.run, context);
      switch (hook.kind) {
        case 'derive':
          Object.assign(context, derived(result, hook, context, outer));
          break;
        case 'beforeHandle':
          if (isAnswer(result)) return early(result, hook);
          break;
        default:
          hook.kind satisfies never;
      }
    } catch (thrown) {
      return early(await recovered(thrown, hook, context, trace), hook);
    }
  }
  return undefined;
}

async function answering(
  lifecycle: Lifecycle,
  context: Supplied,
  finished: Finished[],
  trace: Trace | undefined,
): Promise<CutAnswer> {
  const step = lifecycle.answer;
  if (step === undefined) {
    throw new Error(`The motty "${lifecycle.name}" has no route or handle`);
  }
  const cut = Number.POSITIVE_INFINITY;
  try {
    switch (step.kind) {
      case 'handle': {
        const answer = await stepUnder(context.signal, step.run, context);
        if (isAnswer(answer)) return { answer, path: [], cut };
        throw new Error(`The handle of "${step.owner}" gave no answer`);
      }
      case 'route': {
        const given = await routed(
          step,
          context,
          (nested, outer) =>
            lived(
              nested,
              { ...outer, prompt: own(outer.prompt) },
              finished,
              trace,
              outer,
            ),
          trace,
        );
        return { ...given, cut };
      }
      default:
        return step satisfies never;
    }
  } catch (thrown) {
    return early(await recovered(thrown, step, context, trace), step);
  }
}

async function lived(
  lifecycle: Lifecycle,
  context: Supplied,
  finished: Finished[],
  trace: Trace | undefined,
  outer?: Supplied,
): Promise<Routed> {
  let cut = Number.POSITIVE_INFINITY;
  let answered = false;
  try {
    const given =
      (await before(lifecycle, context, trace, outer)) ??
      (await answering(lifecycle, context, finished, trace));
    cut = given.cut;
    let last = cut;
    let { path } = given;
    let part = given.early;
    const [route] = path;
    if (route !== undefined) context.route = route;
    context.path = path;
    context.answer = given.answer;
    for (const hook of lifecycle.afterHandle) {
      if (hook.at > last) break;
      try {
        await stepUnder(context.signal, hook.run, context);
      } catch (thrown) {
        context.answer = await recovered(thrown, hook, context, trace);
        part = hook.owner;
        // What the entry made stays on the context for the after-response hooks
        // typed to hold it; the path given back is empty, as its answer is not sent.
        path = [];
        last = hook.at;
      }
    }
    answered = true;
    return {
      answer: context.answer,
      path,
      ...(part === undefined ? {} : { early: part }),
    };
  } finally {
    if (lifecycle.afterResponse.length > 0) {
      finished.push({ lifecycle, context, cut, answered });
    }
  }
}

async function drive(
  lifecycle: Lifecycle,
  request: ChatRequest,
  state: RequestState,
  out: Delivery,
): Promise<void> {
  const { signal, calls } = state;
  const finished: Finished[] = [];
  const trace = tracing(state.record);
  let ended: Ended;
  let given: Routed | undefined;
  try {
    admitted();
    const routed = await lived(
      lifecycle,
      { request, prompt: sent(request), signal, calls, path: [] },
      finished,
      trace,
    );
    ended = await out.answered(routed.answer);
    given = routed;
  } catch (thrown) {
    ended = await out.failed(thrown);
  }
  answered(trace, ended, given?.path, given?.early);
  await afterwards(finished, ended.outcome, state, trace);
  recorded(trace, calls);
}

export function contractOf(motty: AnyMotty): Contract {
  const root = motty[chain];
  const known = contracts.get(root);
  if (known !== undefined) return known;
  const { lifecycle, description } = assemble(root);
  const made: Contract = {
    version,
    description,
    // Entered once here and not in the stream: a generator's body runs in the
    // async context of whoever reads it, where the request would not be found.
    run: (request, host) =>
      enter(host, () => {
        const state = current();
        const out = delivery(state);
        drive(lifecycle, request, state, out);
        return out.stream;
      }),
  };
  contracts.set(root, made);
  return made;
}
