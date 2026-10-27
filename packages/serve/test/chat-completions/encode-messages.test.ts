import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { messageOf } from '../../src/chat-completions/decode-messages.ts';
import { wireMessages } from '../../src/chat-completions/encode-messages.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('a message of plain text is sent as a string, with its name', () => {
  expect(
    wireMessages(leaving('chat'), [
      { role: 'system', text: 'Be brief.' },
      { role: 'developer', text: 'Answer in English.' },
      { role: 'user', name: 'bo', text: 'Hi' },
    ]),
  ).toEqual([
    { role: 'system', content: 'Be brief.' },
    { role: 'developer', content: 'Answer in English.' },
    { role: 'user', name: 'bo', content: 'Hi' },
  ]);
});

test('a cache marker is left out and reported unless the dialect takes one', () => {
  const left = leaving('chat');
  expect(
    wireMessages(left, [
      { role: 'system', text: 'A long manual', cache: {} },
      {
        role: 'user',
        parts: [{ type: 'text', text: 'What does it say?', cache: {} }],
      },
    ]),
  ).toEqual([
    {
      role: 'system',
      content: [{ type: 'text', text: 'A long manual' }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: 'What does it say?' }],
    },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'cache',
      detail:
        'Chat Completions has no field for a cache marker, to an upstream not said to take one',
    },
  ]);
});

test('the lifetime of a cache marker is left out and reported', () => {
  const left = leaving('chat', true);
  expect(
    wireMessages(left, [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'A long manual', cache: { ttl: '1h' } }],
      },
    ]),
  ).toEqual([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'A long manual',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'cache.ttl',
      detail: 'Chat Completions has no field for a lifetime on a cache marker',
    },
  ]);
});

test('a cache marker on a message is a breakpoint on its last part', () => {
  expect(
    wireMessages(leaving('chat', true), [
      { role: 'system', text: 'A long manual', cache: {} },
      {
        role: 'user',
        cache: {},
        parts: [
          { type: 'text', text: 'One' },
          { type: 'text', text: 'Two' },
        ],
      },
    ]),
  ).toEqual([
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'A long manual',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'One' },
        {
          type: 'text',
          text: 'Two',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    },
  ]);
});

test('an assistant turn is sent with its tool calls, each in its shape', () => {
  expect(
    wireMessages(leaving('chat'), [
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Let me look.' },
          { type: 'refusal', text: 'Not that part.' },
          {
            type: 'tool_call',
            id: 'call_abc',
            name: 'weather',
            input: { city: 'Oslo' },
          },
          { type: 'tool_call', id: 'call_def', name: 'shell', input: 'ls -la' },
          {
            type: 'tool_call',
            id: 'call_ghi',
            name: 'weather',
            raw: '{"city":',
          },
        ],
      },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look.' },
        { type: 'refusal', refusal: 'Not that part.' },
      ],
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"Oslo"}' },
        },
        {
          id: 'call_def',
          type: 'custom',
          custom: { name: 'shell', input: 'ls -la' },
        },
        {
          id: 'call_ghi',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":' },
        },
      ],
    },
  ]);
});

test('a turn of tool calls or earlier audio alone has a null content', () => {
  expect(
    wireMessages(leaving('chat'), [
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_1', name: 'now', input: {} }],
      },
      { role: 'assistant', parts: [{ type: 'audio', id: 'audio_abc123' }] },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'now', arguments: '{}' },
        },
      ],
    },
    { role: 'assistant', content: null, audio: { id: 'audio_abc123' } },
  ]);
});

test('reasoning and citations never reach a model of this wire', () => {
  expect(
    wireMessages(leaving('chat'), [
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Routing to code' },
          { type: 'text', text: 'Oslo.' },
          { type: 'citation', url: 'https://x.test/oslo' },
        ],
      },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'Only this' }] },
    ]),
  ).toEqual([
    { role: 'assistant', content: [{ type: 'text', text: 'Oslo.' }] },
    { role: 'assistant', content: '' },
  ]);
});

test('each tool result is sent as a tool message of its own', () => {
  expect(
    wireMessages(leaving('chat'), [
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', id: 'call_a', text: '4°C' },
          {
            type: 'tool_result',
            id: 'call_b',
            failed: true,
            parts: [{ type: 'text', text: 'No such city' }],
          },
        ],
      },
    ]),
  ).toEqual([
    { role: 'tool', tool_call_id: 'call_a', content: '4°C' },
    {
      role: 'tool',
      tool_call_id: 'call_b',
      content: [{ type: 'text', text: 'No such city' }],
    },
  ]);
});

