import { expect, test } from 'bun:test';
import { joined, plain } from '../../src/chat-completions/dialect.ts';
import { encode } from '../../src/chat-completions/encode.ts';
import { events } from '../../src/chat-completions/events.ts';
import {
  reasonRead,
  reasonWritten,
} from '../../src/chat-completions/finish.ts';
import { stopOf } from '../../src/messages/finish.ts';

async function* sent(...frames: string[]) {
  for (const data of frames) yield { data };
}

test('fragments of one detail are joined: its text grows and its signature is said once', () => {
  expect(
    joined([
      {
        type: 'reasoning.text',
        text: 'Pa',
        format: 'anthropic-claude-v1',
        index: 0,
      },
      {
        type: 'reasoning.text',
        text: 'ris',
        signature: null,
        format: 'anthropic-claude-v1',
        index: 0,
      },
      {
        type: 'reasoning.text',
        signature: 'EqQB',
        format: 'anthropic-claude-v1',
        index: 0,
      },
      { type: 'reasoning.encrypted', data: 'gAAA', id: 'rs_1', index: 1 },
    ]),
  ).toEqual([
    {
      type: 'reasoning.text',
      text: 'Paris',
      signature: 'EqQB',
      format: 'anthropic-claude-v1',
      index: 0,
    },
    { type: 'reasoning.encrypted', data: 'gAAA', id: 'rs_1', index: 1 },
  ]);
});

test('details with no index stay apart, and what is no detail is not kept', () => {
  expect(
    joined([
      { type: 'reasoning.text', text: 'One' },
      'noise',
      { type: 'reasoning.text', text: 'Two' },
    ]),
  ).toEqual([
    { type: 'reasoning.text', text: 'One' },
    { type: 'reasoning.text', text: 'Two' },
  ]);
});

test('details that were already whole are sent as they are', () => {
  expect(
    joined([
      { type: 'reasoning.text', text: 'Paris', signature: 'EqQB', index: 0 },
    ]),
  ).toEqual([
    { type: 'reasoning.text', text: 'Paris', signature: 'EqQB', index: 0 },
  ]);
});

test('an effort, a budget and a mute go in one object where the dialect has it', () => {
  const sent = (reasoning: {
    effort?: 'none' | 'high';
    budgetTokens?: number;
    exclude?: boolean;
  }) =>
    encode(
      'vendor/model-x',
      { messages: [], options: { reasoning } },
      { name: 'router', asks: 'reasoning' },
    );

  expect(sent({ effort: 'high' })).toMatchObject({
    body: { reasoning: { effort: 'high' } },
    leftOut: [],
  });
  expect(sent({ effort: 'none' }).body).toMatchObject({
    reasoning: { effort: 'none' },
  });
  expect(sent({ budgetTokens: 1024, exclude: true })).toMatchObject({
    body: { reasoning: { max_tokens: 1024, exclude: true } },
    leftOut: [],
  });
  expect(sent({ exclude: false }).body).toMatchObject({
    reasoning: { exclude: false },
  });
  expect(sent({ effort: 'high' }).body).not.toHaveProperty('reasoning_effort');
  expect(
    encode(
      'vendor/model-x',
      { messages: [] },
      { name: 'router', asks: 'reasoning' },
    ).body,
  ).not.toHaveProperty('reasoning');
});

test('the object takes an effort or a budget, so beside an effort the budget is left out and reported', () => {
  const { body, leftOut } = encode(
    'vendor/model-x',
    {
      messages: [],
      options: { reasoning: { effort: 'low', budgetTokens: 2000 } },
    },
    { name: 'router', asks: 'reasoning' },
  );

  expect(body).toMatchObject({ reasoning: { effort: 'low' } });
  expect(JSON.stringify(body)).not.toContain('2000');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.budgetTokens',
      detail: 'Chat Completions has no field for a reasoning budget in tokens',
    },
  ]);
});

