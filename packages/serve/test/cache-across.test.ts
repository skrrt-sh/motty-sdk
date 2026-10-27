import { expect, test } from 'bun:test';
import { messages, responses } from '../src/index.ts';

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

  expect(request.messages.at(-1)?.cache).toEqual({});
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

  expect(marked.request.messages.at(-1)?.cache).toBeUndefined();
  expect(unkeyed.request.messages.at(-1)?.cache).toBeUndefined();
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
