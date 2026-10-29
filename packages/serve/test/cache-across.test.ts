import { expect, test } from 'bun:test';
import {
  chatCompletions,
  chatCompletionsIn,
  messages,
  responses,
  responsesIn,
} from '../src/index.ts';
import { dict } from '../src/wire/json.ts';

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

test('a Responses caller that keys its cache asks for a marker on the last message, which an Anthropic upstream is sent in place of the key', () => {
  const { request } = responses.decode(
    { model: 'relay', input: turn, prompt_cache_key: 'session-1' },
    new Headers(),
  );

  const { body, leftOut } = messages.encode('model-x', request);

  expect(JSON.stringify(body)).not.toContain('session-1');
  expect(leftOut).toEqual([]);
  expect(body).toMatchObject({
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

test('to a Chat Completions upstream that takes no marker the key is sent and its marker is not', () => {
  for (const input of ['Fix it.', turn]) {
    const keyed = responses.decode(
      { model: 'relay', input, prompt_cache_key: 'session-1' },
      new Headers(),
    );
    const unkeyed = responses.decode({ model: 'relay', input }, new Headers());

    const { body, leftOut } = chatCompletions.encode('model-x', keyed.request);

    expect(body).toEqual({
      ...dict(chatCompletions.encode('model-x', unkeyed.request).body),
      prompt_cache_key: 'session-1',
    });
    expect(leftOut).toEqual([]);
  }
});

test('a Chat Completions caller`s key reaches a Responses upstream and a Chat Completions one alike', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'relay',
      messages: [{ role: 'user', content: 'Fix it.' }],
      prompt_cache_key: 'session-1',
    },
    new Headers(),
  );

  expect(responses.encode('model-x', request).body).toMatchObject({
    prompt_cache_key: 'session-1',
  });
  expect(chatCompletions.encode('model-x', request).body).toMatchObject({
    prompt_cache_key: 'session-1',
  });
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
      prompt_cache_key: 'session-1',
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

test('to a Chat Completions upstream with no field for the key it is sent as said, and the upstream`s refusal is its own', () => {
  const { request } = responses.decode(
    { model: 'relay', input: 'Fix it.', prompt_cache_key: 'session-1' },
    new Headers(),
  );

  const { body, leftOut } = chatCompletionsIn({
    name: 'groq',
    tagged: true,
  }).encode('model-x', request);

  expect(body).toMatchObject({ prompt_cache_key: 'session-1' });
  expect(leftOut).toEqual([]);
});

test('a Chat Completions caller that keys its cache asks for a marker on the last message, which an Anthropic upstream is sent in place of the key', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'relay',
      messages: [
        { role: 'system', content: 'Long rules.' },
        { role: 'user', content: 'Fix it.' },
      ],
      prompt_cache_key: 'session-1',
    },
    new Headers(),
  );

  const { body, leftOut } = messages.encode('model-x', request);

  expect(JSON.stringify(body)).not.toContain('session-1');
  expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(1);
  expect(leftOut).toEqual([]);
  expect(body).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Fix it.',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
});

test('a Chat Completions caller`s key alone puts a marker on the last part sent to a router that takes cache_control', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'relay',
      messages: [{ role: 'user', content: 'Fix it.' }],
      prompt_cache_key: 'session-1',
    },
    new Headers(),
  );

  const { body, leftOut } = chatCompletionsIn({
    name: 'router',
    breakpoints: 'cache_control',
  }).encode('anthropic/model-x', request);

  expect(body).toMatchObject({
    prompt_cache_key: 'session-1',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Fix it.',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
  expect(leftOut).toEqual([]);
});

test('a Chat Completions caller that marks its cache itself and keys it is given no marker beside its own', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'relay',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'Long rules.',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'Fix it.' },
      ],
      prompt_cache_key: 'session-1',
    },
    new Headers(),
  );

  const { body } = messages.encode('model-x', request);

  expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(1);
  expect(body).toMatchObject({
    system: [{ text: 'Long rules.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Fix it.' }],
  });
});

test('to an upstream that takes no marker, the one a Chat Completions caller`s key implied is neither written nor reported', () => {
  const keyed = chatCompletions.decode(
    {
      model: 'relay',
      messages: [{ role: 'user', content: 'Fix it.' }],
      prompt_cache_key: 'session-1',
    },
    new Headers(),
  );
  const unkeyed = chatCompletions.decode(
    { model: 'relay', messages: [{ role: 'user', content: 'Fix it.' }] },
    new Headers(),
  );

  const chat = chatCompletions.encode('model-x', keyed.request);
  const answered = responses.encode('model-x', keyed.request);

  expect(chat.body).toEqual({
    ...dict(chatCompletions.encode('model-x', unkeyed.request).body),
    prompt_cache_key: 'session-1',
  });
  expect(answered.body).toEqual({
    ...dict(responses.encode('model-x', unkeyed.request).body),
    prompt_cache_key: 'session-1',
  });
  expect(chat.leftOut).toEqual([]);
  expect(answered.leftOut).toEqual([]);
});
