import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import { messageOf } from '../../src/chat-completions/decode-messages.ts';
import { wireMessages } from '../../src/chat-completions/encode-messages.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('a message of plain text is read as the text shorthand', () => {
  expect(messageOf({ role: 'system', content: 'Be brief.' })).toEqual({
    role: 'system',
    text: 'Be brief.',
  });
  expect(messageOf({ role: 'developer', content: '' })).toEqual({
    role: 'developer',
    text: '',
  });
  expect(messageOf({ role: 'user', name: 'bo', content: 'Hi' })).toEqual({
    role: 'user',
    name: 'bo',
    text: 'Hi',
  });
});

test('a text part is read, with its cache breakpoint', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        { type: 'text', text: 'A long manual' },
        {
          type: 'text',
          text: 'and its appendix',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [
      { type: 'text', text: 'A long manual' },
      { type: 'text', text: 'and its appendix', cache: {} },
    ],
  });
});

test('an image is read by address, or split when it is inline', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: 'https://x.test/cat.png' } },
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'high' },
        },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [
      { type: 'image', url: 'https://x.test/cat.png' },
      {
        type: 'image',
        data: '/9j/4AAQ',
        mediaType: 'image/jpeg',
        hints: { openai: { detail: 'high' } },
      },
    ],
  });
});

test('input audio is read as inline audio of its format', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: { data: 'UklGRg==', format: 'wav' },
        },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [{ type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' }],
  });
});

test('a file is read by its data or by its id, with its name', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        {
          type: 'file',
          file: {
            file_data: 'data:application/pdf;base64,JVBERi0=',
            filename: 'terms.pdf',
          },
        },
        { type: 'file', file: { file_data: 'JVBERi0=' } },
        { type: 'file', file: { file_id: 'file-6F2ksmvXxt4VdoqmHRw6kL' } },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [
      {
        type: 'file',
        name: 'terms.pdf',
        data: 'JVBERi0=',
        mediaType: 'application/pdf',
      },
      { type: 'file', data: 'JVBERi0=' },
      { type: 'file', id: 'file-6F2ksmvXxt4VdoqmHRw6kL' },
    ],
  });
});

test('a part of a kind not known is kept whole for its own family', () => {
  const part = {
    type: 'video_url',
    video_url: { url: 'https://x.test/a.mp4' },
  };

  expect(messageOf({ role: 'user', content: [part] })).toEqual({
    role: 'user',
    parts: [{ type: 'provider', provider: { 'openai.chat': part } }],
  });
});

test('an assistant turn is read with its text, refusal and tool calls', () => {
  expect(
    messageOf({
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
      ],
    }),
  ).toEqual({
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
    ],
  });
});

test('an assistant turn of tool calls alone has no text part', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'now', arguments: '{}' },
        },
      ],
    }),
  ).toEqual({
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call_1', name: 'now', input: {} }],
  });
});

test('arguments that are not an object of JSON are kept as written', () => {
  const read = (written: string) =>
    messageOf({
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'f', arguments: written },
        },
      ],
    });

  expect(read('{"city":')).toEqual({
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call_1', name: 'f', raw: '{"city":' }],
  });
  expect(read('"Oslo"')).toEqual({
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call_1', name: 'f', raw: '"Oslo"' }],
  });
  expect(read('')).toEqual({
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call_1', name: 'f', raw: '' }],
  });
});

test('a refusal field, earlier audio and reasoning are read as parts', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: null,
      refusal: 'I cannot help with that.',
      audio: { id: 'audio_abc123' },
      reasoning_content: 'The user asks for a weapon.',
    }),
  ).toEqual({
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'The user asks for a weapon.' },
      { type: 'refusal', text: 'I cannot help with that.' },
      { type: 'audio', id: 'audio_abc123' },
    ],
  });
  expect(
    messageOf({ role: 'assistant', content: 'Hi', reasoning: 'Greet.' }),
  ).toEqual({
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'Greet.' },
      { type: 'text', text: 'Hi' },
    ],
  });
});

