import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { openai } from '../src/openai.ts';
import { harnessed } from './harness.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key or the harness on the path
// nothing in it runs.
const { OPENAI_KEY: key } = Bun.env;
const codex = Bun.which('codex');

describe.skipIf(key === undefined || key === '' || codex === null)(
  'driven by Codex',
  () => {
    // The name the harness is given decides the form of its request, and the
    // motty answers with the same small model under either.
    test.each([
      ['in a tools array, under a name the harness does not know', 'relay'],
      ['in an input item, under a name the harness knows', 'gpt-6.1-sol'],
    ])(
      'subagents are spawned through a motty with the tools declared %s',
      async (_, name) => {
        const reports: Report[] = [];
        const subagents = new Set<string>();
        const served = mount(
          motty({ name: 'relay' }).handle(({ request, prompt }) => {
            // The harness says on every request which of its agents is asking.
            // Only one of the two forms gives a subagent a name of its own, so
            // each is counted by the thread it runs in.
            const turn = request.headers.get('x-codex-turn-metadata') ?? '';
            if (turn.includes('"thread_source":"subagent"')) {
              subagents.add(/"thread_id":"[^"]+"/.exec(turn)?.[0] ?? '');
            }
            return model('openai/gpt-6-luna').complete(prompt);
          }),
          () => ({
            models: [openai({ key })],
            report: (report) => reports.push(report),
          }),
        );
        const dir = await mkdtemp(join(tmpdir(), 'motty-codex-'));
        try {
          // A lead waiting on its subagents holds one connection open for
          // longer than the server lets an idle one live by default.
          using server = Bun.serve({
            port: 0,
            fetch: served.fetch,
            idleTimeout: 240,
          });
          for (const file of ['orders', 'payments', 'users']) {
            await Bun.write(
              join(dir, `${file}.ts`),
              `export const ${file} = () => "${file} are listed here";\n`,
            );
          }
          await mkdir(join(dir, '.codex'));

          // The harness is given no key of the provider's: the one it sends
          // is made up, and the real one stays with the host.
          const told = await harnessed(
            [
              codex ?? 'codex',
              'exec',
              '--skip-git-repo-check',
              '-m',
              name,
              '-c',
              'model_provider="relay"',
              '-c',
              `model_providers.relay={name="relay",base_url="http://localhost:${server.port}/v1",env_key="RELAY_KEY",wire_api="responses"}`,
              'Spawn three subagents in parallel, one per file (orders.ts, payments.ts, users.ts). Each reads its file and says in one sentence what it does. Then list the three sentences.',
            ],
            dir,
            { CODEX_HOME: join(dir, '.codex'), RELAY_KEY: 'not-a-key' },
          );

          expect(told).toMatchObject({ exit: 0 });
          expect(told.complained).not.toContain('unsupported call');
        } finally {
          await served.close();
          await rm(dir, { recursive: true });
        }

        // The harness hangs up on a subagent it closes mid-answer, which is its
        // own doing and no failure of the motty.
        for (const report of reports) {
          expect(report.outcome).not.toBe('failed');
          expect(report).not.toHaveProperty('warnings');
        }
        expect(subagents.size).toBeGreaterThanOrEqual(3);
      },
      240_000,
    );
  },
);