test('a switch is turned on by a budget, whose amount is left out and reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: { reasoning: { budgetTokens: 2000, exclude: true } },
    },
    { name: 'switched', asks: 'thinking' },
  );

  expect(body).toMatchObject({ thinking: { type: 'enabled' } });
  expect(JSON.stringify(body)).not.toContain('2000');
  expect(body).not.toHaveProperty('reasoning');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.budgetTokens',
      detail: 'Chat Completions has no field for a reasoning budget in tokens',
    },
    {
      setting: 'reasoning.exclude',
      detail:
        'Chat Completions has no field for an order to keep reasoning out of the reply',
    },
  ]);
});

test('beside a switch an effort goes under the API`s own name, and the switch is left as the upstream has it', () => {
  const { body } = encode(
    'model-x',
    {
      messages: [],
      options: { reasoning: { effort: 'max', budgetTokens: 2000 } },
    },
    { name: 'switched', asks: 'thinking' },
  );

  expect(body).toMatchObject({ reasoning_effort: 'max' });
  expect(body).not.toHaveProperty('thinking');
});

test('an order not to reason turns a thinking switch off, and is no effort', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'switched', asks: 'thinking' },
  );

  expect(body).toMatchObject({ thinking: { type: 'disabled' } });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut).toEqual([]);
});

test('the output limit goes under the name the dialect gives it', () => {
  const { body } = encode(
    'model-x',
    { messages: [], options: { maxTokens: 256 } },
    { name: 'older', limit: 'max_tokens' },
  );

  expect(body).toMatchObject({ max_tokens: 256 });
  expect(body).not.toHaveProperty('max_completion_tokens');
});

test('reasoning text goes back on the assistant turn in the field the dialect names', () => {
  const turn = (thought: 'reasoning' | 'reasoning_content') =>
    encode(
      'model-x',
      {
        messages: [
          { role: 'user', text: 'Weather in Paris?' },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'I need ' },
              { type: 'reasoning', text: 'the tool.' },
              {
                type: 'tool_call',
                id: 'call_1',
                name: 'weather',
                input: { city: 'Paris' },
              },
            ],
          },
          {
            role: 'tool',
            parts: [{ type: 'tool_result', id: 'call_1', text: 'Sunny' }],
          },
        ],
      },
      { name: 'thinker', thought },
    );

  expect(turn('reasoning_content')).toMatchObject({
    body: {
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1' }],
          reasoning_content: 'I need the tool.',
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
      ],
    },
    leftOut: [],
  });
  expect(turn('reasoning').body).toMatchObject({
    messages: [{}, { reasoning: 'I need the tool.' }, {}],
  });
});

test('details go back joined and alone, since they hold the text they sign', () => {
  const { body, leftOut } = encode(
    'vendor/model-x',
    {
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: 'Paris is north.',
              provider: {
                'openai.chat': {
                  reasoning_details: [
                    { type: 'reasoning.text', text: 'Paris ', index: 0 },
                    { type: 'reasoning.text', text: 'is north.', index: 0 },
                    { type: 'reasoning.text', signature: 'EqQB', index: 0 },
                  ],
                },
              },
            },
            { type: 'text', text: 'Paris' },
          ],
        },
      ],
    },
    { name: 'router', thought: 'reasoning', details: true },
  );

  expect(body).toMatchObject({
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Paris' }],
        reasoning_details: [
          {
            type: 'reasoning.text',
            text: 'Paris is north.',
            signature: 'EqQB',
            index: 0,
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain('"reasoning":');
  expect(leftOut).toEqual([]);
});

test('what another API signed has no field: the text goes back and the rest is reported', () => {
  const { body, leftOut } = encode(
    'vendor/model-x',
    {
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: 'Paris is north.',
              provider: { anthropic: { signature: 'EqQB' } },
            },
            { type: 'text', text: 'Paris' },
          ],
        },
      ],
    },
    { name: 'router', thought: 'reasoning', details: true },
  );

  expect(body).toMatchObject({
    messages: [{ role: 'assistant', reasoning: 'Paris is north.' }],
  });
  expect(JSON.stringify(body)).not.toContain('EqQB');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning',
      detail: 'Chat Completions has no field for reasoning it did not sign',
    },
  ]);
});

