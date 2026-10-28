import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { ModelAdapter, Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { openai } from '../src/openai.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { ANTHROPIC_KEY: anthropicKey, OPENAI_KEY: openaiKey } = Bun.env;

// What a caller of Chat Completions gets who asks one model for one effort.
async function asked(adapter: ModelAdapter, name: string, effort: string) {
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model(name).complete(prompt),
    ),
    () => ({ models: [adapter], report: (report) => reports.push(report) }),
  );
  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        max_completion_tokens: 400,
        reasoning_effort: effort,
        messages: [{ role: 'user', content: 'Say ok.' }],
      }),
    }),
  );
  const said = await reply.text();
  await served.close();
  return {
    effort,
    status: reply.status,
    said: reply.status === 200 ? '' : said,
    warnings: reports[0]?.calls[0]?.warnings?.map(({ setting }) => setting),
  };
}

// The ends of the ladder are where the models differ, so each is asked for
// the order not to reason, the lowest level and the two highest.
const ends = ['none', 'minimal', 'xhigh', 'max'];
const answered = ends.map((effort) => ({ effort, status: 200, said: '' }));

describe.skipIf(anthropicKey === undefined || anthropicKey === '')(
  'every effort asked of every Claude model',
  () => {
    test.each([
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-fable-5-1',
    ])('%s answers at each end of the ladder', async (name) => {
      const adapter = anthropic({ key: anthropicKey });
      const replies = [];
      for (const effort of ends) {
        replies.push(await asked(adapter, `anthropic/${name}`, effort));
      }

      expect(replies).toMatchObject(answered);
    });

    test('a level Opus 4.6 has no word for goes as the nearest it has, and the record says so', async () => {
      const { status, warnings } = await asked(
        anthropic({ key: anthropicKey }),
        'anthropic/claude-opus-4-6',
        'xhigh',
      );

      expect(status).toBe(200);
      expect(warnings).toEqual(['reasoning.level']);
    });
  },
);

describe.skipIf(openaiKey === undefined || openaiKey === '')(
  'every effort asked of every OpenAI model',
  () => {
    test.each(
      (['responses', 'chat-completions'] as const).flatMap((api) =>
        [
          'gpt-4.1',
          'gpt-4o-mini',
          'chat-latest',
          'o3',
          'gpt-5',
          'gpt-5-mini',
          'gpt-5-nano',
          'gpt-5.1',
          'gpt-5.2',
          'gpt-5.4',
          'gpt-5.4-mini',
          'gpt-5.4-nano',
          'gpt-5.5',
          'gpt-5.6-luna',
          'gpt-5.6-sol',
          'gpt-5.6-terra',
          'gpt-6-luna',
          'gpt-6-sol',
          'gpt-6-astra',
          'gpt-6.1-sol',
        ].map((name) => [name, api] as const),
      ),
    )('%s answers at each end of the ladder over %s', async (name, api) => {
      const adapter = openai({ key: openaiKey, api });
      const replies = await Promise.all(
        ends.map((effort) => asked(adapter, `openai/${name}`, effort)),
      );

      expect(replies).toMatchObject(answered);
    });

    test('an order not to reason goes to GPT-6.1 Sol as its lowest level, and the record says so', async () => {
      const { status, warnings } = await asked(
        openai({ key: openaiKey }),
        'openai/gpt-6.1-sol',
        'none',
      );

      expect(status).toBe(200);
      expect(warnings).toEqual(['reasoning.level']);
    });
  },
);