test('a tool message is read as the result of its call', () => {
  expect(
    messageOf({ role: 'tool', tool_call_id: 'call_abc', content: '4°C' }),
  ).toEqual({
    role: 'tool',
    parts: [{ type: 'tool_result', id: 'call_abc', text: '4°C' }],
  });
  expect(
    messageOf({
      role: 'tool',
      tool_call_id: 'call_abc',
      content: [{ type: 'text', text: '4°C' }],
    }),
  ).toEqual({
    role: 'tool',
    parts: [
      {
        type: 'tool_result',
        id: 'call_abc',
        parts: [{ type: 'text', text: '4°C' }],
      },
    ],
  });
});

test('a field of a message not known is kept for its own family', () => {
  expect(
    messageOf({ role: 'assistant', content: 'Hi', phase: 'final_answer' }),
  ).toEqual({
    role: 'assistant',
    text: 'Hi',
    provider: { 'openai.chat': { phase: 'final_answer' } },
  });
});

test('an empty or null field of the reply sent back changes nothing, so any family can take it', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: 'Hi',
      refusal: null,
      annotations: [],
      audio: null,
      function_call: null,
      logprobs: {},
    }),
  ).toEqual({ role: 'assistant', text: 'Hi' });
});

test('a message that is not well formed is refused', () => {
  expect(() => messageOf('hi')).toThrow(InvalidRequest);
  expect(() => messageOf({ role: 'narrator', content: 'x' })).toThrow(
    'Unknown message role: "narrator"',
  );
  expect(() => messageOf({ content: 'x' })).toThrow(InvalidRequest);
  expect(() => messageOf({ role: 'user', content: 7 })).toThrow(InvalidRequest);
  expect(() => messageOf({ role: 'user', content: ['hi'] })).toThrow(
    InvalidRequest,
  );
  expect(() => messageOf({ role: 'tool', content: 'x' })).toThrow(
    'A tool message needs a tool_call_id',
  );
});

test('a part that lacks what its kind needs is refused', () => {
  const read = (part: { [key: string]: string | { [key: string]: string } }) =>
    messageOf({ role: 'user', content: [part] });

  expect(() => read({ type: 'text' })).toThrow(InvalidRequest);
  expect(() => read({ type: 'image_url', image_url: {} })).toThrow(
    'An image_url part needs a url',
  );
  expect(() =>
    read({ type: 'input_audio', input_audio: { data: 'UklGRg==' } }),
  ).toThrow(InvalidRequest);
  expect(() => read({ type: 'file', file: { filename: 'a.pdf' } })).toThrow(
    'A file part needs file_data or a file_id',
  );
});

test('a tool call that lacks its id or its name is refused', () => {
  const read = (call: { [key: string]: string | { [key: string]: string } }) =>
    messageOf({ role: 'assistant', tool_calls: [call] });

  expect(() => read({ type: 'function', function: { name: 'f' } })).toThrow(
    'A tool call needs an id',
  );
  expect(() => read({ id: 'call_1', type: 'function' })).toThrow(
    InvalidRequest,
  );
  expect(() =>
    read({ id: 'call_1', type: 'custom', custom: { name: 'shell' } }),
  ).toThrow(InvalidRequest);
});

test('the function role and function_call of the old API are rejected', () => {
  expect(() =>
    messageOf({ role: 'function', name: 'f', content: '4' }),
  ).toThrow(Unsupported);
  expect(() =>
    messageOf({
      role: 'assistant',
      content: null,
      function_call: { name: 'f', arguments: '{}' },
    }),
  ).toThrow(Unsupported);
});

test('reasoning details sent back stay with the reasoning, as this family`s own', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: 'Paris',
      reasoning: 'Paris is north.',
      reasoning_details: [
        {
          type: 'reasoning.text',
          text: 'Paris is north.',
          signature: 'EqQB',
          index: 0,
        },
      ],
    }),
  ).toEqual({
    role: 'assistant',
    parts: [
      {
        type: 'reasoning',
        text: 'Paris is north.',
        provider: {
          'openai.chat': {
            reasoning_details: [
              {
                type: 'reasoning.text',
                text: 'Paris is north.',
                signature: 'EqQB',
                index: 0,
              },
            ],
          },
        },
      },
      { type: 'text', text: 'Paris' },
    ],
  });
});