test('details reach a dialect with no field for them as their text, and are reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'reasoning',
              text: 'Paris is north.',
              provider: {
                'openai.chat': {
                  reasoning_details: [
                    { type: 'reasoning.text', signature: 'EqQB', index: 0 },
                  ],
                },
              },
            },
            { type: 'text', text: 'Paris' },
          ],
        },
      ],
    },
    { name: 'thinker', thought: 'reasoning_content' },
  );

  expect(body).toMatchObject({
    messages: [{ role: 'assistant', reasoning_content: 'Paris is north.' }],
  });
  expect(JSON.stringify(body)).not.toContain('EqQB');
  expect(leftOut).toMatchObject([{ setting: 'reasoning' }]);
});

test('reasoning on a turn that is not the assistant`s has no field in any dialect', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'reasoning', text: 'Hm' },
            { type: 'text', text: 'Hi' },
          ],
        },
      ],
    },
    { name: 'thinker', thought: 'reasoning_content' },
  );

  expect(body).toMatchObject({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  expect(JSON.stringify(body)).not.toContain('Hm');
  expect(leftOut).toMatchObject([{ setting: 'reasoning' }]);
});

test('OpenAI`s own dialect sends no reasoning back and reads no details', async () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [
      {
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'Paris is north.',
            provider: {
              'openai.chat': {
                reasoning_details: [{ type: 'reasoning.text', index: 0 }],
              },
            },
          },
          { type: 'text', text: 'Paris' },
        ],
      },
    ],
    options: { reasoning: { effort: 'low', budgetTokens: 2000 } },
  });

  expect(body).toEqual({
    reasoning_effort: 'low',
    model: 'gpt-x',
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: 'Paris' }] },
    ],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.budgetTokens',
      detail: 'Chat Completions has no field for a reasoning budget in tokens',
    },
    {
      setting: 'reasoning',
      detail: 'Chat Completions has no field for reasoning it did not sign',
    },
  ]);
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"reasoning":"Hm","reasoning_details":[{"type":"reasoning.text","text":"Hm","index":0}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.text","signature":"EqQB","index":0}]},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'Hm' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a dialect with details reads them on the reasoning they came with, and alone when no text came', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning":"Pa","reasoning_details":[{"type":"reasoning.text","text":"Pa","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"content":"","role":"assistant","reasoning_details":[{"type":"reasoning.text","signature":"EqQB","format":"anthropic-claude-v1","index":0}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"content":"Paris","role":"assistant","reasoning":null},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'router', details: true },
      ),
    ),
  ).toEqual([
    {
      type: 'reasoning',
      text: 'Pa',
      provider: {
        'openai.chat': {
          reasoning_details: [
            {
              type: 'reasoning.text',
              text: 'Pa',
              format: 'anthropic-claude-v1',
              index: 0,
            },
          ],
        },
      },
    },
    {
      type: 'reasoning',
      text: '',
      provider: {
        'openai.chat': {
          reasoning_details: [
            {
              type: 'reasoning.text',
              signature: 'EqQB',
              format: 'anthropic-claude-v1',
              index: 0,
            },
          ],
        },
      },
    },
    { type: 'text', text: 'Paris' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('reasoning is read from either name, whatever the dialect', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"reasoning_content":"One"},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"reasoning":" two"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'thinker', thought: 'reasoning_content' },
      ),
    ),
  ).toMatchObject([
    { type: 'reasoning', text: 'One' },
    { type: 'reasoning', text: ' two' },
    { type: 'finish' },
  ]);
});

test('a failure in the stream is recorded under the dialect`s name', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent('{"error":{"message":"No capacity","code":"server_error"}}'),
        { name: 'router' },
      ),
    ),
  ).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        provider: { router: { code: 'server_error' } },
      },
    },
  ]);
});

