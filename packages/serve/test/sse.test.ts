import { expect, test } from 'bun:test';
import { formatted, parsed } from '../src/sse.ts';

async function* chunked(...pieces: string[]) {
  for (const piece of pieces) yield new TextEncoder().encode(piece);
}

test('a named event is formatted with its name first', () => {
  expect(formatted({ event: 'message_stop', data: '{}' })).toBe(
    'event: message_stop\ndata: {}\n\n',
  );
});

test('data of several lines is formatted as one data line each', () => {
  expect(formatted({ data: 'one\ntwo\n' })).toBe(
    'data: one\ndata: two\ndata: \n\n',
  );
});

test.each([
  ['line feeds', '\n'],
  ['returns and line feeds', '\r\n'],
  ['returns', '\r'],
])(
  'a body of lines ended by %s is parsed alike wherever it is cut',
  async (_name, end) => {
    const bytes = new TextEncoder().encode(
      [
        ': keep-alive',
        '',
        'id: 7',
        'event: delta',
        'data: {"text":"héllo 👋"}',
        '',
        'data: one',
        'data:two',
        'data',
        'retry: 1000',
        '',
        'event: ping',
        '',
        'data:  spaced',
        '',
        '',
      ].join(end),
    );

    for (let cut = 0; cut <= bytes.length; cut++) {
      const events = await Array.fromAsync(
        parsed(
          (async function* () {
            yield bytes.subarray(0, cut);
            yield bytes.subarray(cut);
          })(),
        ),
      );

      expect(events).toEqual([
        { event: 'delta', data: '{"text":"héllo 👋"}' },
        { data: 'one\ntwo\n' },
        { data: ' spaced' },
      ]);
    }
  },
);

test.each([
  ['returns and line feeds', '\r\n'],
  ['returns', '\r'],
])(
  'a body of lines ended by %s is parsed alike a byte at a time',
  async (_name, end) => {
    const bytes = new TextEncoder().encode(
      `event: delta${end}data: héllo 👋${end}data:${end}${end}: kept alive${end}data: two${end}${end}`,
    );

    const events = await Array.fromAsync(
      parsed(
        (async function* () {
          for (const at of bytes.keys()) yield bytes.subarray(at, at + 1);
        })(),
      ),
    );

    expect(events).toEqual([
      { event: 'delta', data: 'héllo 👋\n' },
      { data: 'two' },
    ]);
  },
);

test('a field is named by the whole of what comes before its colon', async () => {
  const events = await Array.fromAsync(
    parsed(chunked('database: no\ndata : no\n data: no\ndata: yes\n\n')),
  );

  expect(events).toEqual([{ data: 'yes' }]);
});

test('an event the body ended in the middle of is dropped', async () => {
  const events = await Array.fromAsync(
    parsed(chunked('data: whole\n\ndata: cut off\n')),
  );

  expect(events).toEqual([{ data: 'whole' }]);
});

test('the body of a response is parsed, and leaving early cancels it', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode('data: one\n\ndata: two\n\n'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });

  for await (const event of parsed(body)) {
    expect(event).toEqual({ data: 'one' });
    break;
  }

  expect(cancelled).toBe(true);
});

test('a line that comes over many chunks is read in time that grows as its length does', async () => {
  function reader(size: number) {
    const bytes = new TextEncoder().encode(`data: ${'A'.repeat(size)}\n\n`);
    async function* chunks() {
      for (let at = 0; at < bytes.length; at += 16_384) {
        yield bytes.subarray(at, at + 16_384);
      }
    }
    return async () => {
      const start = performance.now();
      const [event] = await Array.fromAsync(parsed(chunks()));
      const taken = performance.now() - start;
      expect(event?.data.length).toBe(size);
      return taken;
    };
  }
  const short = reader(2_000_000);
  const long = reader(8_000_000);

  // The two take turns, so that a busy moment or a cold start falls on both.
  let shortTime = Number.POSITIVE_INFINITY;
  let longTime = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 15; round++) {
    shortTime = Math.min(shortTime, await short());
    longTime = Math.min(longTime, await long());
  }

  expect(longTime).toBeLessThan(8 * Math.max(shortTime, 1));
});

test('a return that ends a chunk in the middle of a long line is still one line break', async () => {
  expect(
    await Array.fromAsync(
      parsed(
        chunked(
          'data: one',
          ' two\r',
          '\ndata: three\r',
          '\r',
          'data: four\r\n\r',
        ),
      ),
    ),
  ).toEqual([{ data: 'one two\nthree' }, { data: 'four' }]);
});
