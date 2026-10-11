import { expect, test } from 'bun:test';
import { collected } from '../../src/chat-completions/reply-whole.ts';

test('text is collected into one completion with its usage', () => {
  expect(
    collected(
      [
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
      ],
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 9, output: 2, cached: 0, cacheWrite: 9 },
        id: 'chatcmpl-upstream',
        model: 'gpt-x-2026-01-01',
        provider: { 'openai.chat': { system_fingerprint: 'fp_1' } },
      },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toEqual({
    id: 'chatcmpl-req_1',
    object: 'chat.completion',
    created: expect.any(Number),
    model: 'coder',
    system_fingerprint: 'fp_1',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello', refusal: null },
        logprobs: null,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 9,
      completion_tokens: 2,
      total_tokens: 11,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 9 },
    },
  });
});

test('tool call fragments are assembled, and the content is null', () => {
  expect(
    collected(
      [
        { type: 'tool_call', id: 'call_a', name: 'weather', arguments: '' },
        {
          type: 'tool_call',
          id: 'call_b',
          name: 'shell',
          arguments: 'ls',
          provider: { 'openai.chat': { type: 'custom' } },
        },
        { type: 'tool_call', id: 'call_a', arguments: '{"city":' },
        { type: 'tool_call', id: 'call_b', arguments: ' -la' },
        { type: 'tool_call', id: 'call_a', arguments: '"Oslo"}' },
      ],
      { type: 'finish', reason: 'tool_calls' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Oslo"}' },
            },
            {
              id: 'call_b',
              type: 'custom',
              custom: { name: 'shell', input: 'ls -la' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  });
});

test('progress and reasoning are collected in the reply`s reasoning', () => {
  const reply = collected(
    [
      { type: 'progress', piece: 0, text: 'Reading the question' },
      { type: 'progress', piece: 1, text: 'Routing to code' },
      { type: 'reasoning', text: 'A loop will do.' },
      { type: 'text', text: 'Use a loop.' },
    ],
    { type: 'finish', reason: 'stop' },
    { id: 'req_1', model: 'coder', muted: false },
  );

  expect(reply).toMatchObject({
    choices: [
      {
        message: {
          content: 'Use a loop.',
          reasoning: 'Reading the question\nRouting to code\nA loop will do.',
          reasoning_content:
            'Reading the question\nRouting to code\nA loop will do.',
        },
      },
    ],
  });
});

test('a caller who muted reasoning gets a reply with none', () => {
  expect(
    collected(
      [
        { type: 'progress', piece: 0, text: 'Routing to code' },
        { type: 'reasoning', text: 'A loop will do.' },
        { type: 'text', text: 'Use a loop.' },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: true },
    ),
  ).toMatchObject({
    choices: [
      {
        message: { role: 'assistant', content: 'Use a loop.', refusal: null },
      },
    ],
  });
});

test('a refusal is collected in its field, with a null content', () => {
  expect(
    collected(
      [
        { type: 'refusal', text: 'I cannot ' },
        { type: 'refusal', text: 'help with that.' },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [
      {
        message: { content: null, refusal: 'I cannot help with that.' },
        finish_reason: 'stop',
      },
    ],
  });
});

test('logprobs of every chunk are collected for the choice', () => {
  const hel = { token: 'Hel', logprob: -0.1, bytes: null, top_logprobs: [] };
  const lo = { token: 'lo', logprob: -0.3, bytes: null, top_logprobs: [] };

  expect(
    collected(
      [
        {
          type: 'text',
          text: 'Hel',
          provider: { 'openai.chat': { logprobs: [hel] } },
        },
        {
          type: 'text',
          text: 'lo',
          provider: { 'openai.chat': { logprobs: [lo] } },
        },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [{ logprobs: { content: [hel, lo], refusal: null } }],
  });
});

test('citations are collected as annotations and sound as one object', () => {
  expect(
    collected(
      [
        { type: 'text', text: 'Oslo.' },
        {
          type: 'citation',
          title: 'Oslo',
          url: 'https://x.test/oslo',
          provider: { 'openai.chat': { start_index: 0, end_index: 5 } },
        },
        {
          type: 'provider',
          provider: {
            'openai.chat': {
              audio: { id: 'audio_1', data: 'UklG', transcript: 'Os' },
            },
          },
        },
        {
          type: 'provider',
          provider: {
            'openai.chat': {
              audio: {
                data: 'Rg==',
                transcript: 'lo.',
                expires_at: 1791590000,
              },
            },
          },
        },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [
      {
        message: {
          content: 'Oslo.',
          annotations: [
            {
              type: 'url_citation',
              url_citation: {
                start_index: 0,
                end_index: 5,
                title: 'Oslo',
                url: 'https://x.test/oslo',
              },
            },
          ],
          audio: {
            id: 'audio_1',
            data: 'UklGRg==',
            transcript: 'Oslo.',
            expires_at: 1791590000,
          },
        },
      },
    ],
  });
});

test('an empty reply is an empty string, and no usage is made up', () => {
  const reply = collected(
    [],
    { type: 'finish', reason: 'other', rawReason: 'eos' },
    { id: 'req_1', model: 'coder', muted: false },
  );

  expect(reply).toMatchObject({
    choices: [
      {
        message: { role: 'assistant', content: '', refusal: null },
        finish_reason: 'stop',
      },
    ],
  });
  expect(reply).not.toHaveProperty('usage');
});

test('reasoning details are collected whole: fragments of one are joined', () => {
  expect(
    collected(
      [
        {
          type: 'reasoning',
          text: 'Pa',
          provider: {
            'openai.chat': {
              reasoning_details: [
                { type: 'reasoning.text', text: 'Pa', index: 0 },
              ],
            },
          },
        },
        {
          type: 'reasoning',
          text: 'ris',
          provider: {
            'openai.chat': {
              reasoning_details: [
                { type: 'reasoning.text', text: 'ris', index: 0 },
              ],
            },
          },
        },
        {
          type: 'reasoning',
          text: '',
          provider: {
            'openai.chat': {
              reasoning_details: [
                { type: 'reasoning.text', signature: 'EqQB', index: 0 },
              ],
            },
          },
        },
        { type: 'text', text: 'Paris' },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [
      {
        message: {
          content: 'Paris',
          reasoning: 'Paris',
          reasoning_content: 'Paris',
          reasoning_details: [
            {
              type: 'reasoning.text',
              text: 'Paris',
              signature: 'EqQB',
              index: 0,
            },
          ],
        },
      },
    ],
  });
});

test('a signature that came with no text is still in the reply', () => {
  expect(
    collected(
      [
        {
          type: 'reasoning',
          text: '',
          provider: {
            'openai.chat': {
              reasoning_details: [
                { type: 'reasoning.text', signature: 'EqQB', index: 0 },
              ],
            },
          },
        },
        { type: 'text', text: '391' },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [
      {
        message: {
          content: '391',
          reasoning_details: [
            { type: 'reasoning.text', signature: 'EqQB', index: 0 },
          ],
        },
      },
    ],
  });
});

test('pictures a model made are collected in the field a stream sends them in', () => {
  expect(
    collected(
      [
        { type: 'text', text: 'Here they are.' },
        { type: 'file', data: 'iVBORw0=', mediaType: 'image/png' },
        {
          type: 'file',
          url: 'https://x.test/made.png',
          provider: { 'openai.chat': { type: 'image_url', index: 1 } },
        },
      ],
      { type: 'finish', reason: 'stop' },
      { id: 'req_1', model: 'coder', muted: false },
    ),
  ).toMatchObject({
    choices: [
      {
        message: {
          content: 'Here they are.',
          images: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0=' },
            },
            {
              type: 'image_url',
              index: 1,
              image_url: { url: 'https://x.test/made.png' },
            },
          ],
        },
      },
    ],
  });
});
