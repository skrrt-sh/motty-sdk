import type { Motty } from './chain/builder.ts';
import {
  bound,
  type Caller,
  type DecisionCall,
  type EventStream,
  type Host,
  type Limits,
  type Marked,
  type ModelCall,
  mark,
  type RequestRecord,
  type Storage,
  version,
} from './contract.ts';
import {
  type ErrorFacts,
  fromFacts,
  MottyError,
  stopReason,
  toFacts,
  unexpected,
} from './data/errors.ts';
import { isTerminal, type StreamEvent, type Usage } from './data/event.ts';
import type { ChatRequest, Json } from './data/message.ts';

// A decision provider's adapter carries only the decision call.
export type ModelAdapter = {
  serves: (model: string) => boolean;
  call?: ModelCall;
  decide?: DecisionCall;
};

// Which header carries the token is the wire API's to say, so an adapter is
// given the token alone.
export type AuthAdapter = {
  verify: (token: string) => Caller | undefined | Promise<Caller | undefined>;
};

type AnyOverrides = NonNullable<Host['settings']>;

type Warnings = NonNullable<RequestRecord['calls'][number]['warnings']>;

type Service = 'auth' | 'models' | 'storage' | 'decisions' | 'price';

type Sealed = { service: Service; error: ErrorFacts };

// Given the model, the failure is of a call to it and not of the service.
// Given the call's own signal, nothing thrown once it has fired is a failure.
type Seal = (
  service: Service,
  thrown: unknown,
  model?: string,
  cut?: AbortSignal,
) => MottyError;

// The warnings are what the host's edge left out of the reply it wrote, and
// the failures what a service of the host threw, which the motty was told
// only the service of.
export type Report = RequestRecord & {
  id: string;
  settings: AnyOverrides;
  warnings?: Warnings;
  failed?: Sealed[];
};

// Any of the groups the motty's settings declare, each with any of its
// values. A motty held without its types takes any overrides.
export type Overrides<Served> =
  Served extends Motty<infer Context, infer _Paths>
    ? Context extends { readonly settings: infer Held }
      ? { readonly [Group in keyof Held]?: Partial<Held[Group]> }
      : AnyOverrides
    : AnyOverrides;

export type HostOptions<Settings = AnyOverrides> = {
  // A function is asked once per request, so a key may live as long as one.
  // Its request is the host's own: the headers are as the caller sent them.
  models?:
    | readonly ModelAdapter[]
    | ((
        request: ChatRequest,
        caller: Caller | undefined,
      ) => readonly ModelAdapter[] | Promise<readonly ModelAdapter[]>);
  storage?: Storage;
  auth?: AuthAdapter;
  // The duration is in milliseconds and is the host's to enforce. The body
  // is in bytes and is the edge's.
  limits?: Limits & { duration?: number; body?: number };
  settings?: Settings;
  // In the host's own unit. Nothing returned leaves the upstream's cost.
  price?: (model: string, usage: Readonly<Usage>) => number | undefined;
  // Ahead of every stored key, in place of the motty's name.
  namespace?: string;
  // A promise returned is waited for, and anything else is no work at all.
  report?: (report: Report) => unknown;
};

type Calls = Required<Pick<Host, 'models' | 'decisions'>>;

type Price = NonNullable<HostOptions['price']>;

type Signed = {
  headers: Headers;
  // The headers that carry a credential on the caller's wire API, in lower
  // case and in the order they are tried.
  credentials: readonly string[];
  signal?: AbortSignal;
  // The host knows who is asking: the auth adapter is not asked.
  caller?: Caller;
  // The host's own id for the request, in place of one made here.
  id?: string;
  // Told once per report handed to the host, of work that ends when the
  // report's own has and never rejects.
  delivered?: (work: Promise<void>) => void;
  // The auth adapter threw and the host was told: the id is that report's.
  reported?: (id: string) => void;
};

type Asked = Signed & {
  request: Omit<ChatRequest, 'id' | 'headers'>;
  // The credential headers of every other API the host serves: a token sent
  // in one of them is removed too, and signs nobody in.
  removed?: readonly string[];
  // The request is over: its work after the response has ended too.
  over?: (record: RequestRecord) => void;
  // Asked once the request is over, when the reply has been written.
  leftOut?: () => Warnings;
};

type Admitted = {
  request: ChatRequest;
  host: Host;
  stop: (reason?: unknown) => void;
};

