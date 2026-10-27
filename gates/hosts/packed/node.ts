import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { answer, motty } from '@mottyjs/core';
import { mount } from '@mottyjs/serve';

// Copied beside the packed packages and run there by Node and by Bun: all a
// host on node:http writes to hand mount a web request and stream its reply.
const echo = motty({ name: 'echo' }).handle(() => answer('Use a mutex.'));
const { fetch, close } = mount(echo, () => ({}));

const server = createServer(async (incoming, outgoing) => {
  const left = new AbortController();
  outgoing.on('close', () => {
    if (!outgoing.writableFinished) left.abort();
  });
  const bodiless = incoming.method === 'GET' || incoming.method === 'HEAD';
  const reply = await fetch(
    new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method ?? 'GET',
      headers: Object.entries(incoming.headersDistinct).flatMap(
        ([name, values = []]) => values.map((value) => [name, value]),
      ),
      body: bodiless ? null : Readable.toWeb(incoming),
      signal: left.signal,
      duplex: 'half',
    }),
  );
  outgoing.writeHead(reply.status, [...reply.headers].flat());
  if (reply.body !== null) {
    for await (const piece of reply.body) outgoing.write(piece);
  }
  outgoing.end();
});

await new Promise<void>((listening) =>
  server.listen(0, '127.0.0.1', listening),
);
const address = server.address();
if (address === null || typeof address === 'string') {
  throw new Error('The server listens on no port');
}
const { port } = address;

async function asked(stream: boolean): Promise<string> {
  const reply = await globalThis.fetch(
    `http://127.0.0.1:${port}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'echo',
        stream,
        messages: [{ role: 'user', content: 'Which lock?' }],
      }),
    },
  );
  return `${reply.status} ${(await reply.text()).includes('Use a mutex.')}`;
}

console.log(
  JSON.stringify({
    resolved: import.meta.resolve('@mottyjs/core').replace(/.*\/core\//, ''),
    whole: await asked(false),
    streamed: await asked(true),
  }),
);
await close();
server.close();
