import { expect, test } from 'bun:test';

test.each(['SIGTERM', 'SIGINT'] as const)(
  'a serve file run by Bun serves its default export, and %s lets the request in flight finish before the process ends',
  async (signal) => {
    // The process takes a port of its own and Bun prints it: a port found
    // free beforehand may be taken by another test before the process binds.
    const host = Bun.spawn(
      [process.execPath, 'run', `${import.meta.dir}/self-host.ts`],
      { env: { ...Bun.env, PORT: '0' }, stdout: 'pipe' },
    );
    const printed = host.stdout.getReader();
    const decoder = new TextDecoder();
    let output = '';
    // With nothing wanted, reads until the process closes its output.
    async function readUntil(wanted?: RegExp): Promise<void> {
      while (!wanted?.test(output)) {
        const { done, value } = await printed.read();
        if (done) return;
        output += decoder.decode(value, { stream: true });
      }
    }
    await readUntil(/http:\/\/localhost:\d+/);
    const port = /http:\/\/localhost:(\d+)/.exec(output)?.[1];
    if (port === undefined) throw new Error(`No port was printed: ${output}`);

    const asked = fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'coder',
        messages: [{ role: 'user', content: 'Why does this deadlock?' }],
      }),
    });
    await readUntil(/asked\n/);
    host.kill(signal);

    const reply = await asked;
    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      choices: [{ message: { content: 'Use a mutex.' } }],
    });
    expect(await host.exited).toBe(0);
    await readUntil();
    expect(output).toMatch(
      /asked\n(.*\n)*after-response work done\nreport: completed\n$/,
    );
    await expect(fetch(`http://localhost:${port}/v1/models`)).rejects.toThrow();
  },
);
