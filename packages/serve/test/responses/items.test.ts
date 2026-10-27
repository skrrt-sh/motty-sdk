import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { inputOf } from '../../src/responses/items.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('a named message fails the call, with text or with parts', () => {
  expect(() =>
    inputOf(
      leaving('responses'),
      [{ role: 'user', text: 'Hi', name: 'ann' }],
      new Set(),
    ),
  ).toThrow('The Responses API cannot carry the name of who wrote a message');
  expect(() =>
    inputOf(
      leaving('responses'),
      [{ role: 'user', name: 'ann', parts: [{ type: 'text', text: 'Hi' }] }],
      new Set(),
    ),
  ).toThrow(Unsupported);
});

test('instructions that led the request go back in their own field', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'system',
          text: 'Be brief.',
          hints: { 'openai.responses': { instructions: true } },
        },
        { role: 'user', text: 'Hi' },
      ],
      new Set(),
    ),
  ).toEqual({
    instructions: 'Be brief.',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
  });
});

test('a mark of instructions on a later message is not read', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        { role: 'user', text: 'Hi' },
        {
          role: 'system',
          text: 'Be brief.',
          hints: { 'openai.responses': { instructions: true } },
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    { type: 'message', role: 'user', content: 'Hi' },
    { type: 'message', role: 'system', content: 'Be brief.' },
  ]);
});

test("the model's turn is written as the items it was made of", () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: 'Call the tool.',
              provider: {
                'openai.responses': {
                  type: 'reasoning',
                  id: 'rs_1',
                  summary: [{ type: 'summary_text', text: 'Call the tool.' }],
                  encrypted_content: 'gAAAAABo',
                },
              },
            },
            {
              type: 'text',
              text: 'Checking.',
              hints: {
                'openai.responses': { id: 'msg_1', phase: 'commentary' },
              },
            },
            {
              type: 'citation',
              url: 'https://x.test',
              title: 'Docs',
            },
            { type: 'refusal', text: 'Not that.' },
            {
              type: 'text',
              text: 'Done.',
              provider: { 'openai.responses': { phase: 'final_answer' } },
            },
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'weather',
              input: { city: 'Oslo' },
              hints: { 'openai.responses': { id: 'fc_1' } },
            },
            { type: 'tool_call', id: 'call_2', name: 'weather', raw: '{"ci' },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Call the tool.' }],
      encrypted_content: 'gAAAAABo',
    },
    {
      id: 'msg_1',
      phase: 'commentary',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'Checking.',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://x.test',
              title: 'Docs',
              start_index: 0,
              end_index: 0,
            },
          ],
        },
        { type: 'refusal', refusal: 'Not that.' },
      ],
    },
    {
      phase: 'final_answer',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
    },
    {
      id: 'fc_1',
      call_id: 'call_1',
      name: 'weather',
      type: 'function_call',
      arguments: '{"city":"Oslo"}',
    },
    {
      call_id: 'call_2',
      name: 'weather',
      type: 'function_call',
      arguments: '{"ci',
    },
  ]);
});

test('reasoning this API did not sign is left out and reported', () => {
  const left = leaving('responses');
  expect(
    inputOf(
      left,
      [
        {
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'Routing to the fast model.' },
            {
              type: 'reasoning',
              text: 'Routing to the fast model.',
              provider: {
                'openai.responses': {
                  type: 'reasoning',
                  id: 'rs_req_1_0',
                  summary: [
                    {
                      type: 'summary_text',
                      text: 'Routing to the fast model.',
                    },
                  ],
                },
              },
            },
            {
              type: 'reasoning',
              text: 'Routing to the fast model.',
              provider: {
                'openai.responses': {
                  type: 'reasoning',
                  id: 'rs_req_1_1',
                  summary: [],
                  encrypted_content: '',
                  signature: '',
                },
              },
            },
            {
              type: 'reasoning',
              text: 'Hm.',
              provider: { anthropic: { signature: 'EqQBCg==' } },
            },
            { type: 'text', text: 'Hello.' },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
    },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'reasoning',
      detail: 'The Responses API has no field for reasoning it did not sign',
    },
  ]);
});

test('a result is an item of its own, wherever its message put it', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'user',
          parts: [
            { type: 'tool_result', id: 'call_1', text: '4C', failed: true },
            { type: 'text', text: 'And tomorrow?' },
          ],
        },
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              id: 'call_2',
              parts: [
                { type: 'text', text: 'A chart' },
                { type: 'image', url: 'https://x.test/a.png' },
              ],
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    { type: 'function_call_output', call_id: 'call_1', output: '4C' },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'And tomorrow?' }],
    },
    {
      type: 'function_call_output',
      call_id: 'call_2',
      output: [
        { type: 'input_text', text: 'A chart' },
        { type: 'input_image', image_url: 'https://x.test/a.png' },
      ],
    },
  ]);
});

