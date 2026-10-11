import { expect, spyOn, test } from 'bun:test';
import { auth } from '@mottyjs/auth';
import { answer, motty } from '@mottyjs/core';
import { mount } from '../src/index.ts';

const coder = motty({ name: 'coder' }).handle(() => answer('Use a mutex.'));

// What the server wrote before it closed the socket, or before the wait ran
// out with the socket still open.
async function written(
  port: number | undefined,
  sent: string,
): Promise<{ reply: string; closed: boolean }> {
  let reply = '';
  const over = Promise.withResolvers<boolean>();
  const socket = await Bun.connect({
    hostname: 'localhost',
    port: port ?? 0,
    socket: {
      data: (_socket, chunk) => {
        reply += chunk.toString();
      },
      close: () => over.resolve(true),
      error: () => over.resolve(true),
    },
  });
  socket.write(sent);
  const closed = await Promise.race([
    over.promise,
    Bun.sleep(1_500).then(() => false),
  ]);
  socket.end();
  return { reply, closed };
}

test.each(['/v1/chat/completions', '/v1/responses', '/v1/messages'])(
  'a body that stops arriving is answered 408 and its socket closed, with no idle timeout to end it: %s',
  async (path) => {
    const served = mount(coder, () => ({ limits: { duration: 3_000 } }), {
      receive: 100,
    });
    using server = Bun.serve({ port: 0, idleTimeout: 0, fetch: served.fetch });
    const timeouts = spyOn(server, 'timeout');

    const { reply, closed } = await written(
      server.port,
      `POST ${path} HTTP/1.1\r\nHost: motty.test\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"model":`,
    );

    expect(closed).toBe(true);
    expect(reply).toStartWith('HTTP/1.1 408 ');
    expect(reply).toContain('The body did not arrive within 100 ms');
    expect(timeouts).not.toHaveBeenCalled();
    await served.close();
  },
);

test('a body that stops arriving is bounded under a mounted edge with no server', async () => {
  const served = mount(coder, () => ({}), { receive: 50 });

  const reply = await served.fetch(
    new Request('http://motty.test/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        start: (controller) =>
          controller.enqueue(new TextEncoder().encode('{"model":')),
      }),
    }),
  );

  expect(reply.status).toBe(408);
  expect(reply.headers.get('connection')).toBe('close');
  expect(await reply.json()).toMatchObject({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: 'The body did not arrive within 50 ms',
    },
  });
});

test('a body that arrives in time is taken off the idle timeout and answered', async () => {
  const served = mount(coder, () => ({}), { receive: 5_000 });
  using server = Bun.serve({ port: 0, idleTimeout: 1, fetch: served.fetch });

  const reply = await fetch(`http://localhost:${server.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
  });

  expect(reply.status).toBe(200);
  await served.close();
});

test('a stated length over the limit is refused before a byte of the body is read, and no caller is looked up', async () => {
  let verified = 0;
  const served = mount(motty({ name: 'coder' }).use(auth()), () => ({
    auth: {
      verify: () => {
        verified += 1;
        return { id: 'ada' };
      },
    },
    limits: { body: 1_000 },
  }));
  using server = Bun.serve({ port: 0, idleTimeout: 0, fetch: served.fetch });

  const { reply, closed } = await written(
    server.port,
    'POST /v1/chat/completions HTTP/1.1\r\nHost: motty.test\r\nAuthorization: Bearer sk-ada\r\nContent-Type: application/json\r\nContent-Length: 64000000\r\n\r\n',
  );

  expect(closed).toBe(true);
  expect(reply).toStartWith('HTTP/1.1 413 ');
  expect(reply).toContain(
    'The body is larger than the 1000 bytes this server takes',
  );
  expect(verified).toBe(0);
  await served.close();
});

test.each([
  ['/v1/chat/completions', {}, { error: { type: 'invalid_request_error' } }],
  ['/v1/responses', {}, { error: { type: 'invalid_request_error' } }],
  [
    '/v1/messages',
    { 'anthropic-version': '2023-06-01' },
    { type: 'error', error: { type: 'request_too_large' } },
  ],
])(
  'a body over the limit is a 413 in the error shape of its API: %s',
  async (path, headers, body) => {
    const served = mount(coder, () => ({ limits: { body: 1_000 } }));

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': '1001',
          ...headers,
        },
        body: 'x'.repeat(1_001),
      }),
    );

    expect(reply.status).toBe(413);
    expect(reply.headers.get('connection')).toBe('close');
    expect(await reply.json()).toMatchObject(body);
  },
);

test('a body with no stated length, or more of it than was stated, is cut at the limit while it is read', async () => {
  const served = mount(coder, () => ({ limits: { body: 1_000 } }));
  const pulled = { unstated: 0, understated: 0 };

  const replies = await Promise.all(
    [
      ['unstated', {}] as const,
      ['understated', { 'content-length': '10' }] as const,
    ].map(([how, headers]) =>
      served.fetch(
        new Request('http://motty.test/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: new ReadableStream<Uint8Array>({
            pull: (controller) => {
              pulled[how] += 1;
              if (pulled[how] > 50) controller.close();
              else controller.enqueue(new Uint8Array(400));
            },
          }),
        }),
      ),
    ),
  );

  expect(replies.map(({ status }) => status)).toEqual([413, 413]);
  expect(pulled.unstated).toBeLessThan(10);
  expect(pulled.understated).toBeLessThan(10);
});

test('a body of exactly the limit is taken, and with no limit stated 32 MB is the limit', async () => {
  const body = JSON.stringify({
    model: 'coder',
    messages: [{ role: 'user', content: 'Why does this deadlock?' }],
  });
  const exact = mount(coder, () => ({ limits: { body: body.length } }));
  const plain = mount(coder, () => ({}));

  const taken = await exact.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  const refused = await plain.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(32 * 1024 * 1024 + 1),
      },
      body,
    }),
  );

  expect(taken.status).toBe(200);
  expect(refused.status).toBe(413);
});

test.each([
  [{ limits: { body: Number.NaN } }, {}, 'limits.body', 'whole'],
  [{ limits: { body: 0.5 } }, {}, 'limits.body', 'whole'],
  [{ limits: { calls: 1.5 } }, {}, 'limits.calls', 'whole'],
  [{ limits: { duration: -1 } }, {}, 'limits.duration', 'finite'],
  [{}, { receive: Number.NaN }, 'receive', 'finite'],
  [{}, { receive: -1 }, 'receive', 'finite'],
  [{}, { receive: Number.POSITIVE_INFINITY }, 'receive', 'finite'],
  [{}, { keepAlive: Number.NaN }, 'keepAlive', 'finite'],
  [{}, { keepAlive: -1 }, 'keepAlive', 'finite'],
  [{}, { keepAlive: Number.POSITIVE_INFINITY }, 'keepAlive', 'finite'],
  [{}, { drain: Number.NaN }, 'drain', 'finite'],
  [{}, { drain: -1 }, 'drain', 'finite'],
  [{}, { drain: Number.POSITIVE_INFINITY }, 'drain', 'finite'],
])(
  'a limit or a time of the edge that is no number of zero or more fails when the host is made, named: %o %o',
  (options, edge, name, kind) => {
    expect(() => mount(coder, () => options, edge)).toThrow(
      `${name} must be a ${kind} number of zero or more`,
    );
  },
);
