import { expect, test } from 'bun:test';
import type { Chunk } from '@mottyjs/core/host';
import {
  thinking,
  unchunked,
} from '../../src/chat-completions/content-chunks.ts';
import { wireMessages } from '../../src/chat-completions/encode-messages.ts';
import { events } from '../../src/chat-completions/events.ts';
import { leaving } from '../../src/wire/fieldless.ts';

async function* sent(...frames: string[]) {
  for (const data of frames) yield { data };
}

test('a thinking chunk is reasoning, made of the text chunks it holds, and a text chunk is text', () => {
  expect(
    unchunked([
      {
        type: 'thinking',
        thinking: [
          { type: 'text', text: '17 times 20 is 340, ' },
          { type: 'text', text: 'and 17 times 3 is 51.' },
        ],
      },
      { type: 'text', text: '17 * 23 = 391.' },
    ]),
  ).toEqual([
    { type: 'reasoning', text: '17 times 20 is 340, and 17 times 3 is 51.' },
    { type: 'text', text: '17 * 23 = 391.' },
  ]);
});

test('what signed the thinking rides on it, and comes alone where it came with no text', () => {
  expect(
    unchunked([
      {
        type: 'thinking',
        thinking: [{ type: 'text', text: 'Paris is at 48 degrees.' }],
        signature: 'c2lnbmVk',
      },
      { type: 'thinking', thinking: [], signature: 'bGF0ZXI=' },
    ]),
  ).toEqual([
    {
      type: 'reasoning',
      text: 'Paris is at 48 degrees.',
      provider: { 'openai.chat': { signature: 'c2lnbmVk' } },
    },
    {
      type: 'reasoning',
      text: '',
      provider: { 'openai.chat': { signature: 'bGF0ZXI=' } },
    },
  ]);
});

test('a chunk that names a source, an empty one and one of the wrong shape say nothing', () => {
  expect(
    unchunked([
      { type: 'reference', reference_ids: [0, 1] },
      {
        type: 'thinking',
        thinking: [{ type: 'reference', reference_ids: [2] }],
      },
      { type: 'thinking', thinking: 'loose' },
      { type: 'text', text: '' },
      { type: 'text', text: 7 },
      { type: 'image_url', image_url: 'https://example.com/cat.png' },
      'loose',
      null,
    ]),
  ).toEqual([]);
});

test('a stream whose content is a list while it thinks and a string after is read in the order it came', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"0d93","object":"chat.completion.chunk","model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
          '{"id":"0d93","object":"chat.completion.chunk","model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"17 times 20 is 340, "}]}]},"finish_reason":null}]}',
          '{"id":"0d93","object":"chat.completion.chunk","model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"plus 51."}]},{"type":"text","text":"17 * 23"}]},"finish_reason":null}]}',
          '{"id":"0d93","object":"chat.completion.chunk","model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":" = 391."},"finish_reason":null}]}',
          '{"id":"0d93","object":"chat.completion.chunk","model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":25,"total_tokens":212,"completion_tokens":187}}',
          '[DONE]',
        ),
        { name: 'mistral', chunked: true },
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: '17 times 20 is 340, ' },
    { type: 'reasoning', text: 'plus 51.' },
    { type: 'text', text: '17 * 23' },
    { type: 'text', text: ' = 391.' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'stop',
      usage: { input: 25, output: 187 },
      id: '0d93',
      model: 'mistral-medium-3-5',
    },
  ]);
});

test('a tool call beside a list of chunks follows what the list said', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"I need the weather."}]}],"tool_calls":[{"id":"D681PevKs","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Paris\\"}"},"index":0}]},"finish_reason":"tool_calls"}]}',
          '[DONE]',
        ),
        { name: 'mistral', chunked: true },
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'I need the weather.' },
    {
      type: 'tool_call',
      id: 'D681PevKs',
      name: 'get_weather',
      arguments: '{"city": "Paris"}',
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ]);
});

test('an upstream not said to send a list is not read for one', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"391"}]},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([{ type: 'finish', reason: 'stop', rawReason: 'stop' }]);
});

test('reasoning goes back as one thinking chunk before the text, with what signed it', () => {
  const left = leaving('chat');

  expect(
    wireMessages(
      left,
      [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: '17 times 20 is 340, ' },
            {
              type: 'reasoning',
              text: 'plus 51.',
              provider: { 'openai.chat': { signature: 'c2lnbmVk' } },
            },
            { type: 'text', text: '17 * 23 = 391.' },
          ],
        },
      ],
      { name: 'mistral', chunked: true },
    ),
  ).toEqual([
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: [{ type: 'text', text: '17 times 20 is 340, plus 51.' }],
          signature: 'c2lnbmVk',
        },
        { type: 'text', text: '17 * 23 = 391.' },
      ],
    },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('reasoning another API signed goes back as its text, and what signed it is reported', () => {
  const left = leaving('chat');

  expect(
    thinking(left, [
      {
        type: 'reasoning',
        text: 'Paris is at 48 degrees.',
        provider: { 'anthropic.messages': { signature: 'EqQB' } },
      },
    ]),
  ).toEqual([
    {
      type: 'thinking',
      thinking: [{ type: 'text', text: 'Paris is at 48 degrees.' }],
    },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning',
      detail: 'Chat Completions has no field for reasoning it did not sign',
    },
  ]);
});

test('a turn with no reasoning is written with no thinking chunk', () => {
  expect(
    wireMessages(leaving('chat'), [{ role: 'assistant', text: 'Paris' }], {
      name: 'mistral',
      chunked: true,
    }),
  ).toEqual([{ role: 'assistant', content: 'Paris' }]);
});

test.each<[string, string, Chunk[]]>([
  [
    'nothing that was said, where what it holds is signed or says nothing',
    '[{"type":"thinking","thinking":[],"signature":"sig"},{"type":"reference","reference_ids":[1]}]',
    [
      {
        type: 'reasoning',
        text: '',
        provider: { 'openai.chat': { signature: 'sig' } },
      },
      {
        type: 'text',
        text: '',
        provider: {
          'openai.chat': { logprobs: [{ token: 'Yes', logprob: -0.1 }] },
        },
      },
    ],
  ],
])(
  'the likelihoods of a content that is a list go with %s',
  async (_, content, read) => {
    expect(
      await Array.fromAsync(
        events(
          sent(
            `{"choices":[{"index":0,"delta":{"content":${content}},"logprobs":{"content":[{"token":"Yes","logprob":-0.1}]},"finish_reason":"stop"}]}`,
            '[DONE]',
          ),
          { name: 'mistral', chunked: true },
        ),
      ),
    ).toEqual([...read, { type: 'finish', reason: 'stop', rawReason: 'stop' }]);
  },
);