test('a call to a custom tool and its result are written as custom', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'call_1', name: 'patch', input: '*** A' },
            { type: 'tool_call', id: 'call_2', name: 'patch', raw: '*** B' },
          ],
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', id: 'call_1', text: 'Done' }],
        },
      ],
      new Set(['patch']),
    ).input,
  ).toEqual([
    {
      call_id: 'call_1',
      name: 'patch',
      type: 'custom_tool_call',
      input: '*** A',
    },
    {
      call_id: 'call_2',
      name: 'patch',
      type: 'custom_tool_call',
      input: '*** B',
    },
    { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' },
  ]);
});

test("the provider's own item is an item where the model speaks and content where the user does", () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'user',
          parts: [
            {
              type: 'provider',
              provider: {
                'openai.responses': { type: 'input_video', video_url: 'v' },
              },
            },
          ],
        },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Searching.' },
            {
              type: 'provider',
              provider: {
                'openai.responses': { type: 'web_search_call', id: 'ws_1' },
              },
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_video', video_url: 'v' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Searching.', annotations: [] }],
    },
    { type: 'web_search_call', id: 'ws_1' },
  ]);
});

test('what has no form on this wire fails the call', () => {
  const sent = (message: Parameters<typeof inputOf>[1][number]) => () =>
    inputOf(leaving('responses'), [message], new Set());
  expect(sent({ role: 'tool', text: 'orphan' })).toThrow(Unsupported);
  expect(
    sent({ role: 'tool', parts: [{ type: 'text', text: 'orphan' }] }),
  ).toThrow(Unsupported);
  expect(
    sent({ role: 'assistant', parts: [{ type: 'image', url: 'https://i' }] }),
  ).toThrow(Unsupported);
  expect(
    sent({
      role: 'assistant',
      parts: [
        {
          type: 'tool_call',
          id: 'srv_1',
          name: 'search',
          input: {},
          hosted: true,
        },
      ],
    }),
  ).toThrow(Unsupported);
  expect(
    sent({
      role: 'assistant',
      parts: [{ type: 'provider', provider: { anthropic: { type: 'x' } } }],
    }),
  ).toThrow(Unsupported);
  expect(
    sent({
      role: 'user',
      text: 'Hi',
      provider: { anthropic: { cache_control: {} } },
    }),
  ).toThrow(Unsupported);
});

test('a cache marker is a breakpoint on input content, of a part or of a message', () => {
  const marker = { prompt_cache_breakpoint: { mode: 'explicit' } };
  const left = leaving('responses', true);
  expect(
    inputOf(
      left,
      [
        { role: 'developer', text: 'A long manual', cache: {} },
        {
          role: 'user',
          cache: {},
          parts: [
            { type: 'text', text: 'One', cache: {} },
            { type: 'image', url: 'https://x.test/a.png' },
            { type: 'tool_result', id: 'call_1', text: '4C' },
          ],
        },
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              id: 'call_2',
              parts: [{ type: 'text', text: 'A chart', cache: {} }],
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: 'A long manual', ...marker }],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'One', ...marker },
        { type: 'input_image', image_url: 'https://x.test/a.png', ...marker },
      ],
    },
    { type: 'function_call_output', call_id: 'call_1', output: '4C' },
    {
      type: 'function_call_output',
      call_id: 'call_2',
      output: [{ type: 'input_text', text: 'A chart', ...marker }],
    },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('a cache marker with no input content to sit on is left out and reported', () => {
  const outside = {
    setting: 'cache.outside',
    detail:
      'The Responses API has no field for a cache marker outside input content',
  };
  const sent = (messages: Parameters<typeof inputOf>[1]) => {
    const left = leaving('responses');
    return { ...inputOf(left, messages, new Set()), leftOut: left.leftOut() };
  };
  expect(
    sent([
      {
        role: 'system',
        text: 'Be brief.',
        cache: {},
        hints: { 'openai.responses': { instructions: true } },
      },
    ]),
  ).toEqual({ instructions: 'Be brief.', input: [], leftOut: [outside] });
  expect(sent([{ role: 'assistant', text: 'Hello.', cache: {} }])).toEqual({
    input: [{ type: 'message', role: 'assistant', content: 'Hello.' }],
    leftOut: [outside],
  });
  expect(
    sent([
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello.', cache: {} }],
      },
    ]),
  ).toEqual({
    input: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
      },
    ],
    leftOut: [outside],
  });
  expect(
    sent([
      {
        role: 'tool',
        cache: {},
        parts: [{ type: 'tool_result', id: 'call_1', text: '4C' }],
      },
    ]),
  ).toEqual({
    input: [{ type: 'function_call_output', call_id: 'call_1', output: '4C' }],
    leftOut: [outside],
  });
  expect(
    sent([
      {
        role: 'tool',
        parts: [{ type: 'tool_result', id: 'call_1', text: '4C', cache: {} }],
      },
    ]),
  ).toEqual({
    input: [{ type: 'function_call_output', call_id: 'call_1', output: '4C' }],
    leftOut: [
      {
        setting: 'tool.cache',
        detail:
          'The Responses API has no field for a cache marker on a tool, a tool call or a tool result',
      },
    ],
  });
});

