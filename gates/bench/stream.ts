const lengths = [10, 200, 2000];
const eventsPerSample = 100_000;
const samples = 9;

function eventAt(index: number, last: number) {
  if (index === last) return { type: 'finish', reason: 'stop' };
  if (index % 10 === 0) return { type: 'reasoning', text: 'thought' };
  return { type: 'text', text: 'token' };
}

type StreamEvent = ReturnType<typeof eventAt>;

async function* generated(length: number, awaited: boolean) {
  for (let index = 0; index < length; index++) {
    if (awaited) await Promise.resolve();
    yield eventAt(index, length - 1);
  }
}

function streamed(length: number, awaited: boolean) {
  let index = 0;
  return new ReadableStream<StreamEvent>({
    pull(controller) {
      const push = () => {
        controller.enqueue(eventAt(index, length - 1));
        index += 1;
        if (index === length) controller.close();
      };
      return awaited ? Promise.resolve().then(push) : push();
    },
  });
}

async function iterate(events: AsyncIterable<StreamEvent>) {
  let delivered = 0;
  for await (const event of events) delivered += event.type === '' ? 0 : 1;
  return delivered;
}

async function read(stream: ReadableStream<StreamEvent>) {
  const reader = stream.getReader();
  let delivered = 0;
  while (!(await reader.read()).done) delivered += 1;
  return delivered;
}

async function* withoutReasoning(events: AsyncIterable<StreamEvent>) {
  for await (const event of events) {
    if (event.type !== 'reasoning') yield event;
  }
}

function reasoningDropper() {
  return new TransformStream<StreamEvent, StreamEvent>({
    transform(event, controller) {
      if (event.type !== 'reasoning') controller.enqueue(event);
    },
  });
}

async function* replayed(buffer: StreamEvent[]) {
  for (const event of buffer) yield event;
}

async function bufferedTwice(length: number, awaited: boolean) {
  const buffer: StreamEvent[] = [];
  for await (const event of generated(length, awaited)) buffer.push(event);
  const [first, second] = await Promise.all([
    iterate(replayed(buffer)),
    iterate(replayed(buffer)),
  ]);
  return first + second;
}

async function teedTwice(length: number, awaited: boolean) {
  const [left, right] = streamed(length, awaited).tee();
  const [first, second] = await Promise.all([read(left), read(right)]);
  return first + second;
}

function streamFrom(events: AsyncIterable<StreamEvent>) {
  const iterator = events[Symbol.asyncIterator]();
  return new ReadableStream<StreamEvent>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

function path(
  name: string,
  delivered: (length: number) => number,
  candidates: Record<
    string,
    (length: number, awaited: boolean) => Promise<number>
  >,
) {
  return { name, delivered, candidates };
}

// The first candidate of each path is the one the others are compared to.
const paths = [
  path('end to end', (length) => length, {
    'generator, for await': (length, awaited) =>
      iterate(generated(length, awaited)),
    'stream, reader': (length, awaited) => read(streamed(length, awaited)),
    'stream, for await': (length, awaited) =>
      iterate(streamed(length, awaited)),
  }),
  path('transform', (length) => length - Math.ceil(length / 10), {
    'generator in generator': (length, awaited) =>
      iterate(withoutReasoning(generated(length, awaited))),
    'pipeThrough, reader': (length, awaited) =>
      read(streamed(length, awaited).pipeThrough(reasoningDropper())),
  }),
  path('replay to two', (length) => length * 2, {
    'array, two generators': bufferedTwice,
    'tee, two readers': teedTwice,
  }),
  path('iterable to stream', (length) => length, {
    'generator, for await': (length, awaited) =>
      iterate(generated(length, awaited)),
    'generator as stream, reader': (length, awaited) =>
      read(streamFrom(generated(length, awaited))),
  }),
  path('stream to iterable', (length) => length, {
    'stream, reader': (length, awaited) => read(streamed(length, awaited)),
    'stream, for await': (length, awaited) =>
      iterate(streamed(length, awaited)),
  }),
];

async function sample(run: () => Promise<number>, length: number) {
  const runs = Math.ceil(eventsPerSample / length);
  const start = Bun.nanoseconds();
  for (let done = 0; done < runs; done++) await run();
  return (Bun.nanoseconds() - start) / (runs * length);
}

async function timing(run: () => Promise<number>, length: number) {
  await sample(run, length);
  const taken: number[] = [];
  for (let done = 0; done < samples; done++) {
    taken.push(await sample(run, length));
  }
  taken.sort((left, right) => left - right);
  const median = taken.at(samples >> 1) ?? Number.NaN;
  const spread = ((taken.at(-1) ?? Number.NaN) - (taken.at(0) ?? 0)) / median;
  return { median, spread };
}

// One discarded pass over everything first: a candidate timed before the
// shared consumers reach the top compiler tier reads up to twice as slow.
for (const awaited of [false, true]) {
  for (const { candidates } of paths) {
    for (const run of Object.values(candidates)) {
      for (const length of lengths) {
        await sample(() => run(length, awaited), length);
      }
    }
  }
}

const rows: Record<string, string>[] = [];
for (const awaited of [false, true]) {
  for (const { name, delivered, candidates } of paths) {
    const reference: number[] = [];
    for (const [candidate, run] of Object.entries(candidates)) {
      const row: Record<string, string> = {
        path: name,
        candidate,
        source: awaited ? 'awaited' : 'ready',
      };
      let widest = 0;
      for (const [column, length] of lengths.entries()) {
        const count = await run(length, awaited);
        if (count !== delivered(length)) {
          throw new Error(`${candidate} delivered ${count} of ${length}`);
        }
        const { median, spread } = await timing(
          () => run(length, awaited),
          length,
        );
        reference[column] ??= median;
        row[`ns/event ${length}`] = median.toFixed(0);
        row[`ratio ${length}`] = (
          median / (reference[column] ?? median)
        ).toFixed(2);
        widest = Math.max(widest, spread);
      }
      row['widest spread'] = `${(widest * 100).toFixed(0)}%`;
      rows.push(row);
    }
  }
}

console.log(
  `bun ${Bun.version}, ${samples} samples of ${eventsPerSample} events, median nanoseconds per source event`,
);
console.table(rows);
