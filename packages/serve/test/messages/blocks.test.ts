import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { blocksOf } from '../../src/messages/blocks.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('text and a refusal are text blocks', () => {
  expect(
    blocksOf(leaving('messages'), [
      { type: 'text', text: 'Hello', cache: { ttl: '5m' } },
      { type: 'refusal', text: 'I cannot help with that.' },
    ]),
  ).toEqual([
    {
      type: 'text',
      text: 'Hello',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    },
    { type: 'text', text: 'I cannot help with that.' },
  ]);
});

test('an image is written from bytes, an address or a file id', () => {
  expect(
    blocksOf(leaving('messages'), [
      { type: 'image', data: 'iVBORw0KGgo=', mediaType: 'image/png' },
      { type: 'image', url: 'https://example.com/cat.png' },
      { type: 'image', id: 'file_011C' },
      { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ' },
    ]),
  ).toEqual([
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
    },
    {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/cat.png' },
    },
    { type: 'image', source: { type: 'file', file_id: 'file_011C' } },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ' },
    },
  ]);
});

test('a file is a document with its title and its own fields', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'file',
        data: 'JVBERi0xLjQ=',
        mediaType: 'application/pdf',
        name: 'Report',
        provider: { anthropic: { citations: { enabled: true } } },
      },
    ]),
  ).toEqual([
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERi0xLjQ=',
      },
      title: 'Report',
      citations: { enabled: true },
    },
  ]);
});

test('signed reasoning is a thinking block; unsigned is left out', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'reasoning',
        text: 'Step one.',
        provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
      },
      { type: 'reasoning', text: 'Routing to fast' },
      {
        type: 'reasoning',
        text: 'Summary',
        provider: { 'openai.responses': { encrypted_content: 'gAAAA' } },
      },
    ]),
  ).toEqual([
    { type: 'thinking', thinking: 'Step one.', signature: 'EqQBCgIYAhIM' },
  ]);
});

test('what a tool call in history said beside its input is written back with it', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'tool_call',
        id: 'toolu_01',
        name: 'get_weather',
        input: { location: 'Paris' },
        hints: { anthropic: { caller: { type: 'direct' } } },
      },
    ]),
  ).toEqual([
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get_weather',
      input: { location: 'Paris' },
      caller: { type: 'direct' },
    },
  ]);
});

test("a tool call's own id, name, input and kind are never replaced by what its hints say", () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'tool_call',
        id: 'toolu_01',
        name: 'get_weather',
        input: { a: 1 },
        hints: {
          anthropic: {
            id: 'other',
            name: 'other',
            input: { b: 2 },
            type: 'text',
          },
        },
      },
    ]),
  ).toEqual([
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get_weather',
      input: { a: 1 },
    },
  ]);
});

test.each([
  [
    { type: 'text', text: 'Look' },
    { type: 'other', text: 'other' },
    { type: 'text', text: 'Look' },
  ],
  [
    { type: 'image', url: 'https://x.test/cat.png' },
    { type: 'other', source: 'other' },
    { type: 'image', source: { type: 'url', url: 'https://x.test/cat.png' } },
  ],
  [
    { type: 'file', id: 'file_011C', name: 'Q3' },
    { type: 'other', source: 'other', title: 'other' },
    {
      type: 'document',
      source: { type: 'file', file_id: 'file_011C' },
      title: 'Q3',
    },
  ],
  [
    { type: 'tool_result', id: 'toolu_01', text: 'Sunny', failed: true },
    { type: 'other', tool_use_id: 'other', content: 'other', is_error: false },
    {
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: 'Sunny',
      is_error: true,
    },
  ],
] as const)(
  'the own fields of a %j part are never replaced by what its hints say',
  (part, hinted, block) => {
    expect(
      blocksOf(leaving('messages'), [
        { ...part, hints: { anthropic: { ...hinted, note: 'kept' } } },
      ]),
    ).toEqual([{ ...block, note: 'kept' }]);
  },
);

test("signed reasoning's own fields are never replaced by what rides with it", () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'reasoning',
        text: 'Step one.',
        provider: {
          anthropic: { signature: 'EqQB', type: 'text', thinking: 'other' },
        },
      },
    ]),
  ).toEqual([{ type: 'thinking', thinking: 'Step one.', signature: 'EqQB' }]);
});

