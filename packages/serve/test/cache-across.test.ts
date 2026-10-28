import { expect, test } from 'bun:test';
import {
  chatCompletions,
  chatCompletionsIn,
  messages,
  responses,
  responsesIn,
} from '../src/index.ts';

const turn = [
  { type: 'message', role: 'user', content: 'List the files.' },
  {
    type: 'function_call',
    call_id: 'call_1',
    name: 'shell',
    arguments: '{"cmd":"ls"}',
  },
  { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
];

test('a Responses caller that keys its cache asks for a marker on the last message, which an Anthropic upstream is sent', () => {
  const { request } = responses.decode(
    { model: 'relay', input: turn, prompt_cache_key: 'session-1' },
    new Headers(),
  );

  expect(messages.encode('model-x', request).body).toMatchObject({
    messages: [
      { role: 'user' },
      { role: 'assistant' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
});

test('a caller that marks its cache itself, or keys none, is given no marker', () => {
  const marked = responses.decode(
    {
      model: 'relay',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Long rules.',
              prompt_cache_breakpoint: { mode: 'explicit' },
            },
          ],
        },
        ...turn,
      ],
      prompt_cache_key: 'session-1',
    },
    new Headers(),
  );
  const unkeyed = responses.decode(
    { model: 'relay', input: turn },
    new Headers(),
  );

  const { body } = messages.encode('model-x', marked.request);

  expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(1);
  expect(body).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Long rules.',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'user' },
      { role: 'assistant' },
      { role: 'user' },
    ],
  });
  expect(
    JSON.stringify(messages.encode('model-x', unkeyed.request).body),
  ).not.toContain('cache_control');
});

test('to a Responses upstream the key is sent and the marker it stands for is not reported left out', () => {
  const { request } = responses.decode(
    { model: 'relay', input: turn, prompt_cache_key: 'session-1' },
    new Headers(),
  );

  const { body, leftOut } = responses.encode('model-x', request);

  expect(body).toMatchObject({ prompt_cache_key: 'session-1' });
  expect(leftOut).toEqual([]);
});

test('to a Responses upstream a key does not stand for the lifetime a marker asked', () => {
  const { request } = responses.decode(
    { model: 'relay', input: turn, prompt_cache_key: 'session-1' },
    new Headers(),
  );

  const { leftOut } = responses.encode('model-x', {
    ...request,
    messages: [
      { role: 'user', text: 'Long rules.', cache: { ttl: '1h' } },
      ...request.messages,
    ],
  });

  expect(leftOut.map(({ setting }) => setting)).toEqual(['cache.ttl']);
});

test('to an upstream that takes no marker the key changes nothing', () => {
  for (const input of ['Fix it.', turn]) {
    const keyed = responses.decode(
      { model: 'relay', input, prompt_cache_key: 'session-1' },
      new Headers(),
    );
    const unkeyed = responses.decode({ model: 'relay', input }, new Headers());

    const { body, leftOut } = chatCompletions.encode('model-x', keyed.request);

    expect(body).toEqual(
      chatCompletions.encode('model-x', unkeyed.request).body,
    );
    expect(leftOut).toEqual([]);
  }
});

test.each([
  ['cache_control', { cache_control: { type: 'ephemeral' } }],
  [true, { prompt_cache_breakpoint: { mode: 'explicit' } }],
] as const)(
  'to a chat upstream that takes %p markers, the key`s marker sits on the closing tool message',
  (breakpoints, marker) => {
    const { request } = responses.decode(
      { model: 'relay', input: turn, prompt_cache_key: 'session-1' },
      new Headers(),
    );

    const { body, leftOut } = chatCompletionsIn({
      name: 'router',
      breakpoints,
    }).encode('model-x', request);

    expect(body).toMatchObject({
      messages: [
        { role: 'user' },
        { role: 'assistant' },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'text', text: 'a.txt', ...marker }],
        },
      ],
    });
    expect(leftOut).toEqual([]);
  },
);

test('to a Responses upstream that takes markers, the key`s marker sits on the closing tool output', () => {
  const { request } = responses.decode(
    { model: 'relay', input: turn, prompt_cache_key: 'session-1' },
    new Headers(),
  );

  const { body, leftOut } = responsesIn({ breakpoints: true }).encode(
    'model-x',
    request,
  );

  expect(body).toMatchObject({
    input: [
      { type: 'message' },
      { type: 'function_call' },
      {
        type: 'function_call_output',
        output: [
          {
            type: 'input_text',
            text: 'a.txt',
            prompt_cache_breakpoint: { mode: 'explicit' },
          },
        ],
      },
    ],
  });
  expect(leftOut).toEqual([]);
});