test('results inside a user turn are sent ahead of what the user said', () => {
  expect(
    wireMessages(leaving('chat'), [
      {
        role: 'user',
        parts: [
          { type: 'tool_result', id: 'call_a', text: '4°C' },
          { type: 'text', text: 'And tomorrow?' },
        ],
      },
      {
        role: 'user',
        parts: [{ type: 'tool_result', id: 'call_b', text: '6°C' }],
      },
    ]),
  ).toEqual([
    { role: 'tool', tool_call_id: 'call_a', content: '4°C' },
    { role: 'user', content: [{ type: 'text', text: 'And tomorrow?' }] },
    { role: 'tool', tool_call_id: 'call_b', content: '6°C' },
  ]);
});

test('an option of another family fails the call', () => {
  expect(() =>
    wireMessages(leaving('chat'), [
      { role: 'user', text: 'Hi', provider: { anthropic: { x: 1 } } },
    ]),
  ).toThrow('Chat Completions cannot carry a message option of anthropic');
});

test('a tool another upstream ran, and what it returned, fail the call', () => {
  const called = () =>
    wireMessages(leaving('chat'), [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'oslo' },
            hosted: true,
          },
        ],
      },
    ]);
  expect(called).toThrow(Unsupported);
  expect(called).toThrow(
    'Chat Completions cannot carry a call or a result of a tool another upstream ran',
  );
  const answered = () =>
    wireMessages(leaving('chat'), [
      {
        role: 'assistant',
        parts: [
          { type: 'tool_result', id: 'srvtoolu_1', text: '...', hosted: true },
        ],
      },
    ]);
  expect(answered).toThrow(Unsupported);
  expect(answered).toThrow(
    'Chat Completions cannot carry a call or a result of a tool another upstream ran',
  );
});

test('the name on a message of tool results is left out and reported', () => {
  const left = leaving('chat');
  expect(
    wireMessages(left, [
      {
        role: 'tool',
        name: 'weather',
        parts: [{ type: 'tool_result', id: 'call_a', text: '4°C' }],
      },
    ]),
  ).toEqual([{ role: 'tool', tool_call_id: 'call_a', content: '4°C' }]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'message.name.tool',
      detail:
        'Chat Completions has no field for the name of who wrote a message',
    },
  ]);
});

test('the provider data of a message of tool results goes on each tool message', () => {
  const left = leaving('chat');
  expect(
    wireMessages(left, [
      {
        role: 'tool',
        hints: { 'openai.chat': { vendor_note: 'kept' } },
        provider: { 'openai.chat': { vendor_field: 'kept too' } },
        parts: [
          { type: 'tool_result', id: 'call_a', text: '4°C' },
          { type: 'tool_result', id: 'call_b', text: '7°C' },
        ],
      },
    ]),
  ).toEqual([
    {
      vendor_note: 'kept',
      vendor_field: 'kept too',
      role: 'tool',
      tool_call_id: 'call_a',
      content: '4°C',
    },
    {
      vendor_note: 'kept',
      vendor_field: 'kept too',
      role: 'tool',
      tool_call_id: 'call_b',
      content: '7°C',
    },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('the extra fields of a tool message are sent back as they were read', () => {
  const sent = {
    role: 'tool',
    tool_call_id: 'call_a',
    content: '4°C',
    vendor_field: 'kept',
  };
  expect(wireMessages(leaving('chat'), [messageOf(sent)])).toEqual([sent]);
});

test('a tool turn with no result fails', () => {
  expect(() =>
    wireMessages(leaving('chat'), [{ role: 'tool', text: '4°C' }]),
  ).toThrow('Chat Completions cannot carry a tool message with no result');
});

test('a router`s cache marker is written with its lifetime, on a part or a message, and nothing is reported', () => {
  const left = leaving('chat', 'cache_control');

  expect(
    wireMessages(left, [
      { role: 'system', text: 'A long manual', cache: { ttl: '1h' } },
      {
        role: 'user',
        parts: [
          { type: 'text', text: 'An appendix', cache: {} },
          { type: 'text', text: 'What does it say?' },
        ],
      },
    ]),
  ).toEqual([
    {
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'A long manual',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'An appendix',
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: 'What does it say?' },
      ],
    },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('a message, a part and a provider part with an entry for each family are sent this one`s own', () => {
  const left = leaving('chat');

  expect(
    wireMessages(left, [
      {
        role: 'user',
        provider: { anthropic: { x: 1 }, 'openai.chat': { y: 2 } },
        parts: [
          {
            type: 'text',
            text: 'Hi',
            provider: { anthropic: { citations: true }, 'openai.chat': {} },
          },
          {
            type: 'provider',
            provider: {
              anthropic: { type: 'redacted_thinking', data: 'EmwK' },
              'openai.chat': { type: 'input_extra', extra: 'kept' },
            },
          },
        ],
      },
    ]),
  ).toEqual([
    {
      y: 2,
      role: 'user',
      content: [
        { type: 'text', text: 'Hi' },
        { type: 'input_extra', extra: 'kept' },
      ],
    },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('the reasoning of a turn that only calls a tool goes back as its text', () => {
  expect(
    wireMessages(
      leaving('chat'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'I need the weather.' },
            { type: 'tool_call', id: 'call_1', name: 'look', input: {} },
          ],
        },
      ],
      { name: 'minimax', tagged: true },
    ),
  ).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '<think>I need the weather.</think>' }],
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'look', arguments: '{}' },
        },
      ],
    },
  ]);
});

