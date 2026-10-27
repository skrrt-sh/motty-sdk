import { expect, jest, test } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { chatCompletions, messages, responses } from '@mottyjs/serve';
import { chat } from '../src/chat.ts';

// Bun's own server does not say how many connections it took.
async function upstreamReplying(reply: (response: ServerResponse) => void) {
  const server = createServer((request, response) => {
    request.resume().on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      reply(response);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function addressOf(server: Server) {
  const at = server.address();
  return at === null || typeof at === 'string'
    ? ''
    : `http://127.0.0.1:${at.port}`;
}

const finished =
  'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

function asked(address: string, signal: AbortSignal) {
  const { call } = chat({
    codec: chatCompletions,
    prefix: 'acme',
    address,
    key: 'sk-host',
  });
  if (call === undefined) throw new Error('A chat adapter has no call');
  return call(
    'acme/small',
    { messages: [{ role: 'user', text: 'hi' }] },
    signal,
  );
}

test.each([
  ['Chat Completions', chatCompletions, finished],
  [
    'Responses',
    responses,
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
  ],
  [
    'Messages',
    messages,
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"small","content":[],"stop_reason":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  ],
])(
  'a %s body that ends in a later write than its last event keeps the connection for the next call',
  async (_, codec, stream) => {
    let connections = 0;
    await using upstream = await upstreamReplying((response) => {
      response.write(stream);
      setTimeout(() => response.end(), 1);
    });
    upstream.on('connection', () => {
      connections += 1;
    });
    const { call } = chat({
      codec,
      prefix: 'acme',
      address: addressOf(upstream),
      key: 'sk-host',
    });

    const ends: string[] = [];
    for (let sent = 0; sent < 5; sent += 1) {
      const ending = new AbortController();
      const events = await Array.fromAsync(
        call?.(
          'acme/small',
          { messages: [{ role: 'user', text: 'hi' }] },
          ending.signal,
        ) ?? [],
      );
      ends.push(events.at(-1)?.type ?? 'none');
      // A signal fired once the call has ended stops nothing of it.
      ending.abort();
      // The end of the body is on its way: the next call comes after it.
      await Bun.sleep(100);
    }

    expect(ends).toEqual(['finish', 'finish', 'finish', 'finish', 'finish']);
    expect(connections).toBe(1);
  },
);

test('a signal fired on the last event, before the call is closed, keeps the connection for the next call', async () => {
  let connections = 0;
  await using upstream = await upstreamReplying((response) => {
    response.write(finished);
    setTimeout(() => response.end(), 1);
  });
  upstream.on('connection', () => {
    connections += 1;
  });

  for (let sent = 0; sent < 5; sent += 1) {
    const ending = new AbortController();
    const events = asked(addressOf(upstream), ending.signal)[
      Symbol.asyncIterator
    ]();
    for (let last = await events.next(); ; last = await events.next()) {
      if (last.done === true) throw new Error('The call said no last event');
      if (last.value.type === 'finish') break;
    }
    // Whoever ends a request fires its signal first and closes the call after.
    ending.abort();
    await events.return?.();
    await Bun.sleep(100);
  }

  expect(connections).toBe(1);
});

test('a call ends with its last event while its body is still open', async () => {
  // The time an adapter gives a body to end never passes here, so the call
  // ends on nothing but its last event.
  jest.useFakeTimers();
  try {
    const held = Promise.withResolvers<ServerResponse>();
    await using upstream = await upstreamReplying((response) => {
      response.write(finished);
      held.resolve(response);
    });

    const events = await Array.fromAsync(
      asked(addressOf(upstream), AbortSignal.timeout(5000)),
    );
    const response = await held.promise;

    expect(events.at(-1)?.type).toBe('finish');
    expect(response.writableEnded).toBe(false);
    response.end();
  } finally {
    jest.useRealTimers();
  }
});

test('a call stopped in the middle of its stream closes its request at the upstream', async () => {
  const closed = Promise.withResolvers<void>();
  await using upstream = await upstreamReplying((response) => {
    response.on('close', closed.resolve);
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
    );
  });
  const stop = new AbortController();
  const events = asked(addressOf(upstream), stop.signal)[
    Symbol.asyncIterator
  ]();

  expect(await events.next()).toMatchObject({ value: { type: 'text' } });
  stop.abort();

  await closed.promise;
  expect(await events.next()).toMatchObject({
    value: { type: 'error', error: { code: 'aborted' } },
  });
});

test('a call left before its last event closes its request at the upstream', async () => {
  jest.useFakeTimers();
  try {
    const closed = Promise.withResolvers<void>();
    await using upstream = await upstreamReplying((response) => {
      response.on('close', closed.resolve);
      response.write(
        'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
      );
    });
    const events = asked(addressOf(upstream), AbortSignal.timeout(5000))[
      Symbol.asyncIterator
    ]();

    await events.next();
    await events.return?.();

    await closed.promise;
  } finally {
    jest.useRealTimers();
  }
});

test('a body that goes on past its last event is read no further than a failure is', async () => {
  // The time an adapter gives a body to end never passes here, so only the
  // length it reads can end this one.
  jest.useFakeTimers();
  try {
    const closed = Promise.withResolvers<void>();
    let written = 0;
    await using upstream = await upstreamReplying((response) => {
      response.on('close', closed.resolve);
      response.write(finished);
      const more = () => {
        if (response.closed) return;
        written += 16_384;
        response.write(`: ${'-'.repeat(16_380)}\n\n`, more);
      };
      more();
    });

    const events = await Array.fromAsync(
      asked(addressOf(upstream), AbortSignal.timeout(5000)),
    );
    await closed.promise;

    expect(events.at(-1)?.type).toBe('finish');
    expect(written).toBeGreaterThan(65_536);
  } finally {
    jest.useRealTimers();
  }
});

test('a body held open past its last event is let go after a second', async () => {
  jest.useFakeTimers();
  try {
    const closed = Promise.withResolvers<void>();
    await using upstream = await upstreamReplying((response) => {
      response.on('close', closed.resolve);
      response.write(finished);
    });

    await Array.fromAsync(
      asked(addressOf(upstream), AbortSignal.timeout(5000)),
    );
    jest.advanceTimersByTime(1000);

    await closed.promise;
  } finally {
    jest.useRealTimers();
  }
});

test('a failure told in a body of its own keeps the connection for the next call', async () => {
  let connections = 0;
  const server = createServer((request, response) => {
    request.resume().on('end', () => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"Slow down","type":"rate_limit"}}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await using upstream = server;
  upstream.on('connection', () => {
    connections += 1;
  });

  const codes: (string | undefined)[] = [];
  for (let sent = 0; sent < 3; sent += 1) {
    const events = await Array.fromAsync(
      asked(addressOf(upstream), AbortSignal.timeout(5000)),
    );
    const last = events.at(-1);
    codes.push(last?.type === 'error' ? last.error.code : undefined);
  }

  expect(codes).toEqual(['rate_limited', 'rate_limited', 'rate_limited']);
  expect(connections).toBe(1);
});