test('a dialect with pictures reads each as a file, with what its entry held; OpenAI`s own reads none', async () => {
  const frames = [
    '{"choices":[{"index":0,"delta":{"role":"assistant","content":"Here.","images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0="},"index":0},{"image_url":{"url":"https://x.test/made.png"}}]},"finish_reason":null}]}',
    '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '[DONE]',
  ];
  expect(
    await Array.fromAsync(
      events(sent(...frames), { name: 'router', images: true }),
    ),
  ).toEqual([
    { type: 'text', text: 'Here.' },
    {
      type: 'file',
      data: 'iVBORw0=',
      mediaType: 'image/png',
      provider: { 'openai.chat': { type: 'image_url', index: 0 } },
    },
    {
      type: 'file',
      url: 'https://x.test/made.png',
      provider: { 'openai.chat': { type: 'image_url' } },
    },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
  expect(await Array.fromAsync(events(sent(...frames)))).toEqual([
    { type: 'text', text: 'Here.' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a dialect with a native reason tells a stop sequence apart, and each reply writes its own form', async () => {
  const frames = [
    '{"id":"gen-1","model":"anthropic/claude-haiku-5.5","provider":"Claude Platform on AWS","choices":[{"index":0,"delta":{"content":"alpha beta ","role":"assistant"},"finish_reason":null,"native_finish_reason":null}]}',
    '{"id":"gen-1","model":"anthropic/claude-haiku-5.5","provider":"Claude Platform on AWS","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"stop","native_finish_reason":"stop_sequence"}]}',
    '[DONE]',
  ];
  const finish = (
    await Array.fromAsync(
      events(sent(...frames), { name: 'router', native: true }),
    )
  ).at(-1);

  expect(finish).toEqual({
    type: 'finish',
    reason: 'stop',
    rawReason: 'stop_sequence',
    id: 'gen-1',
    model: 'anthropic/claude-haiku-5.5',
  });
  if (finish?.type !== 'finish') throw new Error('The stream did not finish');
  expect(stopOf(finish)).toBe('stop_sequence');
  expect(reasonWritten(finish.reason)).toBe('stop');
  expect((await Array.fromAsync(events(sent(...frames)))).at(-1)).toEqual({
    type: 'finish',
    reason: 'stop',
    rawReason: 'stop',
    id: 'gen-1',
    model: 'anthropic/claude-haiku-5.5',
  });
});

test('a native reason that tells nothing apart changes nothing', async () => {
  for (const [reason, native] of [
    ['stop', 'stop'],
    ['stop', 'STOP'],
    ['length', 'stop_sequence'],
  ] as const) {
    expect(
      await Array.fromAsync(
        events(
          sent(
            `{"choices":[{"index":0,"delta":{"content":""},"finish_reason":"${reason}","native_finish_reason":"${native}"}]}`,
            '[DONE]',
          ),
          { name: 'router', native: true },
        ),
      ),
    ).toEqual([
      { type: 'finish', reason: reasonRead(reason), rawReason: reason },
    ]);
  }
});

test('a dialect`s own endings and its cached tokens at the top of usage are read from a stream, and the plain dialect reads neither', async () => {
  const stream = [
    '{"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"eos"}],"usage":{"prompt_tokens":9,"completion_tokens":1,"cached_tokens":4}}',
    '[DONE]',
  ];

  expect(
    await Array.fromAsync(
      events(sent(...stream), {
        name: 'own',
        endings: { eos: 'stop' },
        flat: true,
      }),
    ),
  ).toEqual([
    { type: 'text', text: 'hi' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'eos',
      usage: { input: 9, output: 1, cached: 4 },
    },
  ]);
  expect(await Array.fromAsync(events(sent(...stream), plain))).toEqual([
    { type: 'text', text: 'hi' },
    {
      type: 'finish',
      reason: 'other',
      rawReason: 'eos',
      usage: { input: 9, output: 1 },
    },
  ]);
});

test('a stated effort goes beside a thinking type, where the dialect has the levels', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'high' } } },
    { name: 'switched', asks: 'thinking', efforts: ['low', 'high', 'max'] },
  );

  expect(body).toMatchObject({ reasoning_effort: 'high' });
  expect(body).not.toHaveProperty('thinking');
  expect(leftOut).toEqual([]);
});

test('an effort turns a thinking type on where the dialect has no level, and the level is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'high' } } },
    { name: 'switched', asks: 'thinking', efforts: [] },
  );

  expect(body).toMatchObject({ thinking: { type: 'enabled' } });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.effort',
      detail: 'Chat Completions has no field for a level of reasoning effort',
    },
  ]);
});

test('an order not to reason turns a thinking type off where the dialect has no level', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'switched', asks: 'thinking', efforts: [] },
  );

  expect(body).toMatchObject({ thinking: { type: 'disabled' } });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut).toEqual([]);
});