// With no request nothing is run and nothing asked of the host but who the
// caller is.
type Admit = {
  (asked: Asked): Promise<Admitted>;
  (signed: Signed): Promise<Caller | undefined>;
};

function unknown(model: string): ErrorFacts {
  return {
    code: 'unknown_model',
    status: 404,
    message: `No model named ${model}`,
  };
}

async function* failing(error: ErrorFacts): EventStream {
  yield { type: 'error', error };
}

// An adapter that serves the name but not this kind of call is passed over,
// so a chat adapter and a decision adapter may claim the same prefix.
export function adapted(adapters: readonly ModelAdapter[]): Calls {
  return {
    models: (model, prompt, signal) => {
      for (const adapter of adapters) {
        if (adapter.call !== undefined && adapter.serves(model)) {
          return adapter.call(model, prompt, signal);
        }
      }
      return failing(unknown(model));
    },
    decisions: async (model, input, signal) => {
      for (const adapter of adapters) {
        if (adapter.decide !== undefined && adapter.serves(model)) {
          return adapter.decide(model, input, signal);
        }
      }
      throw fromFacts(unknown(model));
    },
  };
}

// A figure that is no amount would be dropped further on and leave the call
// with no cost at all, so it is read as no figure and the upstream's stands.
function isAmount(cost: unknown): cost is number {
  return typeof cost === 'number' && cost >= 0 && cost < Infinity;
}

function costed(event: StreamEvent, model: string, price: Price): StreamEvent {
  if (!isTerminal(event) || event.usage === undefined) return event;
  const cost = price(model, event.usage);
  return isAmount(cost) ? { ...event, usage: { ...event.usage, cost } } : event;
}

async function* costedEvents(
  events: EventStream,
  model: string,
  price: Price,
): EventStream {
  for await (const event of events) yield costed(event, model, price);
}

function fields(value: Json | undefined) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

// A decision reports its two counts under the names of its own API.
function costedDecision(output: Json, model: string, price: Price): Json {
  const whole = fields(output);
  if (whole === undefined) return output;
  const { usage: reported } = whole;
  const usage = fields(reported);
  if (usage === undefined) return output;
  const { input_tokens: input, output_tokens: written, cost: upstream } = usage;
  const cost = price(model, {
    ...(typeof input === 'number' ? { input } : {}),
    ...(typeof written === 'number' ? { output: written } : {}),
    ...(typeof upstream === 'number' ? { cost: upstream } : {}),
  });
  return isAmount(cost) ? { ...whole, usage: { ...usage, cost } } : output;
}

// The price is asked where a call's usage leaves the host, so the motty
// counts the host's figure and never the one it replaced.
function priced(calls: Calls, price: Price | undefined, seal: Seal): Calls {
  return {
    models: (model, prompt, signal) => {
      try {
        const events = calls.models(model, prompt, signal);
        const source = (
          price === undefined ? events : costedEvents(events, model, price)
        )[Symbol.asyncIterator]();
        let last: Promise<unknown> | undefined;
        // A read is handed on as it is, since a handler on each would cost
        // every chunk a promise: what a read threw is told by the core in its
        // own words, and is asked for here once, when the stream is closed.
        const read: AsyncIterator<StreamEvent> = {
          next: () => {
            try {
              const pending = source.next();
              last = pending;
              return pending;
            } catch (thrown) {
              throw seal('models', thrown, model, signal);
            }
          },
          return: () => {
            // Only a read that had failed by now is a failure of the call:
            // one that fails once the call is cut or closed was told nobody.
            if (!signal.aborted) {
              let closed = false;
              last?.then(undefined, (thrown) => {
                if (!closed) seal('models', thrown, model);
              });
              queueMicrotask(() => {
                closed = true;
              });
            }
            return (
              source.return?.() ??
              Promise.resolve({ done: true, value: undefined })
            );
          },
        };
        return { [Symbol.asyncIterator]: () => read };
      } catch (thrown) {
        throw seal('models', thrown, model, signal);
      }
    },
    decisions: async (model, input, signal) => {
      try {
        const output = await calls.decisions(model, input, signal);
        return price === undefined
          ? output
          : costedDecision(output, model, price);
      } catch (thrown) {
        throw seal('decisions', thrown, undefined, signal);
      }
    },
  };
}

