import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import { inputContent, partsOf } from '../../src/responses/content.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('the hints of a text part go on its input text', () => {
  const left = leaving('responses');
  expect(
    inputContent(left, {
      type: 'text',
      text: 'hi',
      hints: {
        'openai.responses': { vendor_note: 'kept' },
        anthropic: { x: 1 },
      },
    }),
  ).toEqual({ vendor_note: 'kept', type: 'input_text', text: 'hi' });
  expect(left.leftOut()).toEqual([]);
});

test('an inline image is split into bytes and a media type, and rejoined', () => {
  const parts = partsOf(
    { type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ' },
    'c',
  );
  expect(parts).toEqual([
    { type: 'image', data: '/9j/4AAQ', mediaType: 'image/jpeg' },
  ]);
  expect(parts.map((part) => inputContent(leaving('responses'), part))).toEqual(
    [{ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQ' }],
  );
});

test('image bytes with no media type fail the call, and are given none', () => {
  const sent = () =>
    inputContent(leaving('responses'), { type: 'image', data: 'iVBORw0KGgo=' });
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(
    'The Responses API cannot carry image bytes of no named media type',
  );
});

test('audio is read, and has no form to be sent in', () => {
  const parts = partsOf(
    { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
    'c',
  );
  expect(parts).toEqual([
    { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' },
  ]);
  const sent = () =>
    parts.map((part) => inputContent(leaving('responses'), part));
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow('The Responses API cannot carry audio');
});

test('a cache marker is read from input content and written back on it, to an upstream that takes one', () => {
  const marker = { prompt_cache_breakpoint: { mode: 'explicit' } };
  const parts = [
    ...partsOf({ type: 'input_text', text: 'Stable', ...marker }, 'c'),
    ...partsOf({ type: 'input_image', file_id: 'file-1', ...marker }, 'c'),
    ...partsOf({ type: 'input_file', file_id: 'file-2', ...marker }, 'c'),
  ];
  expect(parts).toEqual([
    { type: 'text', text: 'Stable', cache: {} },
    { type: 'image', id: 'file-1', cache: {} },
    { type: 'file', id: 'file-2', cache: {} },
  ]);
  const left = leaving('responses', true);
  expect(parts.map((part) => inputContent(left, part))).toEqual([
    { type: 'input_text', text: 'Stable', ...marker },
    { type: 'input_image', file_id: 'file-1', ...marker },
    { type: 'input_file', file_id: 'file-2', ...marker },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('a cache marker is left out and reported unless the upstream is said to take one', () => {
  const left = leaving('responses');
  expect(
    inputContent(left, { type: 'text', text: 'Stable', cache: {} }),
  ).toEqual({ type: 'input_text', text: 'Stable' });
  expect(left.leftOut()).toEqual([
    {
      setting: 'cache',
      detail:
        'The Responses API has no field for a cache marker, to an upstream not said to take one',
    },
  ]);
});

test('the lifetime of a cache marker is left out of input content and reported', () => {
  const left = leaving('responses', true);
  expect(
    inputContent(left, { type: 'text', text: 'Stable', cache: { ttl: '1h' } }),
  ).toEqual({
    type: 'input_text',
    text: 'Stable',
    prompt_cache_breakpoint: { mode: 'explicit' },
  });
  expect(left.leftOut()).toEqual([
    {
      setting: 'cache.ttl',
      detail: 'The Responses API has no field for a lifetime on a cache marker',
    },
  ]);
});

test('output text gives its annotations as citations after it', () => {
  expect(
    partsOf(
      {
        type: 'output_text',
        text: 'See the docs.',
        logprobs: [],
        annotations: [
          {
            type: 'url_citation',
            url: 'https://x.test',
            title: 'Docs',
            start_index: 4,
            end_index: 12,
          },
          {
            type: 'file_citation',
            file_id: 'file-3',
            filename: 'a.md',
            index: 0,
          },
        ],
      },
      'c',
    ),
  ).toEqual([
    {
      type: 'text',
      text: 'See the docs.',
      hints: { 'openai.responses': { logprobs: [] } },
    },
    {
      type: 'citation',
      url: 'https://x.test',
      title: 'Docs',
      provider: {
        'openai.responses': {
          type: 'url_citation',
          url: 'https://x.test',
          title: 'Docs',
          start_index: 4,
          end_index: 12,
        },
      },
    },
    {
      type: 'citation',
      title: 'a.md',
      provider: {
        'openai.responses': {
          type: 'file_citation',
          file_id: 'file-3',
          filename: 'a.md',
          index: 0,
        },
      },
    },
  ]);
});

test('content of a kind not known is carried whole and sent back whole', () => {
  const parts = partsOf({ type: 'input_video', video_url: 'https://v' }, 'c');
  expect(parts).toEqual([
    {
      type: 'provider',
      provider: {
        'openai.responses': { type: 'input_video', video_url: 'https://v' },
      },
    },
  ]);
  expect(parts.map((part) => inputContent(leaving('responses'), part))).toEqual(
    [{ type: 'input_video', video_url: 'https://v' }],
  );
});

test('content that lacks what its kind needs is refused by name', () => {
  expect(() => partsOf('hi', 'input[0].content[0]')).toThrow(
    'input[0].content[0] must be an object',
  );
  expect(() => partsOf({ type: 'input_text' }, 'c')).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'refusal' }, 'c')).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'input_image' }, 'c')).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'input_file' }, 'c')).toThrow(InvalidRequest);
  expect(() => partsOf({ type: 'input_audio' }, 'c')).toThrow(InvalidRequest);
});

