import { AsyncLocalStorage } from 'node:async_hooks';
import type { Host, Limits, RequestRecord, Storage } from '../contract.ts';
import {
  disclosed,
  LimitReached,
  stopReason,
  toFacts,
} from '../data/errors.ts';
import { counts, type Usage, usageOf } from '../data/event.ts';
import type { Closed } from '../data/message.ts';
import { ownSignal, wait } from './wait.ts';

type Made = RequestRecord['calls'][number];

// What a call says of itself when it ends; the rest of its entry is measured.
type Reported = Omit<Made, 'model' | 'latencyMs' | 'firstEventMs'>;

export type Calls = {
  readonly made: readonly Readonly<Made>[];
  readonly total: Readonly<Usage>;
};

type State = {
  host: Host;
  signal: AbortSignal;
  calls: Calls;
  limits: Readonly<Limits>;
  record: Host['record'];
};

export type RequestState = Readonly<State>;

// Replaced, never changed, when a call settles: what a hook reads is frozen.
type Running = {
  state: State;
  phase: ReturnType<typeof ownSignal>;
  mistake: { readonly thrown: unknown } | undefined;
  made: readonly Readonly<Made>[];
  total: Readonly<Usage>;
  begun: number;
  open: number;
  idle?: PromiseWithResolvers<void>;
  storage?: Storage;
};

type OpenCall = {
  signal: AbortSignal;
  markFirstEvent: () => void;
  close: (reported?: Reported) => void;
  addUsage: (usage: unknown) => void;
};

const unlimited: State['limits'] = Object.freeze({});
const none: Running['made'] = Object.freeze([]);
const nothing: Running['total'] = Object.freeze({});

const requests = new AsyncLocalStorage<Running>();

function request(): Running {
  const found = requests.getStore();
  if (found === undefined) {
    throw new Error('Called outside a request: no request is running here');
  }
  return found;
}

// Copied, so a host that changes its limits later does not move a running one.
function limited(limits: Limits | null | undefined): State['limits'] {
  if (limits == null) return unlimited;
  if (typeof limits !== 'object') {
    throw new Error('The host must supply limits as an object');
  }
  const held: Limits = {};
  for (const name of ['calls', 'afterResponse'] as const) {
    const limit = limits[name];
    if (limit === undefined) continue;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error(`limits.${name} must be a whole number of zero or more`);
    }
    held[name] = limit;
  }
  return Object.freeze(held);
}

function checked(host: Host): State['limits'] {
  if (typeof host !== 'object' || host === null) {
    throw new Error('The host must be an object');
  }
  for (const name of ['models', 'decisions', 'record'] as const) {
    if (host[name] !== undefined && typeof host[name] !== 'function') {
      throw new Error(`The host must supply ${name} as a function`);
    }
  }
  if (!(host.signal instanceof AbortSignal)) {
    throw new Error('The host must supply signal, an AbortSignal');
  }
  return limited(host.limits);
}

export function enter<Result>(host: Host, run: () => Result): Result {
  let limits = unlimited;
  let mistake: Running['mistake'];
  try {
    limits = checked(host);
  } catch (thrown) {
    mistake = { thrown };
  }
  const phase = ownSignal(mistake === undefined ? host.signal : undefined);
  const live: Running = {
    state: {
      host,
      signal: phase.signal,
      calls: Object.freeze({
        get made() {
          return live.made;
        },
        get total() {
          return live.total;
        },
      }),
      limits,
      record: typeof host?.record === 'function' ? host.record : undefined,
    },
    phase,
    mistake,
    made: none,
    total: nothing,
    begun: 0,
    open: 0,
  };
  return requests.run(live, run);
}

export function current(): RequestState {
  return request().state;
}

export function running(): RequestState | undefined {
  return requests.getStore()?.state;
}

export function admitted(): void {
  const { mistake } = request();
  if (mistake !== undefined) throw mistake.thrown;
}

function storageUnderSignal({ state }: Running, held: Storage): Storage {
  const { increment } = held;
  return {
    get: async (key) => wait(held.get(key), state.signal),
    set: async (key, value, options) =>
      wait(held.set(key, value, options), state.signal),
    delete: async (key) => wait(held.delete(key), state.signal),
    ...(increment === undefined
      ? {}
      : {
          increment: async (key, by, options) =>
            wait(increment.call(held, key, by, options), state.signal),
        }),
  };
}

export function hosted(): Closed<
  Pick<Host, 'caller' | 'storage' | 'settings' | 'decisions'>