test.each([[[1]], [null]])(
  'a tool call whose input is %j fails the call',
  (input) => {
    expect(() =>
      blocksOf(leaving('messages'), [
        { type: 'tool_call', id: 'call_1', name: 'apply_patch', input },
      ]),
    ).toThrow(
      new Unsupported(
        'Anthropic Messages cannot carry a tool call whose input is not an object',
      ),
    );
  },
);

test('a tool call whose input is free text is sent as the one field of an object', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'apply_patch',
        input: '*** Begin Patch',
      },
    ]),
  ).toEqual([
    {
      type: 'tool_use',
      id: 'call_1',
      name: 'apply_patch',
      input: { input: '*** Begin Patch' },
    },
  ]);
});

test('a tool call and its result are written back', () => {
  expect(
    blocksOf(leaving('messages'), [
      { type: 'tool_call', id: 'toolu_01', name: 'get', input: { a: 1 } },
      {
        type: 'tool_call',
        id: 'srvtoolu_01',
        name: 'web_search',
        input: { query: 'x' },
        hosted: true,
        provider: { anthropic: { type: 'server_tool_use' } },
      },
      { type: 'tool_result', id: 'toolu_01', text: '15C' },
      { type: 'tool_result', id: 'toolu_02', text: '' },
      {
        type: 'tool_result',
        id: 'toolu_03',
        failed: true,
        parts: [{ type: 'text', text: 'No such city' }],
      },
    ]),
  ).toEqual([
    { type: 'tool_use', id: 'toolu_01', name: 'get', input: { a: 1 } },
    {
      type: 'server_tool_use',
      id: 'srvtoolu_01',
      name: 'web_search',
      input: { query: 'x' },
    },
    { type: 'tool_result', tool_use_id: 'toolu_01', content: '15C' },
    { type: 'tool_result', tool_use_id: 'toolu_02' },
    {
      type: 'tool_result',
      tool_use_id: 'toolu_03',
      content: [{ type: 'text', text: 'No such city' }],
      is_error: true,
    },
  ]);
});

test("this family's citation goes back onto the text before it", () => {
  const location = {
    type: 'page_location',
    cited_text: 'Revenue grew.',
    document_index: 0,
    document_title: 'Report',
    start_page_number: 1,
    end_page_number: 2,
  };
  expect(
    blocksOf(leaving('messages'), [
      { type: 'text', text: 'It grew.' },
      { type: 'citation', title: 'Report', provider: { anthropic: location } },
      { type: 'citation', url: 'https://example.com', title: 'Elsewhere' },
    ]),
  ).toEqual([{ type: 'text', text: 'It grew.', citations: [location] }]);
});

test('a provider part of this family is the block itself', () => {
  const redacted = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' };
  expect(
    blocksOf(leaving('messages'), [
      { type: 'provider', provider: { anthropic: redacted } },
    ]),
  ).toEqual([redacted]);
});

test('the cache marker of a message sits on its last block', () => {
  expect(
    blocksOf(
      leaving('messages'),
      [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
      ],
      {},
    ),
  ).toEqual([
    { type: 'text', text: 'one' },
    { type: 'text', text: 'two', cache_control: { type: 'ephemeral' } },
  ]);
});

