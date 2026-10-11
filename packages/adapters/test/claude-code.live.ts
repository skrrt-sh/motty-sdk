import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key or the harness on the path
// nothing in it runs.
const { ANTHROPIC_KEY: key, PATH } = Bun.env;
const claude = Bun.which('claude');

describe.skipIf(key === undefined || key === '' || claude === null)(
  'driven by Claude Code',
  () => {
    test('a task that needs two of the harness’s tools is done through a motty', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('anthropic/claude-haiku-5-5').complete(prompt),
        ),
        () => ({
          models: [anthropic({ key })],
          report: (report) => reports.push(report),
        }),
      );
      using server = Bun.serve({ port: 0, fetch: served.fetch });
      const dir = await mkdtemp(join(tmpdir(), 'motty-claude-code-'));
      await Bun.write(join(dir, 'note.txt'), 'The word is heron.\n');

      // The harness is given no key of the provider's: the one it sends is
      // made up, and the real one stays with the host.
      const harness = Bun.spawn(
        [
          claude ?? 'claude',
          '--bare',
          '--print',
          'Read note.txt, then edit it so that the word it names is in upper case.',
          '--model',
          'relay',
          '--tools',
          'Read,Edit',
          '--permission-mode',
          'acceptEdits',
          '--strict-mcp-config',
          '--no-session-persistence',
        ],
        {
          cwd: dir,
          env: {
            PATH,
            HOME: dir,
            CLAUDE_CONFIG_DIR: join(dir, '.claude'),
            ANTHROPIC_BASE_URL: `http://localhost:${server.port}`,
            ANTHROPIC_API_KEY: 'not-a-key',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [exit, said, complained] = await Promise.all([
        harness.exited,
        harness.stdout.text(),
        harness.stderr.text(),
      ]);
      const note = await Bun.file(join(dir, 'note.txt')).text();
      await served.close();
      await rm(dir, { recursive: true });

      expect({ exit, said, complained }).toMatchObject({ exit: 0 });
      expect(note).toBe('The word is HERON.\n');
      // One request to ask for each tool and one to say it is done.
      expect(reports.length).toBeGreaterThanOrEqual(3);
      for (const report of reports) {
        expect(report).toMatchObject({ outcome: 'completed', path: [] });
        expect(report).not.toHaveProperty('warnings');
      }
    }, 120_000);
  },
);