> & {
  readonly signal: AbortSignal;
} {
  const live = request();
  const { caller, storage, settings, decisions } = live.state.host;
  if (storage !== undefined) live.storage ??= storageUnderSignal(live, storage);
  return {
    ...(caller === undefined ? {} : { caller }),
    ...(live.storage === undefined ? {} : { storage: live.storage }),
    ...(settings === undefined ? {} : { settings }),
    ...(decisions === undefined ? {} : { decisions }),
    signal: live.state.signal,
  };
}

// Taken while the request is running and kept: the host closes its stream
// from outside the request, where the phase could not be found.
export function phaseStopper(): (reason?: unknown) => void {
  return request().phase.stop;
}

// After-response work outlives the host's stop signal, so its phase follows
// no other signal.
export function beginAfterResponse(): Running['phase'] {
  const live = request();
  live.phase = ownSignal();
  live.state.signal = live.phase.signal;
  return live.phase;
}

// Whoever ends a phase goes on only when every call still open has settled,
// so the usage it reads next is whole.
export async function endPhase(): Promise<void> {
  const live = request();
  live.phase.unfollow();
  live.phase.stop();
  if (live.open === 0) return;
  live.idle ??= Promise.withResolvers();
  await live.idle.promise;
}

function count(live: Running, call: Made, reported?: Reported): void {
  const total = { ...live.total };
  if (reported?.code !== undefined) {
    call.code = reported.code;
    // A host's facts promise no types, and the entry is plain data.
    if (typeof reported.message === 'string') call.message = reported.message;
  }
  if (reported?.warnings?.length) call.warnings = reported.warnings;
  const usage = usageOf(reported);
  for (const name of counts) {
    const used = usage[name];
    if (used === undefined) continue;
    call[name] = used;
    total[name] = (total[name] ?? 0) + used;
  }
  live.made = Object.freeze([...live.made, Object.freeze(call)]);
  live.total = Object.freeze(total);
  live.open -= 1;
  if (live.open > 0) return;
  live.idle?.resolve();
  delete live.idle;
}

// What a host says of a call that has already ended: the entry and the total
// are replaced like any other, so what a hook read before stays as it was.
function countLate(
  live: Running,
  entry: Readonly<Made>,
  reported: unknown,
): Readonly<Made> {
  const usage = usageOf(reported);
  const call = { ...entry };
  const total = { ...live.total };
  for (const name of counts) {
    const used = usage[name];
    if (used === undefined) continue;
    call[name] = (call[name] ?? 0) + used;
    total[name] = (total[name] ?? 0) + used;
  }
  live.made = Object.freeze(
    live.made.map((made) => (made === entry ? Object.freeze(call) : made)),
  );
  live.total = Object.freeze(total);
  return call;
}

export function openCall(name: string, under?: AbortSignal): OpenCall {
  const live = request();
  const { limits } = live.state;
  const signal = under ?? live.state.signal;
  if (signal.aborted) throw stopReason(signal.reason);
  // Calls still in flight count too, or concurrent calls would pass the limit.
  if (limits.calls !== undefined && live.begun >= limits.calls) {
    throw new LimitReached(
      `The request reached its limit of ${limits.calls} calls`,
    );
  }
  live.begun += 1;
  live.open += 1;
  const from = performance.now();
  let firstEventMs: number | undefined;
  let entry: Readonly<Made> | undefined;
  return {
    signal,
    markFirstEvent: () => {
      firstEventMs ??= performance.now() - from;
    },
    close: (reported) => {
      const latencyMs = performance.now() - from;
      const call: Made =
        firstEventMs === undefined
          ? { model: name, latencyMs }
          : { model: name, latencyMs, firstEventMs };
      entry = call;
      count(live, call, reported);
    },
    addUsage: (usage) => {
      if (entry !== undefined) entry = countLate(live, entry, usage);
    },
  };
}

function unheard(): void {}

// A call nobody awaits is stopped when its phase ends: its failure is in the
// calls, and is no rejection for the process to report.
export function mayGoUnawaited<Result>(call: Promise<Result>): Promise<Result> {
  call.catch(unheard);
  return call;
}

export function counted<Result>(
  name: string,
  call: (signal: AbortSignal, markFirstEvent: () => void) => Promise<Result>,
  reported?: (result: Result) => Reported | undefined,
): Promise<Result> {
  return mayGoUnawaited(
    (async () => {
      const open = openCall(name);
      let said: Reported | undefined;
      try {
        const result = await wait(
          call(open.signal, open.markFirstEvent),
          open.signal,
        );
        said = reported?.(result);
        return result;
      } catch (thrown) {
        // A value that is no SDK error may hold anything, so it is told in
        // the words a caller would be.
        said = disclosed(toFacts(thrown));
        throw thrown;
      } finally {
        open.close(said);
      }
    })(),
  );
}
