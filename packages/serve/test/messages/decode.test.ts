import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { decode } from '../../src/messages/decode.ts';
import { encode } from '../../src/messages/encode.ts';
import { parsed } from '../../src/wire/json.ts';

test('a plain request is decoded with its model, turns and limit', () => {
  const decoded = decode(
    {
      model: 'coder',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hello, Claude' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: [{ type: 'text', text: 'Explain SSE.' }] },
      ],
    },
    new Headers({ 'anthropic-version': '2023-06-01' }),
  );
  expect(decoded.stream).toBe(false);
  expect(decoded.request).toEqual({
    model: 'coder',
    messages: [
      { role: 'user', text: 'Hello, Claude' },
      { role: 'assistant', text: 'Hello!' },
      { role: 'user', parts: [{ type: 'text', text: 'Explain SSE.' }] },
    ],
    tools: [],
    options: { maxTokens: 1024 },
  });
});

test('system as a string is the first message', () => {
  const { request } = decode(
    {
      model: 'coder',
      max_tokens: 64,
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'Hi' }],
    },
    new Headers(),
  );
  expect(request.messages).toEqual([
    { role: 'system', text: 'You are terse.' },
    { role: 'user', text: 'Hi' },
  ]);
});

test('a body that is not a valid request is rejected', () => {
  const none = new Headers();
  const turn = { role: 'user', content: 'Hi' };
  for (const body of [
    'model=coder',
    { max_tokens: 64, messages: [turn] },
    { model: 'coder', messages: [turn] },
    { model: 'coder', max_tokens: 64 },
    { model: 'coder', max_tokens: 64, messages: [] },
    { model: 'coder', max_tokens: 64, messages: ['Hi'] },
    {
      model: 'coder',
      max_tokens: 64,
      messages: [{ role: 'tool', content: 'x' }],
    },
    { model: 'coder', max_tokens: 64, messages: [{ role: 'user' }] },
    { model: 'coder', max_tokens: 64, messages: [turn], system: 7 },
    { model: 'coder', max_tokens: 64, messages: [turn], tools: {} },
    { model: 'coder', max_tokens: 64, messages: [turn], stream: 'yes' },
  ]) {
    expect(() => decode(body, none)).toThrow(InvalidRequest);
  }
});

test('an API version with another stream format is rejected', () => {
  expect(() =>
    decode(
      {
        model: 'coder',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      new Headers({ 'anthropic-version': '2023-01-01' }),
    ),
  ).toThrow(InvalidRequest);
});

test("a system turn's own fields ride with it, effort as a hint", () => {
  expect(
    decode(
      {
        model: 'claude-opus-5-5',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'system',
            content: 'Only this turn.',
            clear_at: 'next_user_message',
          },
          { role: 'assistant', content: 'Hello' },
          { role: 'system', content: [], output_config: { effort: 'low' } },
        ],
      },
      new Headers(),
    ).request.messages,
  ).toEqual([
    { role: 'user', text: 'Hi' },
    {
      role: 'system',
      text: 'Only this turn.',
      provider: { anthropic: { clear_at: 'next_user_message' } },
    },
    { role: 'assistant', text: 'Hello' },
    {
      role: 'system',
      parts: [],
      hints: { anthropic: { output_config: { effort: 'low' } } },
    },
  ]);
});

test('each thinking setting decides whether the reply shows progress', async () => {
  async function* answered() {
    yield { type: 'progress', piece: 0, text: 'Routing' } as const;
    yield { type: 'text', text: 'Hi' } as const;
    yield { type: 'finish', reason: 'stop' } as const;
  }
  for (const [thinking, kinds] of [
    [undefined, ['text']],
    [{ type: 'adaptive', display: 'omitted' }, ['text']],
    [{ type: 'adaptive' }, ['thinking', 'text']],
  ] as const) {
    const decoded = decode(
      {
        model: 'coder',
        max_tokens: 64,
        ...(thinking === undefined ? {} : { thinking }),
        messages: [{ role: 'user', content: 'Hi' }],
      },
      new Headers(),
    );
    const sent = await Array.fromAsync(decoded.streamed(answered(), '1'));
    expect(
      sent
        .filter(({ event }) => event === 'content_block_start')
        .map(({ data }) => parsed(data)),
    ).toMatchObject(kinds.map((type) => ({ content_block: { type } })));
    expect(
      decoded.collected(
        [
          { type: 'progress', piece: 0, text: 'Routing' },
          { type: 'text', text: 'Hi' },
        ],
        { type: 'finish', reason: 'stop' },
        '1',
      ),
    ).toMatchObject({ content: kinds.map((type) => ({ type })) });
  }
});

test('a field named as the prototype is a field like any other, from the body to the upstream', () => {
  const { request } = decode(
    parsed(
      '{"model":"coder","max_tokens":1024,"__proto__":{"polluted":"yes"},"messages":[{"role":"user","__proto__":{"polluted":"yes"},"content":[{"__proto__":{"polluted":"yes"},"type":"text","text":"Hello"}]}]}',
    ) ?? null,
    new Headers(),
  );
  const [message] = request.messages;
  const [part] = message?.parts ?? [];
  for (const provider of [
    request.options.provider,
    message?.provider,
    part?.type === 'text' ? part.provider : undefined,
    structuredClone(request.options.provider),
  ]) {
    const { anthropic } = provider ?? {};
    expect(Object.keys(anthropic ?? {})).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(anthropic)).toBe(Object.prototype);
  }
  expect(JSON.stringify(request.options.provider)).toBe(
    '{"anthropic":{"__proto__":{"polluted":"yes"}}}',
  );
  expect(JSON.stringify(encode('claude-haiku-5-5', request).body)).toBe(
    '{"__proto__":{"polluted":"yes"},"max_tokens":1024,"model":"claude-haiku-5-5","messages":[{"role":"user","content":[{"__proto__":{"polluted":"yes"},"type":"text","text":"Hello"}],"__proto__":{"polluted":"yes"}}],"stream":true}',
  );
});
