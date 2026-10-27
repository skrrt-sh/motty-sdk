import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { blocksOf } from '../../src/messages/blocks.ts';
import { contentOf, partsOf } from '../../src/messages/parts.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('the citations of a text block follow its text', () => {
  const location = {
    type: 'char_location',
    cited_text: 'The grass is green.',
    document_index: 0,
    document_title: 'Facts',
    start_char_index: 0,
    end_char_index: 19,
  };
  const search = {
    type: 'web_search_result_location',
    url: 'https://example.com/a',
    title: 'A page',
    cited_text: 'Quoted.',
    encrypted_index: 'Eo8BCio',
  };
  expect(
    partsOf({ type: 'text', text: 'Green.', citations: [location, search] }),
  ).toEqual([
    { type: 'text', text: 'Green.' },
    {
      type: 'citation',
      title: 'Facts',
      text: 'The grass is green.',
      provider: { anthropic: location },
    },
    {
      type: 'citation',
      title: 'A page',
      url: 'https://example.com/a',
      text: 'Quoted.',
      provider: { anthropic: search },
    },
  ]);
});

test('a document of plain text is read as a file of its bytes', () => {
  expect(
    partsOf({
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'Grass is grün.',
      },
      title: 'Facts',
    }),
  ).toEqual([
    {
      type: 'file',
      data: 'R3Jhc3MgaXMgZ3LDvG4u',
      mediaType: 'text/plain',
      name: 'Facts',
    },
  ]);
});

test('a document made of content blocks stays as it was sent', () => {
  const block = {
    type: 'document',
    source: { type: 'content', content: [{ type: 'text', text: 'Grass.' }] },
    title: 'Facts',
  };
  expect(partsOf(block)).toEqual([
    { type: 'provider', provider: { anthropic: block } },
  ]);
});

test('a tool call and a hosted tool call are read with their input', () => {
  expect(
    partsOf({
      type: 'tool_use',
      id: 'toolu_01A09q90qw90lq917835lq9',
      name: 'get_weather',
      input: { location: 'Paris' },
      caller: { type: 'direct' },
    }),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'toolu_01A09q90qw90lq917835lq9',
      name: 'get_weather',
      input: { location: 'Paris' },
      hints: { anthropic: { caller: { type: 'direct' } } },
    },
  ]);
  expect(
    partsOf({
      type: 'server_tool_use',
      id: 'srvtoolu_01',
      name: 'web_search',
      input: { query: 'weather' },
    }),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'srvtoolu_01',
      name: 'web_search',
      input: { query: 'weather' },
      hosted: true,
      provider: { anthropic: { type: 'server_tool_use' } },
    },
  ]);
});

test('a tool result is read as text, as blocks, failed or empty', () => {
  expect(
    partsOf({ type: 'tool_result', tool_use_id: 'toolu_01', content: '15C' }),
  ).toEqual([{ type: 'tool_result', id: 'toolu_01', text: '15C' }]);
  expect(
    partsOf({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      is_error: true,
      content: [{ type: 'text', text: 'No such city' }],
      cache_control: { type: 'ephemeral' },
    }),
  ).toEqual([
    {
      type: 'tool_result',
      id: 'toolu_01',
      parts: [{ type: 'text', text: 'No such city' }],
      failed: true,
      cache: {},
    },
  ]);
  expect(partsOf({ type: 'tool_result', tool_use_id: 'toolu_01' })).toEqual([
    { type: 'tool_result', id: 'toolu_01', text: '' },
  ]);
});

test("thinking keeps its signature as this family's own", () => {
  expect(
    partsOf({
      type: 'thinking',
      thinking: 'Let me work through it.',
      signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk',
    }),
  ).toEqual([
    {
      type: 'reasoning',
      text: 'Let me work through it.',
      provider: {
        anthropic: {
          signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk',
        },
      },
    },
  ]);
});

test('thinking with no signature is reasoning nobody signed', () => {
  expect(
    partsOf({ type: 'thinking', thinking: 'Routing to fast', signature: '' }),
  ).toEqual([{ type: 'reasoning', text: 'Routing to fast' }]);
});

test('a block not known here stays as sent', () => {
  const search = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_01',
    content: [{ type: 'web_search_result', url: 'https://example.com' }],
  };
  expect(partsOf(search)).toEqual([
    { type: 'provider', provider: { anthropic: search } },
  ]);
});

test('content is a string or a list of blocks', () => {
  expect(contentOf('Hello', 'content')).toEqual({ text: 'Hello' });
  expect(contentOf([{ type: 'text', text: 'Hello' }], 'content')).toEqual({
    parts: [{ type: 'text', text: 'Hello' }],
  });
  expect(() => contentOf(7, 'content')).toThrow(InvalidRequest);
});

test('a malformed block is rejected', () => {
  expect(() => partsOf('text')).toThrow(InvalidRequest);
  expect(() => partsOf({ text: 'no type' })).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'text' })).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'image', source: { type: 'gif' } })).toThrow(
    InvalidRequest,
  );
  expect(() => partsOf({ type: 'tool_use', id: 'toolu_01' })).toThrow(
    InvalidRequest,
  );
  expect(() =>
    partsOf({ type: 'tool_use', id: 'toolu_01', name: 'get', input: 'x' }),
  ).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'tool_result', content: 'x' })).toThrow(
    InvalidRequest,
  );
  expect(() => partsOf({ type: 'thinking', signature: 's' })).toThrow(
    InvalidRequest,
  );
});

test.each([
  [
    'an image of bytes',
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/gif', data: 'R0lGOA==' },
      transformations: { oversized_image: 'error' },
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ],
  [
    'an image by address',
    { type: 'image', source: { type: 'url', url: 'https://x.test/cat.png' } },
  ],
  [
    'a PDF of bytes',
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERi0=',
      },
      title: 'Report',
      context: 'Q3 figures',
      citations: { enabled: true },
      cache_control: { type: 'ephemeral' },
    },
  ],
  [
    'an uploaded document',
    {
      type: 'document',
      source: { type: 'file', file_id: 'file_011C' },
      citations: { enabled: true },
    },
  ],
  [
    'a tool result holding an image and a document',
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
          source: { type: 'file', file_id: 'file_011C' },
          title: 'Report',
        },
      ],
    },
  ],
])('%s is written back as it was read, with all it held', (_, block) => {
  expect(blocksOf(leaving('messages'), partsOf(block))).toEqual([block]);
});
