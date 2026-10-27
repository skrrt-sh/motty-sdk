import { expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { answer, model, motty, think } from '@mottyjs/core';
import type { ModelAdapter, Report } from '@mottyjs/core/host';
import { fake, on } from '@mottyjs/test';
import { mount } from '../src/index.ts';
import { parsed } from '../src/sse.ts';

const gpt = model('openai/gpt');

const coder = motty({ name: 'coder' }).handle(({ prompt }) =>
  gpt.complete(prompt),
);

function ask(
  port: number | undefined,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      stream,
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function question(stream: boolean): Request {
  return new Request('http://motty.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      stream,
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
  });
}

// Says the first words, then nothing until it is let go or stopped.
function halting(release: Promise<void>, stopped?: () => void): ModelAdapter {
  return {
    serves: () => true,
    call: async function* (_model, _prompt, signal) {
      if (stopped !== undefined) signal.addEventListener('abort', stopped);
      yield { type: 'text', text: 'Two threads ' };
      await release;
      yield { type: 'text', text: 'take the locks in opposite order.' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

async function readUntil(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'read'>,
  wanted: RegExp,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  while (!wanted.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test('a streamed answer arrives piece by piece, not when it is over', async () => {
  const release = Promise.withResolvers<void>();
  const served = mount(coder, () => ({ models: [halting(release.promise)] }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  expect(reply.status).toBe(200);
  expect(reply.headers.get('content-type')).toBe('text/event-stream');
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  const early = await readUntil(reader, /Two threads /);
  expect(early).not.toContain('opposite order');

  release.resolve();
  const rest = await readUntil(reader, /\[DONE\]/);
  expect(rest).toContain('take the locks in opposite order.');
  expect(rest).toEndWith('data: [DONE]\n\n');
  await served.close();
});

test('a slow motty: the stream opens and is kept alive before anything is said', async () => {
  const release = Promise.withResolvers<void>();
  const served = mount(
    motty({ name: 'coder' }).handle(async () => {
      await release.promise;
      return answer('Use a mutex.');
    }),
    () => ({}),
    { keepAlive: 20 },
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  expect(reply.status).toBe(200);
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  const silence = await readUntil(reader, /(: keep-alive\n\n){3}/);
  expect(silence).toMatch(/^(: keep-alive\n\n)+$/);

  release.resolve();
  const rest = await readUntil(reader, /\[DONE\]/);
  expect(rest).toContain('"content":"Use a mutex."');
  await served.close();
});

test('a slow motty that then fails: the status was sent, so the error ends the stream', async () => {
  const release = Promise.withResolvers<void>();
  const served = mount(
    motty({ name: 'coder' }).handle(async () => {
      await release.promise;
      throw new Error('The index is being rebuilt');
    }),
    () => ({}),
    { keepAlive: 20 },
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  expect(reply.status).toBe(200);
  release.resolve();
  const events = await Array.fromAsync(
    parsed(reply.body ?? new ReadableStream<Uint8Array>()),
  );

  expect(events.map(({ data }) => JSON.parse(data))).toMatchObject([
    { error: { message: 'Internal error', type: 'server_error' } },
  ]);
  await served.close();
});

test('a motty that fails within the first silence still answers with its status', async () => {
  const served = mount(
    motty({ name: 'coder' }).handle(async () => {
      await Bun.sleep(30);
      throw new Error('The index is being rebuilt');
    }),
    () => ({}),
    { keepAlive: 2_000 },
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);

  expect(reply.status).toBe(500);
  expect(reply.headers.get('content-type')).toStartWith('application/json');
  await served.close();
});

test('silence in the middle of an answer is kept alive, and a busy stream is left alone', async () => {
  const release = Promise.withResolvers<void>();
  const served = mount(coder, () => ({ models: [halting(release.promise)] }), {
    keepAlive: 20,
  });
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  const early = await readUntil(
    reader,
    /Two threads .*\n\n(: keep-alive\n\n){2}/,
  );
  expect(early).toStartWith('data: {');

  release.resolve();
  const rest = await readUntil(reader, /\[DONE\]/);
  expect(rest).toEndWith('data: [DONE]\n\n');
  await served.close();
});

test('a stream that is never silent for as long as the keep-alive is sent no keep-alive', async () => {
  const talking: ModelAdapter = {
    serves: () => true,
    call: async function* () {
      for (let said = 0; said < 30; said += 1) {
        yield { type: 'text', text: `word ${said} ` };
        await Bun.sleep(10);
      }
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const served = mount(coder, () => ({ models: [talking] }), {
    keepAlive: 100,
  });
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  const text = await reply.text();

  expect(text).toContain('word 29 ');
  expect(text).not.toContain(': keep-alive');
  await served.close();
});

test('a caller who leaves mid-stream: the upstream call is told and the record says aborted', async () => {
  const stopped = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<Report>();
  const served = mount(coder, () => ({
    models: [halting(Promise.withResolvers<void>().promise, stopped.resolve)],
    report: reported.resolve,
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });
  const leaving = new AbortController();

  const reply = await ask(server.port, true, leaving.signal);
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  await readUntil(reader, /Two threads /);
  leaving.abort();

  await stopped.promise;
  expect(await reported.promise).toMatchObject({
    outcome: 'aborted',
    error: { code: 'aborted' },
    calls: [{ model: 'openai/gpt', code: 'aborted' }],
  });
  await served.close();
});

test('a caller who leaves while a whole answer is being made: the same', async () => {
  const begun = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<Report>();
  const waiting: ModelAdapter = {
    serves: () => true,
    call: async function* (_model, _prompt, signal) {
      signal.addEventListener('abort', () => stopped.resolve());
      begun.resolve();
      await Promise.withResolvers<void>().promise;
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const served = mount(coder, () => ({
    models: [waiting],
    report: reported.resolve,
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });
  const leaving = new AbortController();

  const asked = ask(server.port, false, leaving.signal);
  await begun.promise;
  leaving.abort();

  await expect(asked).rejects.toThrow();
  await stopped.promise;
  expect(await reported.promise).toMatchObject({
    outcome: 'aborted',
    error: { code: 'aborted' },
    calls: [{ code: 'aborted' }],
  });
  await served.close();
});

test('the time limit: a caller waiting for a whole answer gets a 504, and the record says timed out', async () => {
  const stopped = Promise.withResolvers<void>();
  const reported = Promise.withResolvers<Report>();
  const served = mount(coder, () => ({
    models: [halting(Promise.withResolvers<void>().promise, stopped.resolve)],
    limits: { duration: 40 },
    report: reported.resolve,
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, false);

  expect(reply.status).toBe(504);
  expect(await reply.json()).toMatchObject({
    error: { message: 'The work timed out', code: 'timed_out' },
  });
  await stopped.promise;
  expect(await reported.promise).toMatchObject({
    outcome: 'aborted',
    error: { code: 'timed_out', status: 504 },
    calls: [{ model: 'openai/gpt' }],
  });
  await served.close();
});

test('the time limit: a stream that had begun is ended with the error', async () => {
  const reported = Promise.withResolvers<Report>();
  const served = mount(coder, () => ({
    models: [halting(Promise.withResolvers<void>().promise)],
    limits: { duration: 40 },
    report: reported.resolve,
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  expect(reply.status).toBe(200);
  const events = await Array.fromAsync(
    parsed(reply.body ?? new ReadableStream<Uint8Array>()),
  );

  expect(events.map(({ data }) => JSON.parse(data))).toMatchObject([
    { choices: [{ delta: { content: 'Two threads ' } }] },
    { error: { message: 'The work timed out', code: 'timed_out' } },
  ]);
  expect(await reported.promise).toMatchObject({
    outcome: 'aborted',
    error: { code: 'timed_out' },
  });
  await served.close();
});

test('the time limit: a stream nothing was said in yet is a 504', async () => {
  const served = mount(
    motty({ name: 'coder' }).handle(async () => {
      await Promise.withResolvers<void>().promise;
      return answer('Use a mutex.');
    }),
    () => ({ limits: { duration: 40 } }),
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);

  expect(reply.status).toBe(504);
  expect(await reply.json()).toMatchObject({ error: { code: 'timed_out' } });
  await served.close();
});

test('shutdown: no new request is taken, and the one in flight ends with its after-response work done', async () => {
  const release = Promise.withResolvers<void>();
  const done: string[] = [];
  const served = mount(
    motty({ name: 'coder' })
      .afterResponse(async () => {
        await Bun.sleep(30);
        done.push('after-response work');
      })
      .handle(({ prompt }) => gpt.complete(prompt)),
    () => ({
      models: [halting(release.promise)],
      report: ({ outcome }) => done.push(`report: ${outcome}`),
    }),
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });
  const reply = await ask(server.port, true);
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  await readUntil(reader, /Two threads /);

  const stopping = served.close().then(() => done.push('stopped'));
  const refused = await ask(server.port, false);
  expect(refused.status).toBe(503);
  expect(refused.headers.get('connection')).toBe('close');
  expect(await refused.json()).toMatchObject({
    error: {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'The server is shutting down',
    },
  });
  await Bun.sleep(20);
  expect(done).toEqual([]);

  release.resolve();
  expect(await readUntil(reader, /\[DONE\]/)).toContain('opposite order.');
  await stopping;
  expect(done).toEqual(['after-response work', 'report: completed', 'stopped']);
});

test('shutdown is bounded: what outlasts the wait is stopped, and its record says so', async () => {
  const reports: Report[] = [];
  const served = mount(
    coder,
    () => ({
      models: [halting(Promise.withResolvers<void>().promise)],
      report: (report) => reports.push(report),
    }),
    { drain: 40 },
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });
  const reply = await ask(server.port, true);
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  await readUntil(reader, /Two threads /);

  const began = performance.now();
  await served.close();

  expect(performance.now() - began).toBeLessThan(1_000);
  expect(reports).toMatchObject([
    {
      outcome: 'aborted',
      error: {
        code: 'overloaded',
        status: 503,
        message: 'The server is shutting down',
      },
      calls: [{ code: 'overloaded' }],
    },
  ]);
  const events = await Array.fromAsync(
    parsed({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const { done, value } = await reader.read();
          return done ? { done, value: undefined } : { done: false, value };
        },
      }),
    }),
  );
  expect(JSON.parse(events.at(-1)?.data ?? '')).toMatchObject({
    error: {
      type: 'service_unavailable_error',
      code: 'server_is_overloaded',
      message: 'The server is shutting down',
    },
  });
});

test('shutdown waits for a record that is still being delivered', async () => {
  const order: string[] = [];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
    report: async () => {
      await Bun.sleep(40);
      order.push('delivered');
    },
  }));

  await (await served.fetch(question(false))).text();
  await served.close();
  order.push('stopped');

  expect(order).toEqual(['delivered', 'stopped']);
});

test('shutdown gives up on a record whose delivery outlasts the wait', async () => {
  const served = mount(
    coder,
    () => ({
      models: [fake(on(gpt, 'Use a mutex.'))],
      report: () => Promise.withResolvers<void>().promise,
    }),
    { drain: 40 },
  );

  await (await served.fetch(question(false))).text();
  const began = performance.now();
  await served.close();

  expect(performance.now() - began).toBeGreaterThanOrEqual(40);
  expect(performance.now() - began).toBeLessThan(2_000);
});

// A chat request whose body has not all come yet, and the end of that body.
function arriving(): { request: Request; rest: () => void } {
  const encoder = new TextEncoder();
  const [head, tail] = [
    '{"model":"coder","messages":[{"role":"user",',
    '"content":"Why does this deadlock?"}]}',
  ];
  let sending: ReadableStreamDefaultController<Uint8Array> | undefined;
  const request = new Request('http://motty.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream<Uint8Array>({
      start: (controller) => {
        sending = controller;
        controller.enqueue(encoder.encode(head));
      },
    }),
  });
  return {
    request,
    rest: () => {
      sending?.enqueue(encoder.encode(tail));
      sending?.close();
    },
  };
}

test('a request whose body is still arriving when shutdown begins is waited for, and answered once its body is in', async () => {
  const reports: Report[] = [];
  const works: Promise<unknown>[] = [];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
    report: (report) => reports.push(report),
  }));
  const { request, rest } = arriving();
  const replying = served.fetch(request, undefined, {
    waitUntil: (work) => works.push(work),
  });
  await Bun.sleep(10);

  let stopped = false;
  const stopping = served.close().then(() => {
    stopped = true;
  });
  await Bun.sleep(30);
  expect(stopped).toBe(false);

  rest();
  const reply = await replying;
  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({
    choices: [{ message: { content: 'Use a mutex.' } }],
  });
  await stopping;
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(works).toHaveLength(1);
});

test('a body still arriving when the drain is over is cut with the shutdown refusal, and nothing is reported or handed over', async () => {
  const reports: Report[] = [];
  const works: Promise<unknown>[] = [];
  const served = mount(
    coder,
    () => ({
      models: [fake(on(gpt, 'Use a mutex.'))],
      report: (report) => reports.push(report),
    }),
    { drain: 40 },
  );
  const replying = served.fetch(arriving().request, undefined, {
    waitUntil: (work) => works.push(work),
  });
  await Bun.sleep(10);

  const began = performance.now();
  await served.close();
  expect(performance.now() - began).toBeLessThan(1_000);

  const reply = await replying;
  expect(reply.status).toBe(503);
  expect(reply.headers.get('connection')).toBe('close');
  expect(await reply.json()).toMatchObject({
    error: {
      code: 'server_is_overloaded',
      message: 'The server is shutting down',
    },
  });
  expect(reports).toEqual([]);
  expect(works).toEqual([]);
});

test('a request still being let in when the drain is over is stopped with the shutdown refusal, and its record says so', async () => {
  const verified = Promise.withResolvers<void>();
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
    () => ({
      auth: {
        verify: async (token) => {
          await verified.promise;
          return { id: token };
        },
      },
      report: (report) => reports.push(report),
    }),
    { drain: 40 },
  );
  const replying = served.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-ada',
      },
      body: JSON.stringify({
        model: 'coder',
        messages: [{ role: 'user', content: 'Why does this deadlock?' }],
      }),
    }),
  );
  await Bun.sleep(10);

  const began = performance.now();
  const stopping = served.close();
  await Bun.sleep(80);
  verified.resolve();
  await stopping;
  expect(performance.now() - began).toBeLessThan(1_000);

  const reply = await replying;
  expect(reply.status).toBe(503);
  expect(await reply.json()).toMatchObject({
    error: { message: 'The server is shutting down' },
  });
  expect(reports).toMatchObject([
    { outcome: 'aborted', error: { code: 'overloaded' } },
  ]);
});

test('shutdown waits for the report of a request the auth adapter failed on', async () => {
  const order: string[] = [];
  const served = mount(coder, () => ({
    auth: {
      verify: () => {
        throw new Error('The key server timed out');
      },
    },
    report: async () => {
      await Bun.sleep(40);
      order.push('delivered');
    },
  }));

  const reply = await served.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sk-ada',
      },
      body: JSON.stringify({
        model: 'coder',
        messages: [{ role: 'user', content: 'Why does this deadlock?' }],
      }),
    }),
  );
  expect(reply.status).toBe(500);
  await served.close();
  order.push('stopped');

  expect(order).toEqual(['delivered', 'stopped']);
});

