import { answer, motty } from '@mottyjs/core';
import { mount } from '@mottyjs/serve';

// Copied beside the packed packages and run there by Bun, which reads them
// through the `bun` condition: a host with a server of its own hands mount
// each request.
const echo = motty({ name: 'echo' }).handle(() => answer('Use a mutex.'));
const { fetch, close } = mount(echo, () => ({}));
const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request) => fetch(request),
});

async function asked(stream: boolean): Promise<string> {
  const reply = await globalThis.fetch(
    `${server.url.origin}/v1/chat/completions`,
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
await server.stop();