test('several pieces of reasoning go back as one, before the text', () => {
  expect(
    wireMessages(
      leaving('chat'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'One. ' },
            { type: 'text', text: 'Yes' },
            { type: 'reasoning', text: 'Two.' },
          ],
        },
      ],
      { name: 'minimax', tagged: true },
    ),
  ).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '<think>One. Two.</think>Yes' }],
    },
  ]);
});

test('a turn with no reasoning is written with no tags', () => {
  expect(
    wireMessages(leaving('chat'), [{ role: 'assistant', text: '391' }], {
      name: 'minimax',
      tagged: true,
    }),
  ).toEqual([{ role: 'assistant', content: '391' }]);
});

test('reasoning another API signed goes back as its text between the tags, and what signed it is reported', () => {
  const left = leaving('chat');

  expect(
    wireMessages(
      left,
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: 'Easy.',
              provider: { anthropic: { signature: 'EqQB' } },
            },
            { type: 'text', text: '391' },
          ],
        },
      ],
      { name: 'minimax', tagged: true },
    ),
  ).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '<think>Easy.</think>391' }],
    },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning',
      detail: 'Chat Completions has no field for reasoning it did not sign',
    },
  ]);
});

test('a tagged upstream that also names a field is sent reasoning inside the text alone', () => {
  expect(
    wireMessages(
      leaving('chat'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'Easy.' },
            { type: 'text', text: '391' },
          ],
        },
      ],
      { name: 'local', tagged: true, thought: 'reasoning_content' },
    ),
  ).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '<think>Easy.</think>391' }],
    },
  ]);
});

test('the reasoning of a user turn has no place inside its text', () => {
  const left = leaving('chat');

  expect(
    wireMessages(
      left,
      [
        {
          role: 'user',
          parts: [
            { type: 'reasoning', text: 'Easy.' },
            { type: 'text', text: 'Hi' },
          ],
        },
      ],
      { name: 'minimax', tagged: true },
    ),
  ).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }]);
  expect(left.leftOut().map(({ setting }) => setting)).toEqual(['reasoning']);
});

test('what a tool call holds for this API is written back where it sat', () => {
  expect(
    wireMessages(leaving('chat'), [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call_a',
            name: 'weather',
            input: {},
            hints: {
              'openai.chat': {
                extra_content: { google: { thought_signature: 'c2ln' } },
                function: { signature: 'c2ln' },
              },
            },
          },
          {
            type: 'tool_call',
            id: 'call_b',
            name: 'shell',
            input: 'ls',
            provider: {
              'openai.chat': {
                type: 'custom',
                vendor: { a: 1 },
                custom: { signature: 'c2ln' },
              },
            },
          },
        ],
      },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          extra_content: { google: { thought_signature: 'c2ln' } },
          id: 'call_a',
          type: 'function',
          function: { signature: 'c2ln', name: 'weather', arguments: '{}' },
        },
        {
          vendor: { a: 1 },
          id: 'call_b',
          type: 'custom',
          custom: { signature: 'c2ln', name: 'shell', input: 'ls' },
        },
      ],
    },
  ]);
});
