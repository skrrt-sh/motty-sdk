import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { openai } from '../src/openai.ts';
import { harnessed } from './harness.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key or the harness on the path
// nothing in it runs.
const { ANTHROPIC_KEY, OPENAI_KEY } = Bun.env;
const claude = Bun.which('claude');

describe.each([
  ['its own family', anthropic, ANTHROPIC_KEY, 'anthropic/claude-haiku-5-5'],
  ['another family', openai, OPENAI_KEY, 'openai/gpt-6-luna'],
])(
  'driven by Claude Code, answered by a model of %s',
  (_, adapter, key, id) => {
    test.skipIf(key === undefined || key === '' || claude === null)(
      'a task that needs two of the harness’s tools is done through a motty',
      async () => {
        const reports: Report[] = [];
        const served = mount(
          motty({ name: 'relay' }).handle(({ prompt }) => {
            // The harness asks for things only its own family can do, and a
            // model of another family refuses a request that carries them.
            if (adapter !== anthropic) {
              const { provider: _provider, ...options } = prompt.options ?? {};
              prompt.options = options;
            }
            return model(id).complete(prompt);
          }),
          () => ({
            models: [adapter({ key })],
            report: (report) => reports.push(report),
          }),
        );
        const dir = await mkdtemp(join(tmpdir(), 'motty-claude-code-'));
        try {
          using server = Bun.serve({ port: 0, fetch: served.fetch });
          await Bun.write(join(dir, 'note.txt'), 'The word is heron.\n');

          // The harness is given no key of the provider's: the one it sends is
          // made up, and the real one stays with the host.
          const told = await harnessed(
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
            dir,
            {
              CLAUDE_CONFIG_DIR: join(dir, '.claude'),
              ANTHROPIC_BASE_URL: `http://localhost:${server.port}`,
              ANTHROPIC_API_KEY: 'not-a-key',
              ANTHROPIC_DEFAULT_HAIKU_MODEL: 'relay',
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            },
          );

          expect(told).toMatchObject({ exit: 0 });
          expect(await Bun.file(join(dir, 'note.txt')).text()).toBe(
            'The word is HERON.\n',
          );
        } finally {
          await served.close();
          await rm(dir, { recursive: true });
        }

        // One request to ask for each tool and one to say it is done.
        expect(reports.length).toBeGreaterThanOrEqual(3);
        for (const report of reports) {
          expect(report).toMatchObject({ outcome: 'completed', path: [] });
          // What one family asks for and another cannot carry is left out and
          // told as a warning, so only a model of its own family has none.
          if (adapter === anthropic) {
            expect(report).not.toHaveProperty('warnings');
          }
        }
      },
      120_000,
    );
  },
);
