import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { RunStream } from '@mottyjs/core/host';
import { decode } from '../../src/messages/decode.ts';
import { formless } from '../../src/messages/formless.ts';

const ends = (setting: string, what: string) => ({
  warning: { setting, detail: `Anthropic Messages has no form for ${what}` },
  ends: true,
});

test('content that is the answer and has no form here ends the reply', () => {
  expect(
    formless({ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }),
  ).toEqual(ends('file', 'a file the model made'));
  expect(formless({ type: 'tool_result', id: 'srv_1', output: [] })).toEqual(
    ends('tool_result', 'the result of a tool the upstream ran'),
  );
  expect(
    formless({
      type: 'provider',
      provider: { 'openai.responses': { type: 'web_search_call' } },
    }),
  ).toEqual(ends('provider', 'a part only another API can read'));
  expect(
    formless({
      type: 'tool_call',
      id: 'ws_1',
      name: 'web_search',
      arguments: '{}',
      hosted: true,
    }),
  ).toEqual(ends('tool_call', 'a call to a tool another upstream ran'));
});

test('an encrypted reasoning item is left out and the reply goes on', () => {
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: {
        'openai.responses': { type: 'reasoning', encrypted_content: 'gAAA' },
      },
    }),
  ).toEqual({
    warning: {
      setting: 'reasoning',
      detail:
        'Anthropic Messages has no form for what a model goes on from its reasoning with',
    },
    ends: false,
  });
});

test('a citation another API wrote is left out and the reply goes on', () => {
  expect(
    formless({
      type: 'citation',
      url: 'https://example.com',
      title: 'Almanac',
    }),
  ).toEqual({
    warning: {
      setting: 'citation',
      detail: 'Anthropic Messages has no form for a citation another API wrote',
    },
    ends: false,
  });
});

test('what this API has a form for is not named', () => {
  expect(formless({ type: 'text', text: 'Hi' })).toBeUndefined();
  expect(
    formless({
      type: 'tool_call',
      id: 'srvtoolu_1',
      name: 'web_search',
      arguments: '{}',
      hosted: true,
      provider: { anthropic: { type: 'server_tool_use' } },
    }),
  ).toBeUndefined();
  expect(
    formless({
      type: 'tool_call',
      id: 'srvtoolu_1',
      arguments: '{"query":',
    }),
  ).toBeUndefined();
  expect(formless({ type: 'reasoning', text: 'Hm' })).toBeUndefined();
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
    }),
  ).toBeUndefined();
  expect(
    formless({
      type: 'reasoning',
      text: '',
      provider: { anthropic: { type: 'redacted_thinking', data: 'RED' } },
    }),
  ).toBeUndefined();
  expect(
    formless({
      type: 'citation',
      provider: { anthropic: { type: 'char_location', cited_text: 'rain' } },
    }),
  ).toBeUndefined();
});

const asked = () =>
  decode(
    {
      model: 'coder',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Draw' }],
    },
    new Headers(),
  );

test('a file the model made ends a stream on the error event of this API', async () => {
  async function* run(): RunStream {
    yield { type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' };
    yield { type: 'finish', reason: 'stop' };
  }
  const frames = await Array.fromAsync(asked().streamed(run(), 'r1'));
  expect(frames.map(({ event }) => event)).toEqual(['message_start', 'error']);
  expect(JSON.parse(frames.at(-1)?.data ?? '')).toMatchObject({
    type: 'error',
    error: {
      message: 'Anthropic Messages has no form for a file the model made',
    },
  });
});

test('a file the model made fails a collected reply', () => {
  expect(() =>
    asked().collected(
      [{ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
      { type: 'finish', reason: 'stop' },
      'r1',
    ),
  ).toThrow(Unsupported);
});