test('an order not to reason sets the thinking flag to false', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toMatchObject({ enable_thinking: false });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(body).not.toHaveProperty('thinking_budget');
  expect(leftOut).toEqual([]);
});

test('a budget sets the thinking flag and goes beside it', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { budgetTokens: 2000 } } },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 2000 });
  expect(leftOut).toEqual([]);
});

test('an effort alone sets the thinking flag, and its level is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'low' } } },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toMatchObject({ enable_thinking: true });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(body).not.toHaveProperty('thinking_budget');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.effort',
      detail: 'Chat Completions has no field for a level of reasoning effort',
    },
  ]);
});

test('an effort and a budget set the thinking flag with the budget, and the level is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: { reasoning: { effort: 'low', budgetTokens: 2000 } },
    },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toMatchObject({ enable_thinking: true, thinking_budget: 2000 });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.effort']);
});

test('a budget beside an order not to reason is left out and reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: { reasoning: { effort: 'none', budgetTokens: 2000 } },
    },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toMatchObject({ enable_thinking: false });
  expect(body).not.toHaveProperty('thinking_budget');
  expect(leftOut.map(({ setting }) => setting)).toEqual([
    'reasoning.budgetTokens',
  ]);
});

test('an order not to reason is the effort itself where the upstream takes that level and has no switch', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'levelled', efforts: ['none', 'low', 'medium', 'high'] },
  );

  expect(body).toMatchObject({ reasoning_effort: 'none' });
  expect(leftOut).toEqual([]);
});

test('an order not to reason is left out and reported where the upstream has neither a switch nor that level', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'levelled', efforts: ['low', 'high'] },
  );

  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.off',
      detail: 'Chat Completions has no field for an order not to reason',
    },
  ]);
});

test('an order not to reason sets the template argument to false', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'templated', asks: 'chat_template_kwargs' },
  );

  expect(body).toMatchObject({
    chat_template_kwargs: { enable_thinking: false },
  });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut).toEqual([]);
});

test('a budget sets the template argument to true, and its amount is left out and reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { budgetTokens: 2000 } } },
    { name: 'templated', asks: 'chat_template_kwargs' },
  );

  expect(body).toMatchObject({
    chat_template_kwargs: { enable_thinking: true },
  });
  expect(JSON.stringify(body)).not.toContain('2000');
  expect(leftOut.map(({ setting }) => setting)).toEqual([
    'reasoning.budgetTokens',
  ]);
});

test('an effort sets the template argument to true where the dialect has no level', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'medium' } } },
    { name: 'templated', asks: 'chat_template_kwargs', efforts: [] },
  );

  expect(body).toMatchObject({
    chat_template_kwargs: { enable_thinking: true },
  });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.effort']);
});

test('an order not to reason sets the flag of the reasoning object to false, and a budget sets it to true', () => {
  const off = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'flagged', asks: 'reasoning.enabled' },
  );
  const on = encode(
    'model-x',
    { messages: [], options: { reasoning: { budgetTokens: 2000 } } },
    { name: 'flagged', asks: 'reasoning.enabled' },
  );

  expect(off.body).toMatchObject({ reasoning: { enabled: false } });
  expect(off.body).not.toHaveProperty('reasoning_effort');
  expect(off.leftOut).toEqual([]);
  expect(on.body).toMatchObject({ reasoning: { enabled: true } });
  expect(on.leftOut.map(({ setting }) => setting)).toEqual([
    'reasoning.budgetTokens',
  ]);
});

test('a reasoning object said in own words is sent as said, and its flag says whether the request reasons', () => {
  const asked: (boolean | undefined)[] = [];
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'high' },
        provider: { 'openai.chat': { reasoning: { enabled: false } } },
      },
    },
    { name: 'flagged', asks: 'reasoning.enabled' },
    {},
    (_model, reasons) => {
      asked.push(reasons);
      return undefined;
    },
  );

  expect(body).toMatchObject({ reasoning: { enabled: false } });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(asked.at(-1)).toBe(false);
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('an effort goes under its own name beside a template argument, which is left alone', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'medium' } } },
    { name: 'templated', asks: 'chat_template_kwargs' },
  );

  expect(body).toMatchObject({ reasoning_effort: 'medium' });
  expect(body).not.toHaveProperty('chat_template_kwargs');
  expect(leftOut).toEqual([]);
});