test("the host is handed the delivery of a request's record, which settles only once an async report has", async () => {
  const sent = Promise.withResolvers<void>();
  const order: string[] = [];
  const works: Promise<unknown>[] = [];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
    report: async () => {
      await sent.promise;
      order.push('report');
    },
  }));

  const reply = await served.fetch(question(false), undefined, {
    waitUntil: (work) => works.push(work),
  });
  await reply.text();
  const settled = works[0]?.then(() => order.push('work'));
  await Bun.sleep(20);
  expect(order).toEqual([]);

  sent.resolve();
  await settled;
  expect(order).toEqual(['report', 'work']);
  await served.close();
});

test.each([true, false])(
  'the delivery is handed over while the request is taken in, before there is a reply: stream %p',
  async (stream) => {
    const release = Promise.withResolvers<void>();
    const works: Promise<unknown>[] = [];
    const served = mount(
      motty({ name: 'coder' }).handle(async () => {
        await release.promise;
        return answer('Use a mutex.');
      }),
      () => ({}),
    );
    let replied = false;

    const replying = served
      .fetch(question(stream), undefined, {
        waitUntil: (work) => works.push(work),
      })
      .finally(() => {
        replied = true;
      });
    await Bun.sleep(20);
    expect(works).toHaveLength(1);
    expect(replied).toBe(false);

    release.resolve();
    expect(await (await replying).text()).toContain('Use a mutex.');
    await works[0];
    await served.close();
  },
);