test('details sent back with no text beside them give the reasoning theirs', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: null,
      reasoning_details: [
        { type: 'reasoning.text', text: 'Paris ', index: 0 },
        { type: 'reasoning.encrypted', data: 'gAAA', index: 1 },
        { type: 'reasoning.text', text: 'is north.', index: 2 },
      ],
    }),
  ).toMatchObject({
    role: 'assistant',
    parts: [{ type: 'reasoning', text: 'Paris is north.' }],
  });
  expect(
    messageOf({ role: 'assistant', content: 'Hi', reasoning_details: [] }),
  ).toEqual({ role: 'assistant', text: 'Hi' });
});

test('what a media part holds beside what is read is kept where it was', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        { type: 'text', text: 'Look', cache_control: { type: 'ephemeral' } },
        {
          type: 'image_url',
          image_url: { url: 'https://x.test/cat.png', detail: 'low', crop: 1 },
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'input_audio',
          input_audio: { data: 'UklGRg==', format: 'wav', sample_rate: 16000 },
        },
        { type: 'file', file: { file_id: 'file-1', purpose: 'vision' } },
        { type: 'refusal', refusal: 'No.', reason: 'policy' },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [
      {
        type: 'text',
        text: 'Look',
        cache: {},
      },
      {
        type: 'image',
        url: 'https://x.test/cat.png',
        hints: { openai: { detail: 'low' }, 'openai.chat': { crop: 1 } },
        cache: {},
      },
      {
        type: 'audio',
        data: 'UklGRg==',
        mediaType: 'audio/wav',
        hints: { 'openai.chat': { sample_rate: 16000 } },
      },
      {
        type: 'file',
        id: 'file-1',
        hints: { 'openai.chat': { purpose: 'vision' } },
      },
      {
        type: 'refusal',
        text: 'No.',
        hints: { 'openai.chat': { reason: 'policy' } },
      },
    ],
  });
});

test('a router`s cache_control on a content part is the cache marker, with its lifetime', () => {
  expect(
    messageOf({
      role: 'system',
      content: [
        {
          type: 'text',
          text: 'You are terse.',
          cache_control: { type: 'ephemeral' },
        },
        {
          type: 'text',
          text: 'A long manual',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
      ],
    }),
  ).toEqual({
    role: 'system',
    parts: [
      { type: 'text', text: 'You are terse.', cache: {} },
      { type: 'text', text: 'A long manual', cache: { ttl: '1h' } },
    ],
  });
  expect(() =>
    messageOf({
      role: 'user',
      content: [
        { type: 'text', text: 'Hi', cache_control: { type: 'forever' } },
      ],
    }),
  ).toThrow(InvalidRequest);
});

test('file data that is an address is read as one, and bare bytes as bytes', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        { type: 'file', file: { file_data: 'https://x.test/a.pdf' } },
        { type: 'file', file: { file_data: 'JVBERi0=', filename: 'a.pdf' } },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [
      { type: 'file', url: 'https://x.test/a.pdf' },
      { type: 'file', name: 'a.pdf', data: 'JVBERi0=' },
    ],
  });
});

test('a file written with no object around its fields is read too', () => {
  expect(
    messageOf({
      role: 'user',
      content: [
        { type: 'file', file_id: 'file-api-1' },
        {
          type: 'file',
          file_data: 'data:image/jpeg;base64,/9j/4AAQ',
          filename: 'a.jpg',
        },
      ],
    }),
  ).toEqual({
    role: 'user',
    parts: [
      { type: 'file', id: 'file-api-1' },
      {
        type: 'file',
        name: 'a.jpg',
        data: '/9j/4AAQ',
        mediaType: 'image/jpeg',
      },
    ],
  });
});

