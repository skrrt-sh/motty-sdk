import { expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error('The probe was given no port');
  return port;
}

// Empty while nothing listens, as between two runs of the serve file.
async function said(port: number): Promise<string> {
  const reply = await fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
  }).catch(() => undefined);
  return reply?.ok ? reply.text() : '';
}

// A wait that ends by itself: a server that never takes the edit fails the
// test, and the process it started is still stopped.
async function until(met: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await met())) {
    if (Date.now() > deadline) throw new Error('Not within ten seconds');
    await Bun.sleep(20);
  }
}

test('an edit to the motty of a serve file Bun watches changes the next answer, and so does the fix of an edit that does not load', async () => {
  const port = await freePort();
  const copy = await mkdtemp(`${tmpdir()}/motty-watch-`);
  await cp(`${import.meta.dir}/watch`, copy, { recursive: true });
  await mkdir(`${copy}/node_modules/@mottyjs`, { recursive: true });
  await symlink(`${import.meta.dir}/..`, `${copy}/node_modules/@mottyjs/serve`);
  await symlink(
    `${import.meta.dir}/../node_modules/@mottyjs/core`,
    `${copy}/node_modules/@mottyjs/core`,
  );
  const written = await Bun.file(`${copy}/motty.ts`).text();
  const host = Bun.spawn([process.execPath, '--watch', `${copy}/serve.ts`], {
    env: { ...Bun.env, PORT: String(port) },
    stdout: 'ignore',
    stderr: Bun.file(`${copy}/errors`),
  });
  try {
    await until(async () => (await said(port)).includes('Use a mutex.'));

    await Bun.write(
      `${copy}/motty.ts`,
      written.replace('Use a mutex.', 'Use a channel.'),
    );
    await until(async () => (await said(port)).includes('Use a channel.'));

    await Bun.write(`${copy}/motty.ts`, 'export default {');
    await until(async () =>
      (await Bun.file(`${copy}/errors`).text()).includes('error'),
    );
    expect(await said(port)).toBe('');

    await Bun.write(
      `${copy}/motty.ts`,
      written.replace('Use a mutex.', 'Use a queue.'),
    );
    await until(async () => (await said(port)).includes('Use a queue.'));
  } finally {
    host.kill('SIGKILL');
    await host.exited;
    await rm(copy, { recursive: true });
  }
}, 60_000);