test('each admitted request hands over one delivery of its own', async () => {
  const works: Promise<unknown>[] = [];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
    report: () => Bun.sleep(5),
  }));

  for (const stream of [false, true, false]) {
    const reply = await served.fetch(question(stream), undefined, {
      waitUntil: (work) => works.push(work),
    });
    await reply.text();
  }
  await served.close();

  expect(works).toHaveLength(3);
  expect(new Set(works).size).toBe(3);
});

test('a report that rejects still settles the delivery, which never rejects', async () => {
  const works: Promise<unknown>[] = [];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
    report: () => Promise.reject(new Error('The sink is gone')),
  }));

  const reply = await served.fetch(question(false), undefined, {
    waitUntil: (work) => works.push(work),
  });

  expect(reply.status).toBe(200);
  expect(works).toHaveLength(1);
  expect(await works[0]).toBeUndefined();
  await served.close();
});

test('with no report the delivery still settles', async () => {
  const works: Promise<unknown>[] = [];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
  }));

  const reply = await served.fetch(question(true), undefined, {
    waitUntil: (work) => works.push(work),
  });
  await reply.text();

  expect(works).toHaveLength(1);
  expect(await works[0]).toBeUndefined();
  await served.close();
});

test('a waitUntil that throws leaves the request answered as normal, and its flight still lands, so shutdown does not wait out the drain', async () => {
  const reports: Report[] = [];
  const served = mount(
    coder,
    () => ({
      models: [fake(on(gpt, 'Use a mutex.'))],
      report: (report) => reports.push(report),
    }),
    { drain: 5_000 },
  );

  const reply = await served.fetch(question(false), undefined, {
    waitUntil: () => {
      throw new Error('The context is gone');
    },
  });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({
    choices: [{ message: { content: 'Use a mutex.' } }],
  });
  const began = performance.now();
  await served.close();

  expect(performance.now() - began).toBeLessThan(1_000);
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
});