test('the hints of a message wait for its first message item', () => {
  const left = leaving('responses');
  expect(
    inputOf(
      left,
      [
        {
          role: 'user',
          hints: { 'openai.responses': { status: 'completed' } },
          parts: [
            { type: 'tool_result', id: 'call_1', text: '4C' },
            { type: 'text', text: 'And tomorrow?' },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    { type: 'function_call_output', call_id: 'call_1', output: '4C' },
    {
      status: 'completed',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'And tomorrow?' }],
    },
  ]);
  expect(left.leftOut()).toEqual([]);
});

test('the hints of a message that is only tool results are left out and reported', () => {
  const left = leaving('responses');
  expect(
    inputOf(
      left,
      [
        {
          role: 'tool',
          hints: { 'openai.responses': { status: 'completed' } },
          parts: [{ type: 'tool_result', id: 'call_1', text: '4C' }],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    { type: 'function_call_output', call_id: 'call_1', output: '4C' },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'message.hints',
      detail:
        'The Responses API has no field for the hints or provider data of a message sent as no message item',
    },
  ]);
});

test('what a message sent as instructions held beside the mark is left out and reported', () => {
  const left = leaving('responses');
  expect(
    inputOf(
      left,
      [
        {
          role: 'system',
          text: 'Be brief.',
          hints: { 'openai.responses': { instructions: true } },
          provider: { 'openai.responses': { vendor_note: 'lost' } },
        },
        { role: 'user', text: 'Hi' },
      ],
      new Set(),
    ),
  ).toEqual({
    instructions: 'Be brief.',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
  });
  expect(left.leftOut()).toEqual([
    {
      setting: 'message.hints',
      detail:
        'The Responses API has no field for the hints or provider data of a message sent as no message item',
    },
  ]);
});

test('the hints of a refusal the model wrote go on its content, and the item`s on the item', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'refusal',
              text: 'No.',
              hints: {
                'openai.responses': { id: 'msg_1', reason: 'policy' },
                anthropic: { x: 1 },
              },
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ reason: 'policy', type: 'refusal', refusal: 'No.' }],
    },
  ]);
});

test('a million calls in one message are each an item, not a stack too deep', () => {
  const { input } = inputOf(
    leaving('responses'),
    [
      {
        role: 'assistant',
        parts: Array.from({ length: 1_000_000 }, () => ({
          type: 'tool_call' as const,
          id: 'call_1',
          name: 'now',
          input: {},
        })),
      },
    ],
    new Set(),
  );

  expect(input).toHaveLength(1_000_000);
});

test('a call with free text and its result are written as custom where no tool was declared', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'call_1', name: 'exec', input: '1+1\n' },
            { type: 'tool_call', id: 'call_2', name: 'time', input: {} },
          ],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', id: 'call_1', text: '2' },
            { type: 'tool_result', id: 'call_2', text: 'noon' },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      call_id: 'call_1',
      name: 'exec',
      type: 'custom_tool_call',
      input: '1+1\n',
    },
    { call_id: 'call_2', name: 'time', type: 'function_call', arguments: '{}' },
    { type: 'custom_tool_call_output', call_id: 'call_1', output: '2' },
    { type: 'function_call_output', call_id: 'call_2', output: 'noon' },
  ]);
});

test('a tool call that holds only another API`s data is written as its own fields alone', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: 'call_1',
              name: 'time',
              input: {},
              provider: { anthropic: { caller: { type: 'direct' } } },
            },
            {
              type: 'tool_call',
              id: 'call_2',
              name: 'now',
              input: {},
              provider: {
                anthropic: { caller: { type: 'direct' } },
                'openai.responses': { namespace: 'time' },
              },
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    { call_id: 'call_1', name: 'time', type: 'function_call', arguments: '{}' },
    {
      namespace: 'time',
      call_id: 'call_2',
      name: 'now',
      type: 'function_call',
      arguments: '{}',
    },
  ]);
});

test('a tool result that holds only another API`s data still fails the call', () => {
  expect(() =>
    inputOf(
      leaving('responses'),
      [
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              id: 'call_1',
              text: 'noon',
              provider: { anthropic: { type: 'web_search_tool_result' } },
            },
          ],
        },
      ],
      new Set(),
    ),
  ).toThrow(
    new Unsupported(
      'The Responses API cannot carry a tool result of anthropic: type',
    ),
  );
});

test.each([
  [{}, { type: 'function_call', arguments: '{}' }],
  ['now', { type: 'custom_tool_call', input: 'now' }],
])(
  'what a call carries never stands in for a field the codec writes of it',
  (input, written) => {
    expect(
      inputOf(
        leaving('responses'),
        [
          {
            role: 'assistant',
            parts: [
              {
                type: 'tool_call',
                id: 'call_1',
                name: 'time',
                input,
                hints: { 'openai.responses': { input: 'evil', id: 'fc_1' } },
                provider: { 'openai.responses': { arguments: 'evil' } },
              },
            ],
          },
        ],
        new Set(),
      ).input,
    ).toEqual([{ id: 'fc_1', call_id: 'call_1', name: 'time', ...written }]);
  },
);
