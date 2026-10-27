import {
  Overloaded,
  Unauthenticated,
  UnknownModel,
  Unsupported,
} from '@mottyjs/core';
import {
  bound,
  givenId,
  type HostOptions,
  hosting,
  type Marked,
  mark,
  type Overrides,
} from '@mottyjs/core/host';
import { chat, type FromHost, toldBy } from './chat.ts';
import type { Codec } from './codec.ts';
import { flights } from './flights.ts';
import { messages } from './messages/index.ts';
import { modelList, modelOf } from './models.ts';
import { failed } from './reply.ts';
import { formatOf, routed } from './routes.ts';

// All in milliseconds: how long a stream may be silent, how long a shutdown
// waits for the requests in flight, and how long a body has to arrive.
export type Edge = { keepAlive?: number; drain?: number; receive?: number };

// A callback's result is not checked for names its type lacks, so a group
// the motty does not declare is refused by name here. Overrides held as any
// map name no group and are let through.
type Undeclared<Given, Declared> = (
  string extends keyof Given
    ? never
    : Exclude<keyof Given, keyof Declared>
) extends infer Stray extends PropertyKey
  ? [Stray] extends [never]
    ? unknown
    : {
        readonly [Group in Stray]: 'The motty declares no settings group of this name';
      }
  : never;

// The environment as the runtime's own types declare it, so that names a host
// declares there stay known; a consumer with no such types gets plain strings.
type Env = typeof globalThis extends { process: { env: infer Declared } }
  ? Declared
  : Record<string, string | undefined>;

type Options<Served, Given> = (
  env: Env,
) => HostOptions<Given & Undeclared<Given, Overrides<Served>>>;

// Bun's server is the second argument only when Bun calls: on Workers it is
// the environment, which has no idle timeout to lift.
function unhurried(server: unknown, request: Request): void {
  if (
    typeof server === 'object' &&
    server !== null &&
    'timeout' in server &&
    typeof server.timeout === 'function'
  ) {
    server.timeout(request, 0);
  }
}

// One reason for a request refused at shutdown and for one stopped by it.
function shuttingDown(): Overloaded {
  return new Overloaded('The server is shutting down');
}

// The edge alone, for a host with a server of its own: nothing here touches
// the process or a listener.
export function mount<
  Served extends Marked,
  const Given extends Overrides<Served>,
>(motty: Served, options: Options<Served, Given>, edge: Edge = {}) {
  const { run, description } = motty[mark];
  const { name } = description;
  const started = new Date();
  const { begin, landed, stopAll } = flights();
  // A runtime with Node's globals off has no environment to read.
  const given = options(typeof process === 'undefined' ? {} : process.env);
  // Made first: it refuses a limit that is no number, the body's among them.
  const admit = hosting(motty, given);
  const drain = bound('drain', edge.drain) ?? 25_000;
  const serving = {
    admit,
    run,
    keepAlive: bound('keepAlive', edge.keepAlive) ?? 15_000,
    body: {
      size: given.limits?.body ?? 32 * 1024 * 1024,
      time: bound('receive', edge.receive) ?? 60_000,
    },
    begin,
  };
  const guarded = description.plugins.includes('auth');
  let closing = false;

  // What is still in flight when the wait is over is stopped, so that its
  // record says so, and is given a moment to hand that record over.
  async function close(): Promise<void> {
    closing = true;
    if (!(await landed(drain))) {
      stopAll(shuttingDown());
      await landed(1_000);
    }
  }

  // A list has no route to choose by, so a motty that asks for a caller
  // anywhere shows it only to one the host knows.
  async function listed(
    request: Request,
    format: Codec,
    model: string | undefined,
    from: FromHost,
  ): Promise<Response> {
    if (guarded) {
      // In flight until the report of what the host's auth threw is
      // delivered, as a chat request refused there is.
      const flight = begin();
      const told = toldBy(from);
      let refusal = Promise.resolve();
      let reported: string | undefined;
      const caller = await serving
        .admit({
          ...told,
          headers: request.headers,
          credentials: format.credentials,
          delivered: (work) => {
            refusal = work;
            told.delivered(work);
          },
          reported: (id) => {
            reported = id;
          },
        })
        .catch((thrown: unknown) => failed(format, thrown, reported));
      flight.land(refusal);
      if (caller instanceof Response) return caller;
      if (caller === undefined) {
        throw new Unauthenticated(
          'This motty needs a caller, and the host knows none',
        );
      }
    }
    const anthropic = format === messages;
    if (model === undefined) {
      return Response.json(modelList(name, started, anthropic));
    }
    return model === name
      ? Response.json(modelOf(name, started, anthropic))
      : failed(format, new UnknownModel(`No model named ${model}`));
  }

  function answered(
    request: Request,
    pathname: string,
    format: Codec,
    server: unknown,
    from: FromHost,
  ): Response | Promise<Response> {
    const route = routed(request, pathname);
    switch (route.to) {
      case 'chat':
        if (closing) {
          const refusal = failed(route.codec, shuttingDown());
          refusal.headers.set('connection', 'close');
          return refusal;
        }
        // The time limit is the host's own, and a long answer may be silent
        // for longer than the server lets a connection idle.
        return chat(
          serving,
          route.codec,
          request,
          () => unhurried(server, request),
          from,
        );
      case 'models':
        return listed(request, format, route.model, from);
      case 'unserved':
        return failed(format, new Unsupported(route.said, { status: 404 }));
      case 'nowhere':
        return failed(
          format,
          new Unsupported(
            'Nothing is served at this path: every endpoint is under /v1',
            { status: 404 },
          ),
        );
      default:
        return route satisfies never;
    }
  }

  // The last boundary: whatever is thrown while a request is taken in is
  // answered in the format of its path. An id the host may not give is the
  // host's own mistake, thrown to it before the request is looked at.
  async function fetch(
    request: Request,
    server?: unknown,
    from: FromHost = {},
  ): Promise<Response> {
    givenId(from.id);
    const { pathname } = new URL(request.url);
    const format = formatOf(request, pathname);
    try {
      return await answered(request, pathname, format, server, from);
    } catch (thrown) {
      return failed(format, thrown);
    }
  }

  return { fetch, close };
}

// Bun's server by the one method used, so that the declaration a consumer's
// compiler reads names no type of Bun's.
type Listening = { stop(closeActiveConnections?: boolean): Promise<void> };

// For a serve file, whose default export Bun starts: the edge and the
// process. Only a request shows the listener there is to stop.
export function serve<
  Served extends Marked,
  const Given extends Overrides<Served>,
>(motty: Served, options: Options<Served, Given>, edge: Edge = {}) {
  const mounted = mount<Served, Given>(motty, options, edge);
  let listening: Listening | undefined;

  async function close(): Promise<void> {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    const closed = listening?.stop();
    await mounted.close();
    await listening?.stop(true);
    await closed;
  }

  function onSignal(): void {
    close().finally(() => process.exit());
  }

  function fetch(
    request: Request,
    server?: Listening,
    from?: FromHost,
  ): Promise<Response> {
    if (server !== undefined && listening === undefined) {
      listening = server;
      process.once('SIGTERM', onSignal);
      process.once('SIGINT', onSignal);
    }
    return mounted.fetch(request, server, from);
  }

  return { fetch, close };
}