test('a part with no form as input content is refused', () => {
  expect(() =>
    inputContent(leaving('responses'), { type: 'refusal', text: 'No.' }),
  ).toThrow(Unsupported);
  expect(() =>
    inputContent(leaving('responses'), {
      type: 'provider',
      provider: { anthropic: { a: 1 } },
    }),
  ).toThrow(Unsupported);
});

test.each([
  [
    'an image by address',
    {
      type: 'input_image',
      image_url: 'https://x.test/cat.png',
      detail: 'original',
      prompt_cache_breakpoint: { mode: 'explicit' },
    },
  ],
  [
    'a file by address',
    {
      type: 'input_file',
      filename: 'a.pdf',
      file_url: 'https://x.test/a.pdf',
      detail: 'high',
      prompt_cache_breakpoint: { mode: 'explicit' },
    },
  ],
  [
    'file bytes of a named type',
    {
      type: 'input_file',
      filename: 'a.csv',
      file_data: 'data:text/csv;base64,YSxiCg==',
    },
  ],
  [
    'file bytes of no named type',
    { type: 'input_file', filename: 'a.pdf', file_data: 'JVBERi0=' },
  ],
])('%s goes back as it was read, with all it held', (_, content) => {
  expect(
    partsOf(content, 'c').map((part) =>
      inputContent(leaving('responses', true), part),
    ),
  ).toEqual([content]);
});

test('what a refusal held beside its text is kept for its own family', () => {
  expect(
    partsOf({ type: 'refusal', refusal: 'No.', reason: 'policy' }, 'c'),
  ).toEqual([
    {
      type: 'refusal',
      text: 'No.',
      hints: { 'openai.responses': { reason: 'policy' } },
    },
  ]);
});

test('an image`s detail said for this API replaces the one said for both, and one said for the other API is not read', () => {
  expect(
    inputContent(leaving('responses'), {
      type: 'image',
      url: 'https://x.test/a.png',
      hints: {
        openai: { detail: 'low' },
        'openai.chat': { detail: 'auto' },
        'openai.responses': { detail: 'high' },
      },
    }),
  ).toEqual({
    detail: 'high',
    type: 'input_image',
    image_url: 'https://x.test/a.png',
  });
});
