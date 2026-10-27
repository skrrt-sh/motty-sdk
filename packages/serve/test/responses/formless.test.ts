import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { RunStream } from '@mottyjs/core/host';
import { decode } from '../../src/responses/decode.ts';
import { formless } from '../../src/responses/formless.ts';

const ends = (setting: string, what: string) => ({
  warning: { setting, detail: `The Responses API has no form for ${what}` },
  ends: true,
});

test('content that is the answer and has no form here ends the reply', () => {
  expect(
    formless({ type: 'file', url: 'https://example.com/out.pdf' }),
  ).toEqual(ends('file', 'a file the model made that is not an inline image'));
  expect(
    formless({ type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' }),
  ).toEqual(ends('file', 'a file the model made that is not an inline image'));
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

test('a citation with neither an address nor a form of this API is left out', () => {
  expect(formless({ type: 'citation', title: 'Almanac' })).toEqual({
    warning: {
      setting: 'citation',
      detail: 'The Responses API has no form for a citation with no address',
    },
    ends: false,
  });
});

test('what a model goes on from its reasoning with is left out unless the request includes it, and the reply goes on', () => {
  const left = {
    warning: {
      setting: 'reasoning',
      detail:
        'The Responses API has no form for what a model goes on from its reasoning with, which the request did not include',
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
    formless(
      {
        type: 'reasoning',
        text: '',
        provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
      },
      true,
    ),
  ).toBeUndefined();
  expect(formless({ type: 'reasoning', text: 'Hm' })).toBeUndefined();
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: {
        'openai.responses': { type: 'reasoning', encrypted_content: 'gAAA' },
      },
    }),
  ).toBeUndefined();
});

test('what this API has a form for is not named', () => {
  expect(formless({ type: 'text', text: 'Hi' })).toBeUndefined();
  expect(
    formless({ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }),
  ).toBeUndefined();
  expect(
    formless({ type: 'citation', url: 'https://example.com' }),
  ).toBeUndefined();
  expect(
    formless({
      type: 'citation',
      provider: {
        'openai.responses': { type: 'file_citation', file_id: 'file_1' },
      },
    }),
  ).toBeUndefined();
  expect(
    formless({
      type: 'provider',
      provider: { 'openai.responses': { type: 'web_search_call', id: 'ws_1' } },
    }),
  ).toBeUndefined();
});

const asked = () => decode({ model: 'coder', input: 'Draw' });

test('an inline image the model made is written, in a stream and in a whole reply', async () => {
  const item = {
    id: 'ig_r1_0',
    type: 'image_generation_call',
    status: 'completed',
    result: 'iVBORw0KGgo=',
  };
  async function* run(): RunStream {
    yield { type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' };
    yield { type: 'finish', reason: 'stop' };
  }
  const frames = await Array.fromAsync(asked().streamed(run(), 'r1'));
  expect(JSON.parse(frames.at(-1)?.data ?? '')).toMatchObject({
    type: 'response.completed',
    response: { status: 'completed', output: [item] },
  });
  expect(
    asked().collected(
      [{ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
      { type: 'finish', reason: 'stop' },
      'r1',
    ),
  ).toMatchObject({ status: 'completed', output: [item] });
});

test('a file with no form ends a stream as a failed response', async () => {
  async function* run(): RunStream {
    yield { type: 'file', url: 'https://example.com/out.pdf' };
    yield { type: 'finish', reason: 'stop' };
  }
  const frames = await Array.fromAsync(asked().streamed(run(), 'r1'));
  expect(JSON.parse(frames.at(-1)?.data ?? '')).toMatchObject({
    type: 'response.failed',
    response: {
      status: 'failed',
      error: {
        code: 'unsupported',
        message:
          'The Responses API has no form for a file the model made that is not an inline image',
      },
    },
  });
});

test('a file with no form fails a collected reply', () => {
  expect(() =>
    asked().collected(
      [{ type: 'file', url: 'https://example.com/out.pdf' }],
      { type: 'finish', reason: 'stop' },
      'r1',
    ),
  ).toThrow(Unsupported);
});