test('what this wire cannot say fails the call', () => {
  expect(() =>
    blocksOf(leaving('messages'), [
      { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' },
    ]),
  ).toThrow(Unsupported);
  expect(() =>
    blocksOf(leaving('messages'), [
      { type: 'tool_call', id: 'call_1', name: 'get', raw: '{"a":' },
    ]),
  ).toThrow(Unsupported);
  expect(() =>
    blocksOf(leaving('messages'), [{ type: 'image', data: 'iVBORw0KGgo=' }]),
  ).toThrow(Unsupported);
  expect(() =>
    blocksOf(leaving('messages'), [
      { type: 'provider', provider: { 'openai.responses': { type: 'x' } } },
    ]),
  ).toThrow(Unsupported);
  expect(() =>
    blocksOf(leaving('messages'), [
      {
        type: 'text',
        text: 'a',
        provider: { 'openai.chat': { logprobs: [] } },
      },
    ]),
  ).toThrow(Unsupported);
  expect(() =>
    blocksOf(leaving('messages'), [{ type: 'provider', provider: {} }]),
  ).toThrow(Unsupported);
});

test('a hosted call or result this API did not write fails the call', () => {
  expect(() =>
    blocksOf(leaving('messages'), [
      {
        type: 'tool_call',
        id: 'ws_1',
        name: 'web_search',
        input: { query: 'x' },
        hosted: true,
      },
    ]),
  ).toThrow(
    'Anthropic Messages cannot carry a call or a result of a tool another upstream ran',
  );
  expect(() =>
    blocksOf(leaving('messages'), [
      { type: 'tool_result', id: 'ws_1', text: 'Rain', hosted: true },
    ]),
  ).toThrow(Unsupported);
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'tool_result',
        id: 'srvtoolu_01',
        text: 'Rain',
        hosted: true,
        provider: { anthropic: { type: 'web_search_tool_result' } },
      },
    ]),
  ).toEqual([
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_01',
      content: 'Rain',
    },
  ]);
});

test('a media type the API does not list fails the call', () => {
  for (const part of [
    { type: 'image', data: 'Qk0=', mediaType: 'image/bmp' },
    { type: 'image', url: 'data:image/bmp;base64,Qk0=' },
    {
      type: 'image',
      url: 'https://example.com/a.tiff',
      mediaType: 'image/tiff',
    },
    { type: 'file', data: 'YSxiCg==', mediaType: 'text/csv' },
    {
      type: 'file',
      url: 'https://example.com/a.txt',
      mediaType: 'text/plain',
    },
    { type: 'file', data: '/w==', mediaType: 'text/plain' },
    {
      type: 'file',
      url: 'https://example.com/a.docx',
      mediaType: 'application/msword',
    },
  ] as const) {
    expect(() => blocksOf(leaving('messages'), [part])).toThrow(Unsupported);
  }
  expect(
    blocksOf(leaving('messages'), [
      { type: 'image', data: 'UklGRg==', mediaType: 'image/webp' },
      { type: 'image', data: 'R0lGOA==', mediaType: 'image/gif' },
      { type: 'file', url: 'data:application/pdf;base64,JVBERi0=' },
      { type: 'file', id: 'file_011C', mediaType: 'text/plain' },
    ]),
  ).toHaveLength(4);
});

test('text with nothing in it is no block', () => {
  expect(
    blocksOf(leaving('messages'), [
      { type: 'text', text: '' },
      { type: 'refusal', text: '' },
      { type: 'text', text: '', cache: {} },
      {
        type: 'tool_result',
        id: 'toolu_01',
        parts: [{ type: 'text', text: '' }],
      },
    ]),
  ).toEqual([{ type: 'tool_result', tool_use_id: 'toolu_01' }]);
});

test('a cache marker is written on an image, a document and tool blocks', () => {
  expect(
    blocksOf(leaving('messages'), [
      { type: 'image', id: 'file_011C', cache: {} },
      { type: 'file', id: 'file_011D', cache: { ttl: '1h' } },
      { type: 'tool_call', id: 'toolu_01', name: 'get', input: {}, cache: {} },
      { type: 'tool_result', id: 'toolu_01', text: 'ok', cache: { ttl: '5m' } },
    ]),
  ).toEqual([
    {
      type: 'image',
      source: { type: 'file', file_id: 'file_011C' },
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'document',
      source: { type: 'file', file_id: 'file_011D' },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get',
      input: {},
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: 'ok',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    },
  ]);
});

test('what its own family hinted on a part goes on its block; another family`s does not', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'text',
        text: 'Look',
        hints: { anthropic: { note: 'a' }, 'openai.chat': { lang: 'en' } },
      },
      {
        type: 'image',
        url: 'https://x.test/cat.png',
        hints: {
          anthropic: { transformations: { oversized_image: 'error' } },
          'openai.chat': { detail: 'high' },
        },
      },
      {
        type: 'file',
        id: 'file_011C',
        hints: { anthropic: { context: 'Q3 figures' } },
      },
    ]),
  ).toEqual([
    { type: 'text', text: 'Look', note: 'a' },
    {
      type: 'image',
      source: { type: 'url', url: 'https://x.test/cat.png' },
      transformations: { oversized_image: 'error' },
    },
    {
      type: 'document',
      source: { type: 'file', file_id: 'file_011C' },
      context: 'Q3 figures',
    },
  ]);
});

