import {
  type Chunk,
  disclosed,
  type ErrorFacts,
  type Progress,
  type RunStream,
  toFacts,
} from '@mottyjs/core/host';
import type { Codec, Decoded, LeftOut } from './codec.ts';
import { formatted } from './sse.ts';
import { refusal, shown } from './wire/formless.ts';

type Events = ReturnType<RunStream[typeof Symbol.asyncIterator]>;

type Read = ReturnType<Events['next']>;

// For facts that are already what the caller may be told.
export function refused(
  codec: Codec,
  facts: ErrorFacts,
  headers: { [name: string]: string } = {},
): Response {
  const { status, body } = codec.error(facts);
  return Response.json(body, {
    status,
    headers: {
      ...headers,
      // The official client libraries read this before they look at a status.
      'x-should-retry': String(facts.retryable === true),
      ...(facts.retryAfterMs === undefined
        ? {}
        : { 'retry-after': String(Math.ceil(facts.retryAfterMs / 1000)) }),
    },
  });
}

export function failed(codec: Codec, thrown: unknown): Response {
  return refused(codec, disclosed(toFacts(thrown)));
}

// The codec writes an honest reply on its own; only the edge can tell the
// request. Content that ends the reply stops the request with that error,
// so the stream's next event is the failure and the record says why.
export function watched(
  events: Events,
  formless: Codec['formless'],
  told: { leftOut: Map<string, LeftOut>; stop: (reason: unknown) => void },
): Events {
  return {
    next: async () => {
      for (;;) {
        const read = await events.next();
        if (read.done) return read;
        const { value } = read;
        if (
          value.type === 'progress' ||
          value.type === 'finish' ||
          value.type === 'error'
        ) {
          return read;
        }
        const found = formless(value);
        if (found === undefined) return read;
        const { warning } = found;
        told.leftOut.set(`${warning.setting} ${warning.detail}`, warning);
        if (found.ends) told.stop(refusal(warning));
        else {
          const kept = shown(value);
          if (kept !== undefined) return { done: false, value: kept };
        }
      }
    },
    return: async () =>
      (await events.return?.()) ?? { done: true, value: undefined },
  };
}

export async function whole(
  codec: Codec,
  decoded: Decoded,
  events: Events,
  id: string,
): Promise<Response> {
  const held: (Chunk | Progress)[] = [];
  try {
    for (;;) {
      const read = await events.next();
      if (read.done) throw new Error('The stream ended with no last event');
      const event = read.value;
      if (event.type === 'error') return refused(codec, event.error);
      if (event.type === 'finish') {
        return Response.json(decoded.collected(held, event, id));
      }
      held.push(event);
    }
  } catch (thrown) {
    return failed(codec, thrown);
  } finally {
    await events.return?.();
  }
}

async function* resumed(first: Read, events: Events): RunStream {
  try {
    for (let read = await first; !read.done; read = await events.next()) {
      yield read.value;
    }
  } finally {
    await events.return?.();
  }
}

// A comment is not an event, so no client of any of the APIs reads it.
const beat = new TextEncoder().encode(': keep-alive\n\n');

export function streamed(
  decoded: Decoded,
  first: Read,
  events: Events,
  id: string,
  flow: { keepAlive: number; waiting: boolean; left: () => void },
): Response {
  const encoder = new TextEncoder();
  const frames = decoded
    .streamed(resumed(first, events), id)
    [Symbol.asyncIterator]();
  let quiet = true;
  let open = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    open = false;
    clearInterval(timer);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // With no event yet, the headers still go out with something behind
      // them, so whatever stands between sees the response begin.
      if (flow.waiting) controller.enqueue(beat);
      timer = setInterval(() => {
        if (quiet) controller.enqueue(beat);
        quiet = true;
      }, flow.keepAlive);
    },
    async pull(controller) {
      const read = await frames.next().catch(() => undefined);
      if (!open) return;
      if (read === undefined || read.done) {
        close();
        controller.close();
        // A reply that could not be written leaves the request running.
        if (read === undefined) flow.left();
        return;
      }
      quiet = false;
      controller.enqueue(encoder.encode(formatted(read.value)));
    },
    cancel() {
      close();
      flow.left();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      // Asks a buffering proxy to pass each event on as it comes.
      'x-accel-buffering': 'no',
    },
  });
}
