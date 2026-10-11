import { InvalidRequest } from '@mottyjs/core';
import type { Contract, hosting, Json } from '@mottyjs/core/host';
import type { Codec, LeftOut } from './codec.ts';
import { failed, refused, streamed, watched, whole } from './reply.ts';
import { credentials } from './routes.ts';
import { deepest, nested, parsed } from './wire/json.ts';

type Serving = {
  admit: ReturnType<typeof hosting>;
  run: Contract['run'];
  keepAlive: number;
  begin: (stop: (reason: unknown) => void) => () => void;
};

async function bodyOf(request: Request): Promise<Json> {
  const type = request.headers.get('content-type');
  if (type !== null && !/\bjson\b/i.test(type)) {
    throw new InvalidRequest(
      `The body must be JSON, sent as application/json and not as ${type}`,
    );
  }
  const text = await request.text();
  const body = parsed(text);
  if (body === undefined) {
    throw new InvalidRequest(
      nested(text)
        ? `The body is nested more than ${deepest} levels deep`
        : 'The body is not valid JSON',
    );
  }
  return body;
}

async function received(
  { admit, begin }: Serving,
  codec: Codec,
  request: Request,
) {
  const decoded = codec.decode(await bodyOf(request), request.headers);
  const leftOut = new Map<string, LeftOut>();
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
  });
  const landed = begin(admitted.stop);
  return { decoded, leftOut, ...admitted };
}

export async function chat(
  serving: Serving,
  codec: Codec,
  request: Request,
): Promise<Response> {
  const asked = await received(serving, codec, request).catch(
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
    return refused(codec, early.value.error);
  }
  return streamed(decoded, first, events, id, {
    keepAlive: serving.keepAlive,
    waiting: early === undefined,
    left: () => {
      stop();
      (async () => events.return?.())().catch(() => {});
    },
  });
}