test.each([
  ['minimal', 'low'],
  ['low', 'low'],
  ['medium', 'high'],
  ['high', 'high'],
  ['xhigh', 'max'],
  ['max', 'max'],
] as const)(
  'an effort of %s goes as %s to an upstream that takes low, high and max',
  (effort, sent) => {
    const { body, leftOut } = encode(
      'model-x',
      { messages: [], options: { reasoning: { effort } } },
      { name: 'levelled', efforts: ['low', 'high', 'max'] },
    );

    expect(body).toMatchObject({ reasoning_effort: sent });
    expect(leftOut).toEqual(
      effort === sent
        ? []
        : [
            {
              setting: 'reasoning.level',
              detail:
                'Chat Completions has no field for a reasoning effort the upstream has no level for, sent as the nearest it has',
            },
          ],
    );
  },
);

test('a level is never sent as an order not to reason, though the upstream takes one', () => {
  const { body } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'minimal' } } },
    { name: 'levelled', efforts: ['none', 'high'] },
  );

  expect(body).toMatchObject({ reasoning_effort: 'high' });
});

test('a thinking flag said in own words is sent as said, and an order not to reason beside it is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'none' },
        provider: { 'openai.chat': { enable_thinking: true } },
      },
    },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toMatchObject({ enable_thinking: true });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('a thinking budget said in own words is sent as said with no flag written beside it, and the budget beside it is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { budgetTokens: 2000 },
        provider: { 'openai.chat': { thinking_budget: 500 } },
      },
    },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toEqual({
    thinking_budget: 500,
    model: 'model-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('a template argument said in own words is sent as said, and an order not to reason beside it is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'none' },
        provider: {
          'openai.chat': { chat_template_kwargs: { enable_thinking: true } },
        },
      },
    },
    { name: 'templated', asks: 'chat_template_kwargs' },
  );

  expect(body).toMatchObject({
    chat_template_kwargs: { enable_thinking: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('a thinking type said in own words is sent as said, and an order not to reason beside it is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'none' },
        provider: { 'openai.chat': { thinking: { type: 'enabled' } } },
      },
    },
    { name: 'switched', asks: 'thinking' },
  );

  expect(body).toMatchObject({ thinking: { type: 'enabled' } });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test.each([
  [
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
    { enable_thinking: false, thinking_budget: 100 },
  ],
  [
    { name: 'templated', asks: 'chat_template_kwargs' },
    { chat_template_kwargs: { enable_thinking: false } },
  ],
] as const)(
  'a request that asks to reason is sent none of the connection`s own switch: %j',
  (dialect, defaults) => {
    const bare = encode(
      'model-x',
      { messages: [], options: { reasoning: { budgetTokens: 2000 } } },
      dialect,
    );
    const stated = encode(
      'model-x',
      { messages: [], options: { reasoning: { budgetTokens: 2000 } } },
      dialect,
      { ...defaults },
    );

    expect(stated.body).toEqual(bare.body);
  },
);

test.each([
  [{ name: 'switched', asks: 'thinking' }, false],
  [{ name: 'flagged', asks: 'enable_thinking', efforts: [] }, false],
  [{ name: 'templated', asks: 'chat_template_kwargs' }, false],
] as const)(
  'a rule is told that a request whose switch is off does not reason: %j',
  (dialect, reasons) => {
    const asked: (boolean | undefined)[] = [];
    encode(
      'model-x',
      { messages: [], options: { reasoning: { effort: 'none' } } },
      dialect,
      {},
      (_, how) => {
        asked.push(how);
        return undefined;
      },
    );

    expect(asked).toEqual([true, reasons]);
  },
);

test('a rule is told that a request whose switch a budget turned on reasons', () => {
  const asked: (boolean | undefined)[] = [];
  encode(
    'model-x',
    { messages: [], options: { reasoning: { budgetTokens: 2000 } } },
    { name: 'switched', asks: 'thinking' },
    {},
    (_, how) => {
      asked.push(how);
      return undefined;
    },
  );

  expect(asked).toEqual([true, true]);
});

test('an effort the model does not take turns no switch, whatever it said', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { reasoning: { effort: 'none' } } },
    { name: 'switched', asks: 'thinking' },
    {},
    () => ({
      temperature: [0, 2],
      topP: [0, 1],
      topK: true,
      presencePenalty: true,
      frequencyPenalty: true,
      together: true,
      effort: false,
    }),
  );

  expect(body).not.toHaveProperty('thinking');
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.model']);
});