test('a second argument that is no server of Bun is no failure: called as a Workers module is, the edge answers and uses the context it was handed', async () => {
  const context = {
    held: new Set<Promise<unknown>>(),
    // As a runtime's own context does, it refuses to be called unbound.
    waitUntil(work: Promise<unknown>) {
      this.held.add(work);
    },
    passThroughOnException() {},
  };
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
  }));

  const reply = await served.fetch(
    question(false),
    { UPSTREAM: 'https://upstream.test', timeout: 30 },
    context,
  );

  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({
    choices: [{ message: { content: 'Use a mutex.' } }],
  });
  expect(context.held.size).toBe(1);
  await served.close();
});

test('a mounted motty leaves the process and the server to their host', async () => {
  const signals = [
    process.listenerCount('SIGTERM'),
    process.listenerCount('SIGINT'),
  ];
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
  }));
  using server = Bun.serve({
    port: 0,
    fetch: (request, listening) =>
      new URL(request.url).pathname === '/health'
        ? new Response('up')
        : served.fetch(request, listening),
  });

  expect((await ask(server.port, false)).status).toBe(200);
  expect([
    process.listenerCount('SIGTERM'),
    process.listenerCount('SIGINT'),
  ]).toEqual(signals);

  await served.close();
  const health = await fetch(`http://localhost:${server.port}/health`);
  expect(await health.text()).toBe('up');
  expect((await ask(server.port, false)).status).toBe(503);
});

