import type { Contract, hosting } from '@mottyjs/core/host';
import { type Bounds, bodyOf } from './body.ts';
import type { Codec, LeftOut } from './codec.ts';
import { failed, refused, streamed, watched, whole } from './reply.ts';
import { credentials } from './routes.ts';

type Serving = {
  admit: ReturnType<typeof hosting>;
  run: Contract['run'];
  keepAlive: number;
  body: Bounds;
  begin: (stop: (reason: unknown) => void) => () => void;
};

async function received(
  { admit, begin, body: bounds }: Serving,
  codec: Codec,
  request: Request,
  arrived: () => void,
) {
  const body = await bodyOf(codec, request, bounds);
  if (body instanceof Response) return body;
  arrived();
  const decoded = codec.decode(body, request.headers);
  const leftOut = new Map<string, LeftOut>();
  let reported: string | undefined;
  try {
    // A request refused here was never in flight. The record comes only once
    // the motty has run, so the flight has begun by then.
    const admitted = await admit({
      request: decoded.request,
      headers: request.headers,
      credentials: codec.credentials,
      removed: credentials,
      signal: request.signal,
      over: () => landed(),
      leftOut: () => [...leftOut.values()],
      reported: (id) => {
        reported = id;
      },
    });
    const landed = begin(admitted.stop);
    return { decoded, leftOut, ...admitted };
  } catch (thrown) {
    return failed(codec, thrown, reported);
  }
}

export async function chat(
  serving: Serving,
  codec: Codec,
  request: Request,
  // Called once the body is here whole: the server's idle timeout holds a
  // body that stalls, and must not hold an answer that takes long.
  arrived: () => void,
): Promise<Response> {
  const asked = await received(serving, codec, request, arrived).catch(
    (thrown: unknown) => failed(codec, thrown),
  );
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
