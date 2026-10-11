import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Chunk, Json, Report } from '@mottyjs/core/host';
import { mount } from '../src/index.ts';

const coder = motty({ name: 'coder' }).handle(({ prompt }) =>
  model('openai/gpt').complete(prompt),
);

async function asked(
  path: string,
  body: { [field: string]: Json },
  chunks: readonly Chunk[],
) {
  const reports: Report[] = [];
  const served = mount(coder, () => ({
    models: [
      {
        serves: () => true,
        call: async function* () {
          yield* chunks;
          yield { type: 'finish', reason: 'stop' };
        },
      },
    ],
    report: (report) => reports.push(report),
  }));
  const reply = await served.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'coder', ...body }),
    }),
  );
  const text = await reply.text();
  await served.close();
  return { status: reply.status, text, reports };
}

const signature: Chunk[] = [
  { type: 'reasoning', text: 'Weighing it', block: 0 },
  {
    type: 'reasoning',
    text: '',
    block: 0,
    provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
  },
  { type: 'text', text: 'Yes', block: 1 },
];

const encrypted: Chunk[] = [
  {
    type: 'reasoning',
    text: '',
    block: 0,
    provider: {
      'openai.responses': {
        type: 'reasoning',
        id: 'rs_1',
        encrypted_content: 'gAAAAABoEncrypted',
        summary: [],
      },
    },
  },
  { type: 'reasoning', text: 'Weighing it', block: 0 },
  { type: 'text', text: 'Yes', block: 1 },
];

const redacted: Chunk[] = [
  {
    type: 'reasoning',
    text: '',
    block: 0,
    provider: { anthropic: { type: 'redacted_thinking', data: 'EmwKAhgB' } },
  },
  { type: 'text', text: 'Yes', block: 1 },
];

test.each([
  ['a thinking signature', signature, 'EqQBCgIYAhIM', false],
  ['a thinking signature', signature, 'EqQBCgIYAhIM', true],
  ['an encrypted reasoning item', encrypted, 'gAAAAABoEncrypted', false],
  ['an encrypted reasoning item', encrypted, 'gAAAAABoEncrypted', true],
  ['redacted thinking', redacted, 'EmwKAhgB', false],
  ['redacted thinking', redacted, 'EmwKAhgB', true],
])(
  '%s is left out of a Chat Completions reply and reported (%#)',
  async (_what, chunks, secret, stream) => {
    const { status, text, reports } = await asked(
      '/v1/chat/completions',
      { stream, messages: [{ role: 'user', content: 'Is it safe?' }] },
      chunks,
    );

    expect(status).toBe(200);
    expect(text).toContain('Yes');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('"error"');
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.warnings).toEqual([
      {
        setting: 'reasoning',
        detail:
          'Chat Completions has no form for what a model goes on from its reasoning with',
      },
    ]);
  },
);

test.each([
  ['a thinking signature', signature, 'EqQBCgIYAhIM', false],
  ['a thinking signature', signature, 'EqQBCgIYAhIM', true],
  ['redacted thinking', redacted, 'EmwKAhgB', false],
  ['redacted thinking', redacted, 'EmwKAhgB', true],
])(
  '%s is left out of a Responses reply and reported (%#)',
  async (_what, chunks, secret, stream) => {
    const { status, text, reports } = await asked(
      '/v1/responses',
      { stream, input: 'Is it safe?', reasoning: { summary: 'auto' } },
      chunks,
    );

    expect(status).toBe(200);
    expect(text).toContain('Yes');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('response.failed');
    expect(text).not.toContain('"error":{');
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.warnings).toEqual([
      {
        setting: 'reasoning',
        detail:
          'The Responses API has no form for what a model goes on from its reasoning with',
      },
    ]);
  },
);

test.each([false, true])(
  'an encrypted reasoning item is left out of a Messages reply and reported (stream %p)',
  async (stream) => {
    const { status, text, reports } = await asked(
      '/v1/messages',
      {
        stream,
        max_tokens: 100,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: 'Is it safe?' }],
      },
      encrypted,
    );

    expect(status).toBe(200);
    expect(text).toContain('Yes');
    expect(text).toContain('Weighing it');
    expect(text).not.toContain('gAAAAABoEncrypted');
    expect(text).not.toContain('"type":"error"');
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.warnings).toEqual([
      {
        setting: 'reasoning',
        detail:
          'Anthropic Messages has no form for what a model goes on from its reasoning with',
      },
    ]);
  },
);

test.each([
  ['/v1/chat/completions', 'Chat Completions', 'anthropic', false],
  ['/v1/chat/completions', 'Chat Completions', 'anthropic', true],
  ['/v1/chat/completions', 'Chat Completions', 'openai.responses', false],
  ['/v1/chat/completions', 'Chat Completions', 'openai.responses', true],
  ['/v1/responses', 'The Responses API', 'anthropic', false],
  ['/v1/responses', 'The Responses API', 'anthropic', true],
  ['/v1/messages', 'Anthropic Messages', 'openai.responses', false],
  ['/v1/messages', 'Anthropic Messages', 'openai.responses', true],
])(
  'reasoning text on %s outlives the data of another family beside it (%#)',
  async (path, api, family, stream) => {
    const { status, text, reports } = await asked(
      path,
      {
        stream,
        ...(path === '/v1/responses'
          ? { input: 'Is it safe?', reasoning: { summary: 'auto' } }
          : { messages: [{ role: 'user', content: 'Is it safe?' }] }),
        ...(path === '/v1/messages'
          ? { max_tokens: 100, thinking: { type: 'adaptive' } }
          : {}),
      },
      [
        {
          type: 'reasoning',
          text: 'Weighing it',
          block: 0,
          provider: { [family]: { signature: 'EqQBCgIYAhIM' } },
        },
        { type: 'text', text: 'Yes', block: 1 },
      ],
    );

    expect(status).toBe(200);
    expect(text).toContain('Weighing it');
    expect(text).toContain('Yes');
    expect(text).not.toContain('EqQBCgIYAhIM');
    expect(reports).toMatchObject([{ outcome: 'completed' }]);
    expect(reports[0]?.warnings).toEqual([
      {
        setting: 'reasoning',
        detail: `${api} has no form for what a model goes on from its reasoning with`,
      },
    ]);
  },
);

test.each([
  ['/v1/messages', signature, 'EqQBCgIYAhIM'],
  ['/v1/messages', redacted, 'EmwKAhgB'],
  ['/v1/responses', encrypted, 'gAAAAABoEncrypted'],
])(
  'a caller of the same family on %s is given it unchanged (%#)',
  async (path, chunks, secret) => {
    const { status, text, reports } = await asked(
      path,
      path === '/v1/messages'
        ? {
            max_tokens: 100,
            messages: [{ role: 'user', content: 'Is it safe?' }],
          }
        : { input: 'Is it safe?' },
      chunks,
    );

    expect(status).toBe(200);
    expect(text).toContain(secret);
    expect(reports[0]).not.toHaveProperty('warnings');
  },
);