// A storage may throw before it returns its promise as well as reject it.
function kept<Result>(
  call: () => Promise<Result>,
  refuse: (thrown: unknown) => Promise<never>,
): Promise<Result> {
  try {
    return call().catch(refuse);
  } catch (thrown) {
    return refuse(thrown);
  }
}

function prefixed(storage: Storage, prefix: string, seal: Seal): Storage {
  const { increment } = storage;
  const refuse = (thrown: unknown) => Promise.reject(seal('storage', thrown));
  return {
    get: (key) => kept(() => storage.get(prefix + key), refuse),
    set: (key, value, options) =>
      kept(() => storage.set(prefix + key, value, options), refuse),
    delete: (key) => kept(() => storage.delete(prefix + key), refuse),
    ...(increment === undefined
      ? {}
      : {
          increment: (key, by, options) =>
            kept(
              () => increment.call(storage, prefix + key, by, options),
              refuse,
            ),
        }),
  };
}

function refused(error: ErrorFacts): RequestRecord {
  return {
    outcome: 'failed',
    error,
    path: [],
    entries: [],
    calls: [],
    usage: {},
    time: { answer: 0, total: 0 },
    afterResponse: { failed: [], skipped: [], unreached: [] },
  };
}

// Handed to every request, so nothing a motty writes into it may stay. A
// value that holds itself is no data and would never be walked to its end.
function frozen<Value>(value: Value, above: Set<unknown>): Value {
  if (typeof value === 'object' && value !== null) {
    if (above.has(value)) throw new Error('A value holds itself');
    above.add(value);
    for (const held of Object.values(value)) frozen(held, above);
    above.delete(value);
  }
  return Object.freeze(value);
}

// Told by group and without the value, which may be anything the host held.
function copied(overrides: AnyOverrides): AnyOverrides {
  const groups: { [group: string]: Json } = {};
  for (const [group, held] of Object.entries(overrides)) {
    try {
      groups[group] = frozen(structuredClone(held), new Set());
    } catch {
      throw new Error(`The settings overrides of ${group} are not plain data`);
    }
  }
  return Object.freeze(groups);
}

const unset: AnyOverrides = Object.freeze({});

// What a report throws is left to whoever asked for it, as it always was.
// What it rejects with has nobody to reach, so the work never rejects.
function deliver(
  report: Report,
  send: HostOptions['report'],
  delivered: Signed['delivered'],
): void {
  let work = Promise.resolve();
  try {
    work = Promise.resolve(send?.(report)).then(
      () => {},
      () => {},
    );
  } finally {
    delivered?.(work);
  }
}

// RFC 6750 for a bearer token: the scheme in any case, then one token of its
// alphabet and nothing else. A header sent twice arrives joined by a comma
// and fails. Any other header's value is the key itself.
function tokenIn(headers: Headers, name: string): string | undefined {
  const sent = headers.get(name) ?? '';
  return name === 'authorization'
    ? /^bearer +([\w\-.~+/]+=*)$/i.exec(sent)?.[1]
    : sent;
}

// The id goes into a response header and into the ids of a reply's body.
export function givenId(id: string | undefined): string | undefined {
  if (id !== undefined && !/^[\w.~-]{1,128}$/.test(id)) {
    throw new Error('The request id is not one the host may give');
  }
  return id;
}

