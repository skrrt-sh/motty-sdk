import { InvalidRequest } from '@mottyjs/core';
import type { Json } from '@mottyjs/core/host';
import type { Codec } from './codec.ts';
import { failed } from './reply.ts';
import { deepest, nested, parsed } from './wire/json.ts';

// The most bytes a body may be, and the milliseconds it has to arrive in.
export type Bounds = { size: number; time: number };

// What is left of the body is never read, so nothing more can be read from
// the connection either.
function cut(codec: Codec, thrown: unknown): Response {
  const refusal = failed(codec, thrown);
  refusal.headers.set('connection', 'close');
  return refusal;
}

// Counted as it is read: a stated length is the caller's word, and a body
// may come with none. A shutdown that waited long enough stops it too.
async function textOf(
  codec: Codec,
  request: Request,
  { size, time }: Bounds,
  stopped: AbortSignal,
): Promise<string | Response> {
  const tooLarge = () =>
    cut(
      codec,
      new InvalidRequest(
        `The body is larger than the ${size} bytes this server takes`,
        { status: 413 },
      ),
    );
  if (Number(request.headers.get('content-length')) > size) return tooLarge();
  if (request.body === null) return '';
  const reader = request.body.getReader();
  let ended: unknown;
  const end = (why: unknown) => {
    ended ??= why;
    reader.cancel().catch(() => {});
  };
  const timer = setTimeout(
    () =>
      end(
        new InvalidRequest(`The body did not arrive within ${time} ms`, {
          status: 408,
        }),
      ),
    time,
  );
  const stop = () => end(stopped.reason);
  stopped.addEventListener('abort', stop);
  try {
    const decoder = new TextDecoder();
    let text = '';
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      if (read > size) {
        reader.cancel().catch(() => {});
        return tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return ended === undefined ? text + decoder.decode() : cut(codec, ended);
  } finally {
    clearTimeout(timer);
    stopped.removeEventListener('abort', stop);
  }
}

export async function bodyOf(
  codec: Codec,
  request: Request,
  bounds: Bounds,
  stopped: AbortSignal,
): Promise<Json | Response> {
  const type = request.headers.get('content-type');
  if (type !== null && !/\bjson\b/i.test(type)) {
    throw new InvalidRequest(
      `The body must be JSON, sent as application/json and not as ${type}`,
    );
  }
  const text = await textOf(codec, request, bounds, stopped);
  if (text instanceof Response) return text;
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