test('a schema is asked for as any JSON object where the upstream takes no schema, and is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      output: {
        schema: { type: 'object', properties: { city: { type: 'string' } } },
        name: 'place',
        strict: true,
      },
    },
    { name: 'schemaless', output: 'json_object' },
  );

  expect(body).toHaveProperty('response_format', { type: 'json_object' });
  expect(leftOut).toEqual([
    {
      setting: 'output.schema',
      detail:
        'Chat Completions has no field for the schema of a JSON output, to an upstream that takes any JSON object',
    },
  ]);
});

test('a JSON output with no schema is asked the same of an upstream that takes no schema, and nothing is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], output: {} },
    { name: 'schemaless', output: 'json_object' },
  );

  expect(body).toHaveProperty('response_format', { type: 'json_object' });
  expect(leftOut).toEqual([]);
});

test('a prompt with no JSON output asks an upstream that takes no schema for no format', () => {
  const { body } = encode(
    'model-x',
    { messages: [] },
    { name: 'schemaless', output: 'json_object' },
  );

  expect(body).not.toHaveProperty('response_format');
});

test('a schema is sent as one where the dialect says nothing of the form', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], output: { schema: { type: 'object' }, name: 'place' } },
    { name: 'router' },
  );

  expect(body).toHaveProperty('response_format', {
    type: 'json_schema',
    json_schema: { name: 'place', schema: { type: 'object' }, strict: false },
  });
  expect(leftOut).toEqual([]);
});

test('a thinking flag turned off in own words has no budget written beside it, and the budget is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { budgetTokens: 2000 },
        provider: { 'openai.chat': { enable_thinking: false } },
      },
    },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toEqual({
    enable_thinking: false,
    model: 'model-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('an effort said in own words has no flag and no budget written beside it, and the budget is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { budgetTokens: 2000 },
        provider: { 'openai.chat': { reasoning_effort: 'low' } },
      },
    },
    { name: 'flagged', asks: 'enable_thinking', efforts: [] },
  );

  expect(body).toEqual({
    reasoning_effort: 'low',
    model: 'model-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('a thinking type turned off in own words has no effort written beside it, and the effort is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'high' },
        provider: { 'openai.chat': { thinking: { type: 'disabled' } } },
      },
    },
    { name: 'typed', asks: 'thinking', efforts: ['low', 'high', 'max'] },
  );

  expect(body).toEqual({
    thinking: { type: 'disabled' },
    model: 'model-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('an effort said in own words to a router has no reasoning object written beside it, and the effort is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'high' },
        provider: { 'openai.chat': { reasoning_effort: 'low' } },
      },
    },
    { name: 'router', asks: 'reasoning' },
  );

  expect(body).toEqual({
    reasoning_effort: 'low',
    model: 'model-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('a level the upstream has no word for is not said to be sent as another where own words stand in its place', () => {
  const { leftOut } = encode(
    'model-x',
    {
      messages: [],
      options: {
        reasoning: { effort: 'medium' },
        provider: { 'openai.chat': { thinking: { type: 'enabled' } } },
      },
    },
    { name: 'typed', asks: 'thinking', efforts: ['low', 'high', 'max'] },
  );

  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.own']);
});

test('a field of a detail named as the prototype is a field like any other', () => {
  const [whole] = joined([
    JSON.parse(
      '{"type":"reasoning.text","index":0,"text":"Pa","__proto__":{"x":1}}',
    ),
    { type: 'reasoning.text', index: 0, text: 'ris' },
  ]);

  expect(JSON.stringify(whole)).toBe(
    '{"type":"reasoning.text","index":0,"text":"Paris","__proto__":{"x":1}}',
  );
  expect(Object.getPrototypeOf(whole)).toBe(Object.prototype);
});