test('pictures a model made and what its sound held are read as parts', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: 'Here it is.',
      audio: { id: 'audio_1', expires_at: 1700000000 },
      images: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0=' },
          index: 0,
        },
        { image_url: { url: 'https://x.test/made.png' } },
      ],
    }),
  ).toEqual({
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Here it is.' },
      {
        type: 'audio',
        id: 'audio_1',
        hints: { 'openai.chat': { expires_at: 1700000000 } },
      },
      {
        type: 'image',
        data: 'iVBORw0=',
        mediaType: 'image/png',
        provider: { 'openai.chat': { index: 0 } },
      },
      { type: 'image', url: 'https://x.test/made.png' },
    ],
  });
});

test.each([
  [
    'a user turn of every medium',
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Look',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        {
          type: 'image_url',
          image_url: { url: 'https://x.test/cat.png', detail: 'high' },
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        {
          type: 'image_url',
          image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ', detail: 'low' },
        },
        {
          type: 'input_audio',
          input_audio: { data: 'UklGRg==', format: 'wav' },
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        {
          type: 'file',
          file: {
            file_data: 'data:application/pdf;base64,JVBERi0=',
            filename: 'a.pdf',
          },
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        { type: 'file', file: { file_id: 'file-1' } },
      ],
    },
  ],
  [
    'an assistant turn with a refusal part and earlier sound',
    {
      role: 'assistant',
      content: [{ type: 'refusal', refusal: 'No.' }],
      audio: { id: 'audio_1' },
    },
  ],
])('%s is sent to OpenAI as it was read', (_, message) => {
  expect(wireMessages(leaving('chat', true), [messageOf(message)])).toEqual([
    message,
  ]);
});

test.each([
  [
    'a file by address, a video and sound of another format',
    {
      role: 'user',
      content: [
        {
          type: 'file',
          file: { file_data: 'https://x.test/a.pdf', filename: 'a.pdf' },
        },
        {
          type: 'video_url',
          video_url: { url: 'https://x.test/a.mp4', processing: 'agentic' },
        },
        {
          type: 'input_audio',
          input_audio: { data: 'ZkxhQw==', format: 'flac' },
        },
      ],
    },
  ],
  [
    'an assistant turn with the pictures it made',
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here it is.' }],
      images: [
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0=' },
          index: 0,
        },
      ],
    },
  ],
  [
    'a tool message holding a picture',
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'The chart:' },
        { type: 'image_url', image_url: { url: 'https://x.test/chart.png' } },
      ],
    },
  ],
])('%s is sent to a dialect that takes it as it was read', (_, message) => {
  expect(
    wireMessages(leaving('chat'), [messageOf(message)], {
      name: 'router',
      files: 'any',
      sound: 'any',
      video: true,
      shown: true,
      images: true,
    }),
  ).toEqual([message]);
});

test('reasoning under one name is read where the other name is null', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: 'Hi',
      reasoning: 'Hm.',
      reasoning_content: null,
    }),
  ).toEqual({
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'Hm.' },
      { type: 'text', text: 'Hi' },
    ],
  });
});

test('a field of a tool call that is not read is kept on the part as a hint, where it sat', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'weather', arguments: '{}', signature: 'c2ln' },
          extra_content: { google: { thought_signature: 'c2ln' } },
        },
        {
          id: 'call_b',
          type: 'custom',
          custom: { name: 'shell', input: 'ls', signature: 'c2ln' },
          vendor: { a: 1 },
        },
      ],
    }),
  ).toEqual({
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
        hints: {
          'openai.chat': { vendor: { a: 1 }, custom: { signature: 'c2ln' } },
        },
      },
    ],
  });
});

test('a tool call`s place in a stream is no field of the call', () => {
  expect(
    messageOf({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          index: 0,
          id: 'call_a',
          type: 'function',
          function: { name: 'now', arguments: '{}' },
        },
      ],
    }),
  ).toEqual({
    role: 'assistant',
    parts: [{ type: 'tool_call', id: 'call_a', name: 'now', input: {} }],
  });
});