test('progress sent before a slow answer opens the stream at once', async () => {
  const release = Promise.withResolvers<void>();
  const served = mount(
    motty({ name: 'coder' }).handle(async () => {
      think('Reading the diff');
      await release.promise;
      return answer('Use a mutex.');
    }),
    () => ({}),
  );
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  const reader = reply.body?.getReader();
  if (reader === undefined) throw new Error('The reply has no body');
  const early = await readUntil(reader, /Reading the diff/);
  expect(early).not.toContain('Use a mutex.');

  release.resolve();
  expect(await readUntil(reader, /\[DONE\]/)).toContain('Use a mutex.');
  await served.close();
});

test('a hundred requests at once each get their own answer and their own record', async () => {
  const ids: string[] = [];
  const echo: ModelAdapter = {
    serves: () => true,
    call: async function* (_model, prompt) {
      await Bun.sleep(Math.random() * 20);
      yield { type: 'text', text: `echo ${prompt.messages.at(-1)?.text}` };
      await Bun.sleep(Math.random() * 10);
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const served = mount(coder, () => ({
    models: [echo],
    report: ({ id }) => ids.push(id),
  }));
  // A hundred connections opened at once over TCP are more than a machine
  // that filters its network lets through, whatever serves them.
  const unix = `${tmpdir()}/${crypto.randomUUID()}.sock`;
  using _server = Bun.serve({ unix, fetch: served.fetch });

  const answers = await Promise.all(
    Array.from({ length: 100 }, async (_, number) => {
      const reply = await fetch('http://localhost/v1/messages', {
        unix,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'coder',
          max_tokens: 64,
          stream: number % 2 === 0,
          messages: [{ role: 'user', content: `question ${number}` }],
        }),
      });
      return reply.text();
    }),
  );

  for (const [number, text] of answers.entries()) {
    expect(text).toContain(`echo question ${number}"`);
    expect(text.match(/echo question/g)).toHaveLength(1);
  }
  await served.close();
  expect(new Set(ids).size).toBe(100);
});

