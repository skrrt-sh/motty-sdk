import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { Json, Part } from '@mottyjs/core/host';
import type { Dialect } from '../../src/chat-completions/dialect.ts';
import { wireMessages } from '../../src/chat-completions/encode-messages.ts';
import { leaving } from '../../src/wire/fieldless.ts';
import { a } from '../../src/wire/refusals.ts';

function asked(dialect: Dialect, part: Part) {
  return wireMessages(
    leaving('chat'),
    [{ role: 'user', parts: [part] }],
    dialect,
  );
}

test.each<[string, Dialect, Part, Json]>([
  [
    'an image by address',
    { name: 'openai.chat' },
    { type: 'image', url: 'https://x.test/cat.png' },
    { type: 'image_url', image_url: { url: 'https://x.test/cat.png' } },
  ],
  [
    'an uploaded image, where it is a file part',
    { name: 'deepseek', files: 'pictures' },
    { type: 'image', id: 'file-api-1' },
    { type: 'file', file_id: 'file-api-1' },
  ],
  [
    'a PDF by its bytes, with its name',
    { name: 'openai.chat' },
    {
      type: 'file',
      data: 'JVBERi0=',
      mediaType: 'application/pdf',
      name: 'a.pdf',
    },
    {
      type: 'file',
      file: {
        file_data: 'data:application/pdf;base64,JVBERi0=',
        filename: 'a.pdf',
      },
    },
  ],
  [
    'file bytes of no named type, bare',
    { name: 'openai.chat' },
    { type: 'file', data: 'JVBERi0=', name: 'a.pdf' },
    { type: 'file', file: { file_data: 'JVBERi0=', filename: 'a.pdf' } },
  ],
  [
    'a file by address, where the data field takes one',
    { name: 'router', files: 'any' },
    { type: 'file', url: 'https://x.test/a.pdf', name: 'a.pdf' },
    {
      type: 'file',
      file: { file_data: 'https://x.test/a.pdf', filename: 'a.pdf' },
    },
  ],
  [
    'a file that is no PDF, where any is taken',
    { name: 'router', files: 'any' },
    { type: 'file', data: 'YSxiCg==', mediaType: 'text/csv' },
    {
      type: 'file',
      file: {
        file_data: 'data:text/csv;base64,YSxiCg==',
        filename: 'file.csv',
      },
    },
  ],
  [
    'a video by address',
    { name: 'router', files: 'any', video: true },
    { type: 'file', url: 'https://x.test/a.mp4', mediaType: 'video/mp4' },
    { type: 'video_url', video_url: { url: 'https://x.test/a.mp4' } },
  ],
  [
    'a picture as a file, with nothing around its fields',
    { name: 'deepseek', files: 'pictures' },
    { type: 'file', data: '/9j/4AAQ', mediaType: 'image/jpeg', name: 'a.jpg' },
    {
      type: 'file',
      file_data: 'data:image/jpeg;base64,/9j/4AAQ',
      filename: 'a.jpg',
    },
  ],
  [
    'wav sound',
    { name: 'openai.chat' },
    { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' },
    { type: 'input_audio', input_audio: { data: 'UklGRg==', format: 'wav' } },
  ],
  [
    'sound in a format only a dialect takes',
    { name: 'router', sound: 'any' },
    { type: 'audio', data: 'ZkxhQw==', mediaType: 'audio/flac' },
    { type: 'input_audio', input_audio: { data: 'ZkxhQw==', format: 'flac' } },
  ],
])('%s is sent in its own form', (_, dialect, part, wire) => {
  expect(asked(dialect, part)).toEqual([{ role: 'user', content: [wire] }]);
});

test.each<[string, Dialect, Part, string]>([
  [
    'image bytes of no named type',
    { name: 'openai.chat' },
    { type: 'image', data: 'iVBORw0=' },
    'Chat Completions cannot carry image bytes of no named media type',
  ],
  [
    'an uploaded image',
    { name: 'openai.chat' },
    { type: 'image', id: 'file-1' },
    'Chat Completions cannot carry an image given by id',
  ],
  [
    'a file by address, where a file is a picture',
    { name: 'deepseek', files: 'pictures' },
    { type: 'file', url: 'https://x.test/a.png', mediaType: 'image/png' },
    'Chat Completions cannot carry a file given by address',
  ],
  [
    'a file that is no PDF',
    { name: 'openai.chat' },
    { type: 'file', data: 'YSxiCg==', mediaType: 'text/csv' },
    'Chat Completions takes no text/csv file',
  ],
  [
    'a PDF, where a file is a picture',
    { name: 'deepseek', files: 'pictures' },
    { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
    'Chat Completions takes no application/pdf file',
  ],
  [
    'file bytes of no named type, where the field takes a data address',
    { name: 'router', files: 'any' },
    { type: 'file', data: 'JVBERi0=' },
    'Chat Completions cannot carry file bytes of no named media type',
  ],
  [
    'the name of an uploaded file, where an id goes alone',
    { name: 'deepseek', files: 'pictures' },
    { type: 'file', id: 'file-api-1', name: 'a.png' },
    'Chat Completions cannot carry the name of a file given by id to deepseek',
  ],
  [
    'a video, where no part takes one',
    { name: 'openai.chat' },
    { type: 'file', data: 'AAAAIGZ0', mediaType: 'video/mp4' },
    'Chat Completions takes no video/mp4 file',
  ],
  [
    'sound that is neither wav nor mp3',
    { name: 'openai.chat' },
    { type: 'audio', data: 'ZkxhQw==', mediaType: 'audio/flac' },
    'Chat Completions cannot carry audio that is not inline wav or mp3',
  ],
  [
    'sound of a type named as what every object inherits',
    { name: 'openai.chat' },
    { type: 'audio', data: 'UklGRg==', mediaType: 'constructor' },
    'Chat Completions cannot carry audio that is not inline wav or mp3',
  ],
  [
    'sound by address',
    { name: 'openai.chat' },
    { type: 'audio', url: 'https://x.test/a.wav', mediaType: 'audio/wav' },
    'Chat Completions cannot carry audio that is not inline wav or mp3',
  ],
  [
    'sound by address, where every format is taken',
    { name: 'router', sound: 'any' },
    { type: 'audio', url: 'https://x.test/a.wav', mediaType: 'audio/wav' },
    'Chat Completions cannot carry audio that is not inline',
  ],
  [
    'sound, where none is taken',
    { name: 'deepseek', sound: 'none' },
    { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' },
    'Chat Completions cannot carry audio to deepseek',
  ],
])('%s fails the call before it is sent', (_, dialect, part, message) => {
  expect(() => asked(dialect, part)).toThrow(Unsupported);
  expect(() => asked(dialect, part)).toThrow(message);
});

test('a tool answers with a picture beside its text, where a tool message takes one', () => {
  expect(
    wireMessages(
      leaving('chat', true),
      [
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              id: 'call_1',
              parts: [
                { type: 'text', text: 'The chart:' },
                { type: 'image', url: 'https://x.test/chart.png' },
              ],
            },
          ],
        },
      ],
      { name: 'router', shown: true },
    ),
  ).toEqual([
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: [
        { type: 'text', text: 'The chart:' },
        { type: 'image_url', image_url: { url: 'https://x.test/chart.png' } },
      ],
    },
  ]);
});

