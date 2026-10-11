import { expect, test } from 'bun:test';

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = probe;
  await probe.stop(true);
  if (port === undefined) throw new Error('The probe was given no port');
  return port;
}

async function listening(port: number): Promise<void> {
  for (;;) {
    const up = await fetch(`http://localhost:${port}/v1/models`).catch(
      () => undefined,
    );
    if (up?.ok) return;
    await Bun.sleep(20);
  }
}

test.each(['SIGTERM', 'SIGINT'] as const)(
  'a serve file run by Bun serves its default export, and %s lets the request in flight finish before the process ends',
  async (signal) => {
    const port = await freePort();
    const host = Bun.spawn(
      [process.execPath, 'run', `${import.meta.dir}/self-host.ts`],
      { env: { ...Bun.env, PORT: String(port) }, stdout: 'pipe' },
    );
    await listening(port);
    const printed = host.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';

    const asked = fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'coder',
        messages: [{ role: 'user', content: 'Why does this deadlock?' }],
      }),
    });
    while (!output.includes('asked')) {
      const { done, value } = await printed.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    host.kill(signal);

    const reply = await asked;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      choices: [{ message: { content: 'Use a mutex.' } }],
    });
    expect(await host.exited).toBe(0);
    for (;;) {
      const { done, value } = await printed.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
    }
    expect(output).toMatch(
      /asked\n(.*\n)*after-response work done\nreport: completed\n$/,
    );
    await expect(fetch(`http://localhost:${port}/v1/models`)).rejects.toThrow();
  },
);
