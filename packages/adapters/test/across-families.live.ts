import { describe, expect, test } from 'bun:test';
import { fallback, model, motty } from '@mottyjs/core';
import { adapted } from '@mottyjs/core/host';
import { run } from '@mottyjs/test';
import { anthropic } from '../src/anthropic.ts';
import { openrouterCuts } from '../src/cuts.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without both keys nothing in it runs.
const { ANTHROPIC_KEY: anthropicKey, OPENAI_KEY: openaiKey } = Bun.env;

describe.skipIf(
  anthropicKey === undefined ||
    anthropicKey === '' ||
    openaiKey === undefined ||
    openaiKey === '',
)('one provider map across families', () => {
  test('with an entry for Anthropic and an empty one for OpenAI, it is answered by a model of every family in turn', async () => {
    const { answer, calls } = await run(
      motty({ name: 'thrice' }).handle(async ({ prompt }) => {
        const claude = await model('anthropic/claude-haiku-5-5').complete(
          prompt,
        );
        await claude.text();
        const responses = await model('openai/gpt-4.1-nano').complete(prompt);
        await responses.text();
        return model('openai-chat/gpt-4.1-nano').complete(prompt);
      }),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: {
            anthropic: { metadata: { user_id: 'motty-live' } },
            openai: {},
          },
        },
      },
      {
        models: [
          anthropic({ key: anthropicKey }),
          openai({ key: openaiKey }),
          openai({
            key: openaiKey,
            api: 'chat-completions',
            prefix: 'openai-chat',
          }),
        ],
      },
    );

    expect(await answer.finish()).toBe('stop');
    expect(calls.map(({ model: called, code }) => [called, code])).toEqual([
      ['anthropic/claude-haiku-5-5', undefined],
      ['openai/gpt-4.1-nano', undefined],
      ['openai-chat/gpt-4.1-nano', undefined],
    ]);
    for (const call of calls) expect(call).not.toHaveProperty('warnings');
  });

  test('an option both OpenAI APIs have, said once for OpenAI, is taken by each', async () => {
    const { answer, calls } = await run(
      motty({ name: 'twice' }).handle(async ({ prompt }) => {
        const responses = await model('openai/gpt-4.1-nano').complete(prompt);
        await responses.text();
        return model('openai-chat/gpt-4.1-nano').complete(prompt);
      }),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: {
            openai: { service_tier: 'default', prompt_cache_key: 'motty-live' },
          },
        },
      },
      {
        models: [
          openai({ key: openaiKey }),
          openai({
            key: openaiKey,
            api: 'chat-completions',
            prefix: 'openai-chat',
          }),
        ],
      },
    );

    expect(await answer.finish()).toBe('stop');
    expect(calls.map(({ model: called, code }) => [called, code])).toEqual([
      ['openai/gpt-4.1-nano', undefined],
      ['openai-chat/gpt-4.1-nano', undefined],
    ]);
    for (const call of calls) expect(call).not.toHaveProperty('warnings');
  });

  test('an option the Responses API alone has, said for OpenAI, fails a call to Chat Completions by name before it is sent', async () => {
    const ran = run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4.1-nano').complete(prompt),
      ),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: { openai: { previous_response_id: 'resp_motty_live' } },
        },
      },
      { models: [openai({ key: openaiKey, api: 'chat-completions' })] },
    );

    await expect(ran).rejects.toMatchObject({
      code: 'unsupported',
      status: 400,
      retryable: false,
      message:
        'Chat Completions cannot carry previous_response_id, which another API of openai has',
    });
    await expect(ran).rejects.not.toHaveProperty('upstream');
  });

  test('with such an option, a fallback moves on from Chat Completions to the Responses API, which takes it and answers', async () => {
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        fallback(
          model('openai-chat/gpt-4.1-nano'),
          model('openai/gpt-4.1-nano'),
        ).complete(prompt),
      ),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: { openai: { truncation: 'auto' } },
        },
      },
      {
        models: [
          openai({ key: openaiKey }),
          openai({
            key: openaiKey,
            api: 'chat-completions',
            prefix: 'openai-chat',
          }),
        ],
      },
    );

    expect(await answer.finish()).toBe('stop');
    expect(calls.map(({ model: called, code }) => [called, code])).toEqual([
      ['openai-chat/gpt-4.1-nano', 'unsupported'],
      ['openai/gpt-4.1-nano', undefined],
    ]);
  });

  test('with an entry for Anthropic alone, a call to the Responses API fails as unsupported before it is sent', async () => {
    const ran = run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4.1-nano').complete(prompt),
      ),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: { anthropic: { metadata: { user_id: 'motty-live' } } },
        },
      },
      { models: [openai({ key: openaiKey })] },
    );

    await expect(ran).rejects.toMatchObject({
      code: 'unsupported',
      status: 400,
      retryable: false,
      message:
        'The Responses API cannot carry an option of anthropic: metadata',
    });
    await expect(ran).rejects.not.toHaveProperty('upstream');
  });

  test('with an entry for Anthropic alone, a call to Chat Completions fails as unsupported before it is sent', async () => {
    const ran = run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('openai/gpt-4.1-nano').complete(prompt),
      ),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: { anthropic: { metadata: { user_id: 'motty-live' } } },
        },
      },
      { models: [openai({ key: openaiKey, api: 'chat-completions' })] },
    );

    await expect(ran).rejects.toMatchObject({
      code: 'unsupported',
      status: 400,
      retryable: false,
      message: 'Chat Completions cannot carry an option of anthropic: metadata',
    });
    await expect(ran).rejects.not.toHaveProperty('upstream');
  });

  test('with an entry for Anthropic alone, a fallback moves on from the OpenAI model that cannot carry it to Claude, who answers', async () => {
    const named: (string | undefined)[] = [];
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(async ({ prompt }) => {
        const reply = await fallback(
          model('openai/gpt-4.1-nano'),
          model('anthropic/claude-haiku-5-5'),
        ).complete(prompt);
        named.push(await reply.model());
        return reply;
      }),
      {
        text: 'Say ok.',
        options: {
          maxTokens: 20,
          provider: { anthropic: { metadata: { user_id: 'motty-live' } } },
        },
      },
      {
        models: [anthropic({ key: anthropicKey }), openai({ key: openaiKey })],
      },
    );

    expect(await answer.finish()).toBe('stop');
    expect(named).toEqual(['anthropic/claude-haiku-5-5']);
    expect(calls.map(({ model: called, code }) => [called, code])).toEqual([
      ['openai/gpt-4.1-nano', 'unsupported'],
      ['anthropic/claude-haiku-5-5', undefined],
    ]);
  });
});