test.each<Part>([{ type: 'image', url: 'https://x.test/chart.png' }])(
  'a tool result holding $type fails the call to OpenAI',
  (inner) => {
    const sent = () =>
      wireMessages(leaving('chat'), [
        {
          role: 'tool',
          parts: [{ type: 'tool_result', id: 'call_1', parts: [inner] }],
        },
      ]);
    expect(sent).toThrow(Unsupported);
    expect(sent).toThrow(
      `Chat Completions cannot carry ${a(inner.type)} part in a tool result`,
    );
  },
);

test.each<['system' | 'developer' | 'assistant', Part]>([
  ['system', { type: 'image', url: 'https://x.test/cat.png' }],
  ['assistant', { type: 'image', url: 'https://x.test/cat.png' }],
  ['assistant', { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' }],
])('a %s message holding $type fails the call', (role, part) => {
  const sent = () => wireMessages(leaving('chat'), [{ role, parts: [part] }]);
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(
    `Chat Completions takes no ${part.type} part from the ${role} role`,
  );
});

test('a picture a model made goes back in the field of its own, where there is one', () => {
  expect(
    wireMessages(
      leaving('chat'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Here it is.' },
            {
              type: 'image',
              data: 'iVBORw0=',
              mediaType: 'image/png',
              provider: { 'openai.chat': { index: 0 } },
            },
            { type: 'image', url: 'https://x.test/made.png' },
          ],
        },
      ],
      { name: 'router', images: true },
    ),
  ).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here it is.' }],
      images: [
        {
          index: 0,
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,iVBORw0=' },
        },
        { type: 'image_url', image_url: { url: 'https://x.test/made.png' } },
      ],
    },
  ]);
});

test('earlier sound has no place where no sound is taken', () => {
  const sent = () =>
    wireMessages(
      leaving('chat'),
      [{ role: 'assistant', parts: [{ type: 'audio', id: 'audio_1' }] }],
      { name: 'deepseek', sound: 'none' },
    );
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow('Chat Completions cannot carry audio to deepseek');
});
