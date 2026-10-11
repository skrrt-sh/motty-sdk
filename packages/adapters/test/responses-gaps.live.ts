import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { openai } from '../src/openai.ts';

// Real calls that cost money: the file is not a `.test.ts`, so a plain
// `bun test` does not run it, and without a key nothing in it runs.
const { OPENAI_KEY: openaiKey, OPENROUTER_KEY: openrouterKey } = Bun.env;

describe.skipIf(openrouterKey === undefined || openrouterKey === '')(
  'A router that speaks the Responses API',
  () => {
    test('caches a prefix a caller marked, where the host said it takes a breakpoint', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('router/anthropic/claude-haiku-4.5').complete(prompt),
        ),
        () => ({
          models: [
            openai({
              key: openrouterKey,
              address: 'https://openrouter.ai/api/v1',
              prefix: 'router',
              breakpoints: true,
            }),
          ],
          report: (report) => reports.push(report),
        }),
      );
      const body = JSON.stringify({
        model: 'relay',
        max_tokens: 20,
        system: [
          {
            type: 'text',
            text: `${crypto.randomUUID()} ${'The archive keeps every ledger of the harbour office in order. '.repeat(700)}`,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: 'Say ok.' }],
      });

      for (const _ of [1, 2]) {
        const reply = await served.fetch(
          new Request('http://localhost/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
            },
            body,
          }),
        );
        await reply.text();
        expect(reply.status).toBe(200);
      }
      await served.close();

      expect(reports).toMatchObject([
        { outcome: 'completed' },
        { outcome: 'completed' },
      ]);
      const [first, second] = reports.map((report) => report.calls[0]);
      expect(first?.cacheWrite).toBeGreaterThan(0);
      expect(second?.cached).toBe(first?.cacheWrite);
      expect(first).not.toHaveProperty('warnings');
    });
  },
);

describe.skipIf(openaiKey === undefined || openaiKey === '')(
  'A picture the image tool of the Responses API made',
  () => {
    test('reaches a Chat Completions caller under the type its own bytes begin as', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openai/gpt-4.1-mini').complete(prompt),
        ),
        () => ({
          models: [
            openai({
              key: openaiKey,
              body: {
                tool_choice: { type: 'image_generation' },
                tools: [
                  {
                    type: 'image_generation',
                    model: 'gpt-image-1-mini',
                    quality: 'low',
                    size: '1024x1024',
                    output_format: 'webp',
                    output_compression: 20,
                  },
                ],
              },
            }),
          ],
          report: (report) => reports.push(report),
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            messages: [{ role: 'user', content: 'Draw a plain red square.' }],
          }),
        }),
      );
      const text = await reply.text();
      await served.close();

      expect(reply.status).toBe(200);
      expect(reports).toMatchObject([{ outcome: 'completed' }]);
      // OpenAI names the format, so this holds the real bytes of that type
      // to the beginning a type is read from where none is named.
      expect(text).toMatch(
        /"images":\[\{"type":"image_url","image_url":\{"url":"data:image\/webp;base64,UklGR.{6}XRUJQ/,
      );
    });
  },
);