const { OPENROUTER_KEY: openrouterKey } = Bun.env;

// A request an upstream refuses costs nothing, and a rate limit cannot be
// asked for, so these are the failures a caller can be shown for free.
describe.skipIf(
  anthropicKey === undefined ||
    anthropicKey === '' ||
    openaiKey === undefined ||
    openaiKey === '' ||
    openrouterKey === undefined ||
    openrouterKey === '',
)('what a caller is told of a real failure', () => {
  const { models } = adapted([
    anthropic({ key: anthropicKey }),
    anthropic({ key: 'sk-ant-api03-wrong', prefix: 'anthropic-keyless' }),
    openai({ key: openaiKey }),
    openai({ key: 'sk-proj-wrong', prefix: 'openai-keyless' }),
    openai({ key: openaiKey, api: 'chat-completions', prefix: 'openai-chat' }),
    openrouter({ key: openrouterKey }),
    openrouter({ key: 'sk-or-v1-wrong', prefix: 'openrouter-keyless' }),
  ]);

  test.each([
    ['anthropic/claude-no-such-model', {}, 'unknown_model'],
    ['anthropic-keyless/claude-haiku-5-5', {}, 'upstream_refused'],
    ['openai/gpt-no-such-model', {}, 'unknown_model'],
    ['openai-keyless/gpt-4.1-nano', {}, 'upstream_refused'],
    ['openai-chat/gpt-no-such-model', {}, 'unknown_model'],
    [
      'openai-chat/gpt-4.1-nano',
      { 'openai.chat': { reasoning_effort: 'low' } },
      'unsupported',
    ],
    [
      'openai-chat/gpt-5-search-api',
      { 'openai.chat': { temperature: 0.5 } },
      'unsupported',
    ],
    ['openrouter/no-such-author/no-such-model', {}, 'unknown_model'],
    ['openrouter-keyless/openai/gpt-4.1-nano', {}, 'upstream_refused'],
  ] as const)(
    '%s given %j fails as %s, in words that name no account of any provider',
    async (name, provider, code) => {
      const events = await Array.fromAsync(
        models(
          name,
          {
            messages: [{ role: 'user', text: 'Say ok.' }],
            options: { maxTokens: 16, provider },
          },
          AbortSignal.timeout(30000),
        ),
      );

      expect(events).toMatchObject([{ type: 'error', error: { code } }]);
      for (const event of events) {
        if (event.type !== 'error') continue;
        for (const { pattern } of openrouterCuts) {
          expect(event.error.message.match(pattern)).toBeNull();
        }
      }
    },
  );
});
