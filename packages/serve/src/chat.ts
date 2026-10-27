import type { Caller, Contract, hosting } from '@mottyjs/core/host';
import { type Bounds, bodyOf } from './body.ts';
import type { Codec, LeftOut } from './codec.ts';
import type { flights } from './flights.ts';
import { failed, refused, streamed, watched, whole } from './reply.ts';
import { credentials } from './routes.ts';

type Serving = {
  admit: ReturnType<typeof hosting>;
  run: Contract['run'];
  keepAlive: number;
  body: Bounds;
  begin: ReturnType<typeof flights>['begin'];
};

// What a host with a server of its own says of one request.
export type FromHost = {
  id?: string;
  caller?: Caller;
  waitUntil?: (work: Promise<unknown>) => void;
};

// A runtime's own context refuses its method unbound, so the work is handed
// over on the object it came on. One that throws loses the host its wait and
// nothing else: the request runs on, and its flight lands on the delivery.
export function toldBy(from: FromHost) {
  const { id, caller } = from;
  return {
    ...(id === undefined ? {} : { id }),
    ...(caller === undefined ? {} : { caller }),
    delivered: (work: Promise<void>): void => {
      try {
        from.waitUntil?.(work);
      } catch {}
    },
  };
}

async function received(
  { admit, begin, body: bounds }: Serving,
  codec: Codec,
  request: Request,
  arrived: () => void,
  from: FromHost,
) {
  // In flight from here, so that a shutdown waits for a body still on its
  // way. A request refused before it was let in has no record: it lands at
  // once, or once the report of what the host's auth threw is delivered.
  const flight = begin();
  const told = toldBy(from);
  let reported: string | undefined;
  let refusal = Promise.resolve();
  let delivered = (work: Promise<void>): void => {
    refusal = work;
    told.delivered(work);
  };
  const refused = (reply: Response): Response => {
    flight.land(refusal);
    return reply;
  };
  try {
    const body = await bodyOf(codec, request, bounds, flight.stopped);
    if (body instanceof Response) return refused(body);
    arrived();
    const decoded = codec.decode(body, request.headers);
    const leftOut = new Map<string, LeftOut>();
    const admitted = await admit({
      ...told,
      request: decoded.request,
      headers: request.headers,
      credentials: codec.credentials,
      removed: credentials,
      signal: request.signal,
      delivered: (work) => delivered(work),
      leftOut: () => [...leftOut.values()],
      reported: (id) => {
        reported = id;
      },
    });
    delivered = flight.land;
    told.delivered(flight.over);
    const { stopped } = flight;
    const stop = () => admitted.stop(stopped.reason);
    if (stopped.aborted) stop();
    else stopped.addEventListener('abort', stop);
    return { decoded, leftOut, ...admitted };
  } catch (thrown) {
    return refused(failed(codec, thrown, reported));
  }
}

export async function chat(
  serving: Serving,
  codec: Codec,
  request: Request,
  // Called once the body is here whole: the server's idle timeout holds a
  // body that stalls, and must not hold an answer that takes long.
  arrived: () => void,
  from: FromHost,
): Promise<Response> {
  const asked = await received(serving, codec, request, arrived, from);
  if (asked instanceof Response) return asked;
  const { decoded, stop } = asked;
  const { id } = asked.request;
  const events = watched(
    serving.run(asked.request, asked.host)[Symbol.asyncIterator](),
    codec.formless,
    asked,
  );
  if (!decoded.stream) return whole(codec, decoded, events, id);

  // The status is the first event's to choose, and silence must be broken
  // before a proxy gives up: so the first event is waited for only as long
  // as silence may last, and after that an error ends the stream instead.
  const first = events.next();
  const silence = Promise.withResolvers<undefined>();
  const timer = setTimeout(() => silence.resolve(undefined), serving.keepAlive);
  const early = await Promise.race([first, silence.promise]);
  clearTimeout(timer);
  if (early?.done === false && early.value.type === 'error') {
    await events.return?.();
    return refused(codec, early.value.error, id);
  }
  return streamed(codec, decoded, first, events, id, {
    keepAlive: serving.keepAlive,
    waiting: early === undefined,
    left: () => {
      stop();
      (async () => events.return?.())().catch(() => {});
    },
  });
}
