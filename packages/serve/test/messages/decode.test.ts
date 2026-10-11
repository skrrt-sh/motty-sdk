import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { decode } from '../../src/messages/decode.ts';
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

test('system as blocks keeps each block and its cache marker', () => {
  const { request } = decode(
    {
      model: 'coder',
      max_tokens: 64,
      system: [
        { type: 'text', text: 'You are terse.' },
        {
          type: 'text',
          text: '<the whole style guide>',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'Hi' }],
    },
    new Headers(),
  );
  expect(request.messages[0]).toEqual({
    role: 'system',
    parts: [
      { type: 'text', text: 'You are terse.' },
      { type: 'text', text: '<the whole style guide>', cache: {} },
    ],
  });
});

test('a system turn inside the conversation stays where it is', () => {
  const { request } = decode(
    {
      model: 'coder',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'system', content: 'Terse mode enabled.' },
      ],
    },
    new Headers(),
  );
  expect(request.messages[1]).toEqual({
    role: 'system',
    text: 'Terse mode enabled.',
  });
});

test('tools, the tool choice, the output and streaming are decoded', () => {
  const decoded = decode(
    {
      model: 'coder',
      max_tokens: 64,
      stream: true,
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      output_config: {
        format: { type: 'json_schema', schema: { type: 'object' } },
      },
      messages: [{ role: 'user', content: 'Weather in Paris?' }],
    },
    new Headers(),
  );
  expect(decoded.stream).toBe(true);
  expect(decoded.request.tools).toEqual([
    { type: 'function', name: 'get_weather', input: { type: 'object' } },
  ]);
  expect(decoded.request.options).toEqual({
    maxTokens: 64,
    toolChoice: { tool: 'get_weather' },
  });
  expect(decoded.request.output).toEqual({
    schema: { type: 'object' },
    strict: true,
  });
});

test('a body that is not a valid request is rejected', () => {
  const none = new Headers();
  const turn = { role: 'user', content: 'Hi' };
  for (const body of [
    'model=coder',
    [],
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

test('the reply shows progress only to a caller who asked for thinking', async () => {
  const turn = { role: 'user', content: 'Hi' };
  const asked = decode(
    {
      model: 'coder',
      max_tokens: 64,
      thinking: { type: 'adaptive', display: 'summarized' },
      messages: [turn],
    },
    new Headers(),
  );
  const muted = decode(
    {
      model: 'coder',
      max_tokens: 64,
      thinking: { type: 'adaptive', display: 'omitted' },
      messages: [turn],
    },
    new Headers(),
  );
  const silent = decode(
    { model: 'coder', max_tokens: 64, messages: [turn] },
    new Headers(),
  );
  const finish = { type: 'finish', reason: 'stop' } as const;
  const progress = { type: 'progress', piece: 0, text: 'Routing' } as const;
  const text = { type: 'text', text: 'Hi' } as const;
  expect(asked.collected([progress, text], finish, '1')).toMatchObject({
    id: 'msg_1',
    model: 'coder',
    content: [
      { type: 'thinking', thinking: 'Routing', signature: '' },
      { type: 'text', text: 'Hi' },
    ],
  });
  for (const decoded of [muted, silent]) {
    expect(decoded.collected([progress, text], finish, '1')).toMatchObject({
      content: [{ type: 'text', text: 'Hi' }],
    });
  }
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
    [{ type: 'disabled' }, ['text']],
    [{ type: 'adaptive', display: 'omitted' }, ['text']],
    [{ type: 'enabled', budget_tokens: 2048, display: 'omitted' }, ['text']],
    [{ type: 'adaptive' }, ['thinking', 'text']],
    [{ type: 'adaptive', display: 'summarized' }, ['thinking', 'text']],
    [{ type: 'enabled', budget_tokens: 2048 }, ['thinking', 'text']],
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