test('models given per request: requests that overlap each send upstream only the key made for them', async () => {
  const sent: string[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      sent.push(
        `${await request.text()} with ${request.headers.get('authorization')}`,
      );
      return new Response('Use a mutex.');
    },
  });
  let made = 0;
  const served = mount(coder, () => {
    made += 1;
    return {
      auth: { verify: (token) => ({ id: token }) },
      models: (request, caller) => {
        const key = `temporary-${caller?.id}-${request.id}`;
        return [
          {
            serves: () => true,
            call: async function* (_model, prompt) {
              const text = String(prompt.messages.at(-1)?.text);
              await Bun.sleep(text === 'question 0' ? 20 : 0);
              const reply = await fetch(`http://localhost:${upstream.port}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${key}` },
                body: text,
              });
              yield { type: 'text', text: await reply.text() };
              yield { type: 'finish', reason: 'stop' };
            },
          },
        ];
      },
    };
  });

  const replies = await Promise.all(
    Array.from({ length: 3 }, (_, number) =>
      served.fetch(
        new Request('http://motty.test/v1/chat/completions', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer caller-${number}`,
          },
          body: JSON.stringify({
            model: 'coder',
            messages: [{ role: 'user', content: `question ${number}` }],
          }),
        }),
      ),
    ),
  );
  const ids = await Promise.all(
    replies.map(async (reply) => String(Object(await reply.json()).id)),
  );

  expect(made).toBe(1);
  expect(sent.sort()).toEqual(
    ids.map(
      (id, number) =>
        `question ${number} with Bearer temporary-caller-${number}-${id.replace('chatcmpl-', '')}`,
    ),
  );
  await served.close();
});

test('a request being answered is taken off the idle timeout of the server', async () => {
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
  }));
  using server = Bun.serve({ port: 0, idleTimeout: 1, fetch: served.fetch });
  const timeouts = spyOn(server, 'timeout');

  await fetch(`http://localhost:${server.port}/v1/models`);
  expect(timeouts).not.toHaveBeenCalled();
  const reply = await ask(server.port, false);

  expect(reply.status).toBe(200);
  expect(timeouts.mock.calls).toEqual([[expect.any(Request), 0]]);
  await served.close();
});

test('the model list and the scripted models of the test kit work over the wire', async () => {
  const served = mount(coder, () => ({
    models: [fake(on(gpt, 'Use a mutex.'))],
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const list = await fetch(`http://localhost:${server.port}/v1/models`);
  expect(await list.json()).toMatchObject({ data: [{ id: 'coder' }] });
  const reply = await ask(server.port, false);
  expect(await reply.json()).toMatchObject({
    choices: [{ message: { content: 'Use a mutex.' } }],
  });
  await served.close();
});