test('a plain-text file is a document of the text it holds', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'file',
        data: 'R3Jhc3MgaXMgZ3LDvG4u',
        mediaType: 'text/plain',
        name: 'Facts',
      },
      { type: 'file', url: 'data:text/plain;base64,aGk=' },
    ]),
  ).toEqual([
    {
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'Grass is grün.',
      },
      title: 'Facts',
    },
    {
      type: 'document',
      source: { type: 'text', media_type: 'text/plain', data: 'hi' },
    },
  ]);
});

test.each([
  [
    'image bytes of no named type',
    { type: 'image', data: 'iVBORw0=' },
    'Anthropic Messages cannot carry image bytes of no named media type',
  ],
  [
    'file bytes of no named type',
    { type: 'file', data: 'JVBERi0=' },
    'Anthropic Messages needs the media type of file bytes',
  ],
  [
    'a plain-text file that is not UTF-8',
    { type: 'file', data: '/w==', mediaType: 'text/plain' },
    'Anthropic Messages takes no plain-text file that is not UTF-8',
  ],
  [
    'a plain-text file by address',
    { type: 'file', url: 'https://x.test/a.txt', mediaType: 'text/plain' },
    'Anthropic Messages takes no text/plain file by address',
  ],
  [
    'sound by address',
    { type: 'audio', url: 'https://x.test/a.wav' },
    'Anthropic Messages cannot carry audio',
  ],
] as const)('%s fails the call before it is sent', (_, part, message) => {
  const sent = () => blocksOf(leaving('messages'), [part]);
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(message);
});

test('a tool answers with text, an image and a document', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'tool_result',
        id: 'toolu_01',
        parts: [
          { type: 'text', text: 'The chart:' },
          { type: 'image', data: 'iVBORw0=', mediaType: 'image/png' },
          { type: 'file', url: 'https://x.test/a.pdf', name: 'Report' },
        ],
      },
    ]),
  ).toEqual([
    {
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      content: [
        { type: 'text', text: 'The chart:' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0=' },
        },
        {
          type: 'document',
          source: { type: 'url', url: 'https://x.test/a.pdf' },
          title: 'Report',
        },
      ],
    },
  ]);
});

test('a tool call that holds only another API`s data is written as its own fields alone', () => {
  expect(
    blocksOf(leaving('messages'), [
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'time',
        input: {},
        provider: { 'openai.chat': { extra_content: { google: {} } } },
      },
      {
        type: 'tool_call',
        id: 'toolu_01',
        name: 'now',
        input: {},
        provider: {
          'openai.chat': { extra_content: { google: {} } },
          anthropic: { caller: { type: 'direct' } },
        },
      },
    ]),
  ).toEqual([
    { type: 'tool_use', id: 'call_1', name: 'time', input: {} },
    {
      caller: { type: 'direct' },
      type: 'tool_use',
      id: 'toolu_01',
      name: 'now',
      input: {},
    },
  ]);
});

test.each([
  [
    {
      type: 'tool_call' as const,
      id: 'ws_1',
      name: 'web_search',
      input: {},
      hosted: true,
      provider: { 'openai.responses': { type: 'web_search_call' } },
    },
    'Anthropic Messages cannot carry a tool_call part of openai.responses: type',
  ],
  [
    {
      type: 'tool_result' as const,
      id: 'call_1',
      text: 'noon',
      provider: { 'openai.responses': { status: 'completed' } },
    },
    'Anthropic Messages cannot carry a tool_result part of openai.responses: status',
  ],
])(
  'a hosted call or a result that holds only another API`s data still fails the call',
  (part, message) => {
    expect(() => blocksOf(leaving('messages'), [part])).toThrow(
      new Unsupported(message),
    );
  },
);
