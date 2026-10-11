import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { openrouter } from '../src/openrouter.ts';

// Real calls that cost money: the file is not a `.test.ts`, so a plain
// `bun test` does not run it, and without a key nothing in it runs.
const { ANTHROPIC_KEY: anthropicKey, OPENROUTER_KEY: openrouterKey } = Bun.env;

describe.skipIf(anthropicKey === undefined || anthropicKey === '')(
  "Claude's thinking for a Responses caller",
  () => {
    test('is streamed as a summary, and the finished item holds the same text', async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('anthropic/claude-haiku-5-5').complete(prompt),
        ),
        () => ({ models: [anthropic({ key: anthropicKey })] }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            stream: true,
            store: false,
            max_output_tokens: 1500,
            reasoning: { effort: 'medium', summary: 'auto' },
            input:
              'What is 17 * 23? Think it through step by step, then answer with the number.',
          }),
        }),
      );
      const text = await reply.text();
      await served.close();
      const streamed = [
        ...text.matchAll(
          /"type":"response\.reasoning_summary_text\.delta".*?"delta":("(?:[^"\\]|\\.)*")/g,
        ),
      ]
        .map(([, piece = '""']) => JSON.parse(piece))
        .join('');
      const finished = [
        ...text.matchAll(
          /"type":"response\.reasoning_summary_text\.done".*?"text":("(?:[^"\\]|\\.)*")/g,
        ),
      ].map(([, piece = '""']) => piece);

      expect(reply.status).toBe(200);
      expect(streamed.trim()).not.toBe('');
      expect(finished.map((piece) => JSON.parse(piece)).join('')).toBe(
        streamed,
      );
      for (const piece of finished) {
        expect(text).toContain(
          `"summary":[{"type":"summary_text","text":${piece}}]`,
        );
      }
      expect(text).toContain('event: response.reasoning_summary_part.added');
      expect(text).toContain('event: response.reasoning_summary_part.done');
      expect(text).not.toContain('reasoning_text');
      expect(text).toContain('event: response.completed');
    });

    test('is the summary of the reasoning item in a reply that is not streamed', async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('anthropic/claude-haiku-5-5').complete(prompt),
        ),
        () => ({ models: [anthropic({ key: anthropicKey })] }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            store: false,
            max_output_tokens: 1500,
            reasoning: { effort: 'medium', summary: 'auto' },
            input:
              'What is 17 * 23? Think it through step by step, then answer with the number.',
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            summary: [
              { type: 'summary_text', text: expect.stringMatching(/\S/) },
            ],
            content: [],
          },
          { type: 'message' },
        ],
      });
      expect(JSON.stringify(answer)).not.toContain('reasoning_text');
    });

    test('does not reach a caller who asked for no summary', async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('anthropic/claude-haiku-5-5').complete(prompt),
        ),
        () => ({ models: [anthropic({ key: anthropicKey })] }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            stream: true,
            store: false,
            max_output_tokens: 1500,
            reasoning: { effort: 'medium' },
            input:
              'What is 17 * 23? Think it through step by step, then answer with the number.',
          }),
        }),
      );
      const text = await reply.text();
      await served.close();

      expect(reply.status).toBe(200);
      expect(text).toContain('event: response.output_text.delta');
      expect(text).toContain('event: response.completed');
      expect(text).not.toContain('"type":"reasoning"');
      expect(text).not.toContain('summary_text');
      expect(text).not.toContain('reasoning_text');
    });
  },
);

describe.skipIf(openrouterKey === undefined || openrouterKey === '')(
  'the reasoning of an open-weight model over Chat Completions',
  () => {
    test('is streamed to a Responses caller as a summary', async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/openai/gpt-oss-20b').complete(prompt),
        ),
        () => ({ models: [openrouter({ key: openrouterKey })] }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            stream: true,
            store: false,
            max_output_tokens: 1500,
            reasoning: { effort: 'low', summary: 'auto' },
            input:
              'What is 17 * 23? Think it through step by step, then answer with the number.',
          }),
        }),
      );
      const text = await reply.text();
      await served.close();
      const streamed = [
        ...text.matchAll(
          /"type":"response\.reasoning_summary_text\.delta".*?"delta":("(?:[^"\\]|\\.)*")/g,
        ),
      ]
        .map(([, piece = '""']) => JSON.parse(piece))
        .join('');

      expect(reply.status).toBe(200);
      expect(streamed.trim()).not.toBe('');
      expect(text).toContain(
        `"summary":[{"type":"summary_text","text":${JSON.stringify(streamed)}}]`,
      );
      expect(text).toContain('event: response.reasoning_summary_part.added');
      expect(text).toContain('event: response.reasoning_summary_part.done');
      expect(text).not.toContain('reasoning_text');
      expect(text).toContain('event: response.completed');
    });
  },
);
