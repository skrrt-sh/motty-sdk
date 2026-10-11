import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { RunStream } from '@mottyjs/core/host';
import { decode } from '../../src/chat-completions/decode.ts';
import { formless } from '../../src/chat-completions/formless.ts';

const ends = (setting: string, what: string) => ({
  warning: { setting, detail: `Chat Completions has no form for ${what}` },
  ends: true,
});

test('content that is the answer and has no form here ends the reply', () => {
  expect(
    formless({ type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' }),
  ).toEqual(ends('file', 'a file the model made that is not a picture'));
  expect(formless({ type: 'tool_result', id: 'srv_1', output: [] })).toEqual(
    ends('tool_result', 'the result of a tool the upstream ran'),
  );
  expect(
    formless({
      type: 'tool_call',
      id: 'srv_1',
      name: 'web_search',
      arguments: '{}',
      hosted: true,
    }),
  ).toEqual(ends('tool_call', 'a call to a tool the upstream ran'));
  expect(
    formless({
      type: 'provider',
      provider: { anthropic: { type: 'compaction', content: 'So far' } },
    }),
  ).toEqual(ends('provider', 'a part only another API can read'));
});

test('a citation with no address is left out and the reply goes on', () => {
  expect(formless({ type: 'citation', title: 'Almanac' })).toEqual({
    warning: {
      setting: 'citation',
      detail: 'Chat Completions has no form for a citation with no address',
    },
    ends: false,
  });
});

test('what a model goes on from its reasoning with is left out and the reply goes on', () => {
  const left = {
    warning: {
      setting: 'reasoning',
      detail:
        'Chat Completions has no form for what a model goes on from its reasoning with',
    },
    ends: false,
  };
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
    }),
  ).toEqual(left);
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: { anthropic: { type: 'redacted_thinking', data: 'EmwK' } },
    }),
  ).toEqual(left);
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: {
        'openai.responses': { type: 'reasoning', encrypted_content: 'gAAA' },
      },
    }),
  ).toEqual(left);
  expect(formless({ type: 'reasoning', text: 'Hm' })).toBeUndefined();
});

test('what this API has a form for is not named', () => {
  expect(formless({ type: 'text', text: 'Hi' })).toBeUndefined();
  expect(formless({ type: 'reasoning', text: 'Hm' })).toBeUndefined();
  expect(formless({ type: 'refusal', text: 'No' })).toBeUndefined();
  expect(
    formless({ type: 'tool_call', id: 'call_1', name: 'look', arguments: '' }),
  ).toBeUndefined();
  expect(
    formless({ type: 'citation', url: 'https://example.com' }),
  ).toBeUndefined();
  expect(
    formless({
      type: 'provider',
      provider: { 'openai.chat': { audio: { id: 'audio_1' } } },
    }),
  ).toBeUndefined();
});

const asked = () =>
  decode({ model: 'coder', messages: [{ role: 'user', content: 'Draw' }] });

test('a file the model made ends a stream on the error frame and never marks it done', async () => {
  async function* run(): RunStream {
    yield { type: 'text', text: 'Here: ' };
    yield { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' };
    yield { type: 'finish', reason: 'stop' };
  }
  const frames = await Array.fromAsync(asked().streamed(run(), 'r1'));
  expect(frames.map(({ data }) => JSON.parse(data))).toMatchObject([
    { choices: [{ delta: { content: 'Here: ' }, finish_reason: null }] },
    {
      error: {
        code: 'unsupported',
        message:
          'Chat Completions has no form for a file the model made that is not a picture',
      },
    },
  ]);
});

test('a file the model made fails a collected reply', () => {
  const collected = () =>
    asked().collected(
      [{ type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' }],
      { type: 'finish', reason: 'stop' },
      'r1',
    );
  expect(collected).toThrow(Unsupported);
  expect(collected).toThrow(
    'Chat Completions has no form for a file the model made that is not a picture',
  );
});

test('reasoning details are this family`s own, so a caller is sent them', () => {
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: {
        'openai.chat': {
          reasoning_details: [
            { type: 'reasoning.text', signature: 'EqQB', index: 0 },
          ],
        },
      },
    }),
  ).toBeUndefined();
});

test.each([
  ['a PDF', { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' }],
  [
    'a file by address of no named type',
    { type: 'file', url: 'https://x.test/a' },
  ],
  [
    'an image held by id',
    { type: 'file', id: 'file-1', mediaType: 'image/png' },
  ],
] as const)('%s a model made has no form and ends the reply', (_, chunk) => {
  expect(formless(chunk)).toEqual(
    ends('file', 'a file the model made that is not a picture'),
  );
});

test.each([
  ['its bytes', { type: 'file', data: 'iVBORw0=', mediaType: 'image/png' }],
  [
    'its address',
    { type: 'file', url: 'https://x.test/made.png', mediaType: 'image/png' },
  ],
] as const)('a picture a model made has a form, by %s', (_, chunk) => {
  expect(formless(chunk)).toBeUndefined();
});