// The overrides are checked against the motty's own settings here and read
// as plain data from here on: the motty's schemas check their values.
export function hosting<Served extends Marked>(
  motty: Served,
  options: HostOptions<Overrides<Served>>,
): Admit;
export function hosting(motty: Marked, options: HostOptions) {
  const { description, version: spoken } = motty[mark];
  if (spoken !== version) {
    throw new Error(
      `The motty speaks contract version ${spoken}, this host ${version}`,
    );
  }
  const { auth, models = [], price } = options;
  const fixed = adapted(typeof models === 'function' ? [] : models);
  // A name may hold a colon: escaped, the first colon of a key ends the name.
  const prefix = `${(options.namespace ?? description.name).replace(/[%:]/g, encodeURIComponent)}:`;
  const { duration, body, ...rest } = options.limits ?? {};
  bound('limits.duration', duration);
  bound('limits.body', body, 'whole');
  bound('limits.calls', rest.calls, 'whole');
  bound('limits.afterResponse', rest.afterResponse);
  const limits = Object.freeze(rest);
  const settings =
    options.settings === undefined ? unset : copied(options.settings);

  async function admit(asked: Asked): Promise<Admitted>;
  async function admit(signed: Signed): Promise<Caller | undefined>;
  async function admit(
    asked: Signed & Partial<Asked>,
  ): Promise<Admitted | Caller | undefined> {
    const id = givenId(asked.id) ?? crypto.randomUUID();
    const headers = new Headers(asked.headers);
    let failed: Sealed[] | undefined;
    // Until the request's own signal is made, the caller's is all of it.
    let signal = asked.signal;
    // What a service of the host threw may hold a key or an address, so the
    // motty is told which service failed and the report holds the rest. A
    // stop is one only once the signal has fired: a service's own timeout
    // or abort is its failure.
    const seal: Seal = (service, thrown, model, cut) => {
      if (thrown instanceof MottyError) return thrown;
      if (cut?.aborted) return stopReason(cut.reason);
      if (signal?.aborted && toFacts(thrown).unexpected !== true) {
        return stopReason(thrown);
      }
      failed ??= [];
      failed.push({ service, error: unexpected(thrown) });
      return model === undefined
        ? new MottyError(`The host's ${service} failed`)
        : new MottyError(`The model call to ${model} failed`, {
            unexpected: true,
          });
    };
    // Every credential header goes, whatever it holds: a second one may hold
    // the token that signs the caller in, as sent or written another way.
    // The first whose token the adapter knows says who the caller is, unless
    // the host has said.
    let caller = asked.caller;
    for (const name of asked.credentials) {
      const token = tokenIn(headers, name);
      headers.delete(name);
      if (auth === undefined || caller !== undefined || !token) continue;
      try {
        caller = await auth.verify(token);
      } catch (thrown) {
        // No motty ran, so no record comes: the host is told here, and the
        // caller by whoever asked, of the thrown value as it is.
        const error = toFacts(seal('auth', thrown));
        if (failed !== undefined) {
          deliver(
            { ...refused(error), id, settings, failed },
            options.report,
            asked.delivered,
          );
          asked.reported?.(id);
        }
        throw thrown;
      }
    }
    const { request } = asked;
    if (request === undefined) return caller;
    for (const name of asked.removed ?? []) headers.delete(name);
    let calls = fixed;
    if (typeof models === 'function') {
      try {
        calls = adapted(
          await models({ ...request, id, headers: asked.headers }, caller),
        );
      } catch (thrown) {
        const sealed = seal('models', thrown);
        calls = {
          models: () => failing({ ...toFacts(sealed), upstream: false }),
          decisions: () => Promise.reject(sealed),
        };
      }
    }
    const stop = new AbortController();
    // A stop with no reason ends the request as one whose caller left; the
    // time limit's own reason ends it as timed out.
    const signals = [stop.signal];
    if (asked.signal !== undefined) signals.push(asked.signal);
    if (duration !== undefined) {
      signals.push(AbortSignal.timeout(duration));
    }
    signal = AbortSignal.any(signals);
    // A price that throws leaves the call as the upstream told it: what was
    // spent is counted, and the host reads of its price on the report.
    const quote: Price | undefined =
      price &&
      ((model, usage) => {
        try {
          return price(model, usage);
        } catch (thrown) {
          failed ??= [];
          failed.push({ service: 'price', error: toFacts(thrown) });
          return undefined;
        }
      });
    return {
      request: { ...request, id, headers },
      host: {
        ...priced(calls, quote, seal),
        signal,
        limits,
        // Asked for whether or not anyone reads it: nothing else says that
        // the work after the response is over.
        record: (record) => {
          asked.over?.(record);
          const warnings = asked.leftOut?.() ?? [];
          deliver(
            {
              ...record,
              id,
              settings,
              ...(warnings.length === 0 ? {} : { warnings }),
              ...(failed === undefined ? {} : { failed }),
            },
            options.report,
            asked.delivered,
          );
        },
        ...(options.storage === undefined
          ? {}
          : { storage: prefixed(options.storage, prefix, seal) }),
        // A copy, so a caller the adapter keeps is not the motty's to change.
        ...(caller === undefined
          ? {}
          : { caller: Object.freeze({ ...caller }) }),
        ...(options.settings === undefined ? {} : { settings }),
      },
      stop: (reason) => stop.abort(reason),
    };
  }
  return admit;
}
