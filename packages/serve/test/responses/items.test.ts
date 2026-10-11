import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { inputOf } from '../../src/responses/items.ts';
import { leaving } from '../../src/wire/fieldless.ts';
import { a } from '../../src/wire/refusals.ts';

test('a message of plain text is a message item with that text', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        { role: 'developer', text: 'Be brief.' },
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello.' },
      ],
      new Set(),
    ),
  ).toEqual({
    input: [
      { type: 'message', role: 'developer', content: 'Be brief.' },
      { type: 'message', role: 'user', content: 'Hi' },
      { type: 'message', role: 'assistant', content: 'Hello.' },
    ],
  });
});

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

test('a tool result marked as failed is sent as the result it holds', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', id: 'call_1', text: 'ENOENT', failed: true },
          ],
        },
      ],
      new Set(),
    ),
  ).toEqual({
    input: [
      { type: 'function_call_output', call_id: 'call_1', output: 'ENOENT' },
    ],
  });
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

test('a reasoning item a Claude model signed goes back as it came', () => {
  const item = {
    id: 'rs_tmp_z582ajgark',
    type: 'reasoning',
    status: 'completed',
    content: [
      {
        type: 'reasoning_text',
        text: "Paris sits further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
      },
    ],
    summary: [],
    signature:
      'CAQSpwUKEAgSGAI4AUIIdGhpbmtpbmcSDEesZn+NpEQfyIqQgRoMR9s1G5EATm7C7uzIIj',
    format: 'anthropic-claude-v1',
  };
  const left = leaving('responses');
  expect(
    inputOf(
      left,
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: "Paris sits further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
              provider: { 'openai.responses': item },
            },
            {
              type: 'tool_call',
              id: 'toolu_019o6fssKWToJo6JGRK6GkA6',
              name: 'get_weather',
              input: { city: 'Paris' },
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    item,
    {
      type: 'function_call',
      call_id: 'toolu_019o6fssKWToJo6JGRK6GkA6',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
  ]);
  expect(left.leftOut()).toEqual([]);
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

test('the lifetime of a cache marker on a message is left out and reported', () => {
  const left = leaving('responses', true);
  expect(
    inputOf(
      left,
      [{ role: 'user', text: 'A long manual', cache: { ttl: '1h' } }],
      new Set(),
    ).input,
  ).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'A long manual',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    },
  ]);
  expect(left.leftOut()).toEqual([
    {
      setting: 'cache.ttl',
      detail: 'The Responses API has no field for a lifetime on a cache marker',
    },
  ]);
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

test('audio fails the call, in a message or in a tool result', () => {
  expect(() =>
    inputOf(
      leaving('responses'),
      [
        {
          role: 'user',
          parts: [{ type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' }],
        },
      ],
      new Set(),
    ),
  ).toThrow('The Responses API cannot carry audio');
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
              parts: [{ type: 'audio', url: 'https://x.test/a.wav' }],
            },
          ],
        },
      ],
      new Set(),
    ),
  ).toThrow(Unsupported);
});

test('a tool another upstream ran, and what it returned, fail the call', () => {
  const called = () =>
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            {
              type: 'tool_call',
              id: 'srvtoolu_1',
              name: 'web_search',
              input: {},
              hosted: true,
            },
          ],
        },
      ],
      new Set(),
    );
  expect(called).toThrow(Unsupported);
  expect(called).toThrow(
    'The Responses API cannot carry a call or a result of a tool another upstream ran',
  );
  const answered = () =>
    inputOf(
      leaving('responses'),
      [
        {
          role: 'assistant',
          parts: [
            { type: 'tool_result', id: 'srvtoolu_1', text: 'R', hosted: true },
          ],
        },
      ],
      new Set(),
    );
  expect(answered).toThrow(Unsupported);
  expect(answered).toThrow(
    'The Responses API cannot carry a call or a result of a tool another upstream ran',
  );
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

test('provider data of a message goes on its message item, and with none is left out and reported', () => {
  const left = leaving('responses');
  expect(
    inputOf(
      left,
      [
        {
          role: 'user',
          provider: { 'openai.responses': { vendor_note: 'kept' } },
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
      vendor_note: 'kept',
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'And tomorrow?' }],
    },
  ]);
  expect(left.leftOut()).toEqual([]);

  expect(
    inputOf(
      left,
      [
        {
          role: 'tool',
          provider: { 'openai.responses': { vendor_note: 'lost' } },
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

test('a tool answers with text, an image and a file, each as input content', () => {
  expect(
    inputOf(
      leaving('responses'),
      [
        {
          role: 'tool',
          parts: [
            {
              type: 'tool_result',
              id: 'call_1',
              parts: [
                { type: 'text', text: 'The chart:' },
                { type: 'image', data: 'iVBORw0=', mediaType: 'image/png' },
                { type: 'image', id: 'file-1' },
                { type: 'file', url: 'https://x.test/a.pdf', name: 'a.pdf' },
              ],
            },
          ],
        },
      ],
      new Set(),
    ).input,
  ).toEqual([
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'The chart:' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0=' },
        { type: 'input_image', file_id: 'file-1' },
        {
          type: 'input_file',
          filename: 'a.pdf',
          file_url: 'https://x.test/a.pdf',
        },
      ],
    },
  ]);
});

test.each([
  ['system', { type: 'image', url: 'https://x.test/cat.png' }],
  ['developer', { type: 'file', id: 'file-1' }],
] as const)('a %s message may hold $type as input content', (role, part) => {
  expect(
    inputOf(leaving('responses'), [{ role, parts: [part] }], new Set()).input,
  ).toMatchObject([{ type: 'message', role, content: [{}] }]);
});

test.each([
  { type: 'image', data: 'iVBORw0=', mediaType: 'image/png' },
  { type: 'file', id: 'file-1' },
] as const)('$type the model wrote has no item and fails the call', (part) => {
  const sent = () =>
    inputOf(
      leaving('responses'),
      [{ role: 'assistant', parts: [part] }],
      new Set(),
    );
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(
    `The Responses API cannot carry ${a(part.type)} part the model wrote`,
  );
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
