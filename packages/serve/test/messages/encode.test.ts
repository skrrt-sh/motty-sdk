import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { Message } from '@mottyjs/core/host';
import { chatCompletions } from '../../src/chat-completions/index.ts';
import { decode } from '../../src/messages/decode.ts';
import { encode } from '../../src/messages/encode.ts';

test('a prompt is sent as a streamed request with the version header', () => {
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'system', text: 'You are terse.' },
        { role: 'user', text: 'Hello' },
      ],
      options: { maxTokens: 1024 },
    }),
  ).toEqual({
    path: '/messages',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    },
    leftOut: [],
  });
});

test('leading instructions of any role and shape are system blocks', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'system', text: 'You are terse.' },
      {
        role: 'developer',
        parts: [{ type: 'text', text: 'Answer in French.' }],
        cache: { ttl: '1h' },
      },
      { role: 'user', text: 'Hello' },
    ],
  });
  expect(body).toMatchObject({
    system: [
      { type: 'text', text: 'You are terse.' },
      {
        type: 'text',
        text: 'Answer in French.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: 'Hello' }],
  });
});

test('a turn left with no block is not sent', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'user', text: 'Hello' },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'Routing' }] },
      { role: 'user', text: 'Still there?' },
    ],
  });
  expect(body).toMatchObject({
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'Still there?' },
    ],
  });
});

test('a cache marker on a plain message puts its text in a block', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [{ role: 'user', text: 'A long document', cache: {} }],
  });
  expect(body).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'A long document',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
});

test('a meaning-changing entry of another family on a message fails the call', () => {
  expect(() =>
    encode('claude-opus-5-5', {
      messages: [
        {
          role: 'user',
          text: 'Hello',
          provider: { 'openai.chat': { audio: {} } },
        },
      ],
    }),
  ).toThrow(Unsupported);
});

test('an instruction between turns is sent where the API takes one', () => {
  const said = { role: 'system', content: 'Be terse.' };
  const result = { type: 'tool_result', tool_use_id: 'toolu_01', content: '1' };
  const searched = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_01',
    content: [],
  };
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'system', text: 'Be terse.' },
        { role: 'developer', text: 'And kind.' },
        { role: 'assistant', text: 'Hello' },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', id: 'toolu_01', text: '1' }],
        },
        { role: 'system', text: 'Be terse.' },
        {
          role: 'assistant',
          parts: [{ type: 'provider', provider: { anthropic: searched } }],
        },
        { role: 'system', text: 'Be terse.' },
      ],
    }).body,
  ).toMatchObject({
    messages: [
      { role: 'user', content: 'Hi' },
      said,
      { role: 'system', content: 'And kind.' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: [result] },
      said,
      { role: 'assistant', content: [searched] },
      said,
    ],
  });
});

test('an instruction that stands before user turns waits past them', () => {
  const said = { role: 'system', content: 'Be terse.' };
  const call = { type: 'tool_use', id: 'toolu_01', name: 'get', input: {} };
  const result = { type: 'tool_result', tool_use_id: 'toolu_01', content: '1' };
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
        { role: 'developer', text: 'Be terse.' },
        { role: 'user', text: 'More' },
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'toolu_01', name: 'get', input: {} },
          ],
        },
        { role: 'system', text: 'Be terse.' },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', id: 'toolu_01', text: '1' }],
        },
        { role: 'system', text: 'Be terse.' },
        { role: 'user', text: 'Go' },
      ],
    }).body,
  ).toMatchObject({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'More' },
      said,
      { role: 'assistant', content: [call] },
      { role: 'user', content: [result] },
      { role: 'user', content: 'Go' },
      said,
      said,
    ],
  });
});

test('an instruction moved past a user turn is reported; one sent in place is not', () => {
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'system', text: 'Be terse.' },
        { role: 'user', text: 'Go' },
      ],
    }),
  ).toMatchObject({
    body: {
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Go' },
        { role: 'system', content: 'Be terse.' },
      ],
    },
    leftOut: [
      {
        setting: 'message.moved',
        detail:
          'Anthropic Messages has no field for an instruction before a user turn, sent after it',
      },
    ],
  });
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'system', text: 'Be terse.' },
        { role: 'assistant', text: 'Hello' },
        { role: 'user', text: 'Go' },
      ],
    }).leftOut,
  ).toEqual([]);
});

test('an instruction no user turn comes before fails the call', () => {
  const instruction = { role: 'developer', text: 'Be terse.' } as const;
  for (const messages of [
    [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
      instruction,
    ],
    [
      {
        role: 'system',
        text: 'Only this turn.',
        provider: { anthropic: { clear_at: 'next_user_message' } },
      },
      { role: 'assistant', text: 'Hello' },
    ],
  ] as const) {
    expect(() => encode('claude-opus-5-5', { messages })).toThrow(Unsupported);
  }
});

test("an instruction's own fields are sent, and alone they go anywhere", () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'system', text: 'You are terse.' },
      {
        role: 'system',
        parts: [],
        hints: { anthropic: { output_config: { effort: 'low' } } },
      },
      { role: 'user', text: 'Hi' },
      {
        role: 'system',
        text: 'Only this turn.',
        provider: { anthropic: { clear_at: 'next_user_message' } },
      },
      { role: 'assistant', text: 'Hello' },
      {
        role: 'system',
        text: '',
        hints: { anthropic: { output_config: { effort: 'high' } } },
      },
      { role: 'user', text: 'More' },
    ],
  });
  expect(body).toMatchObject({
    system: 'You are terse.',
    messages: [
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'user', content: 'Hi' },
      {
        role: 'system',
        content: 'Only this turn.',
        clear_at: 'next_user_message',
      },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'user', content: 'More' },
    ],
  });
});

test('text with nothing in it is never sent', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'system', text: '' },
      { role: 'user', text: '' },
      { role: 'user', parts: [{ type: 'text', text: '' }], cache: {} },
      {
        role: 'user',
        parts: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Hi' },
        ],
      },
    ],
  });
  expect(body).toMatchObject({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  expect(body).not.toHaveProperty('system');
});

test('an instruction holding an image fails the call: the field of its own takes text alone', () => {
  const sent = () =>
    encode('claude-opus-5-5', {
      messages: [
        {
          role: 'system',
          parts: [{ type: 'image', url: 'https://x.test/cat.png' }],
        },
        { role: 'user', text: 'Hi' },
      ],
    });
  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(
    'Anthropic Messages takes no image block as instructions',
  );
});

test('a turn of results is gathered with its own marker and failure flag, and one with fields of its own stays apart', () => {
  expect(
    encode('claude-haiku-5-5', {
      messages: [
        {
          role: 'tool',
          cache: { ttl: '1h' },
          parts: [{ type: 'tool_result', id: 'call_a', text: '4C' }],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', id: 'call_b', text: 'boom', failed: true },
          ],
        },
        {
          role: 'tool',
          hints: { anthropic: { note: 'kept' } },
          parts: [{ type: 'tool_result', id: 'call_c', text: '9C' }],
        },
      ],
    }).body,
  ).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_a',
            content: '4C',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_b',
            content: 'boom',
            is_error: true,
          },
        ],
      },
      {
        role: 'user',
        note: 'kept',
        content: [
          { type: 'tool_result', tool_use_id: 'call_c', content: '9C' },
        ],
      },
    ],
  });
});

function results(count: number): readonly Message[] {
  const { request } = chatCompletions.decode(
    {
      model: 'coder',
      messages: [
        { role: 'user', content: 'Check every host.' },
        ...Array.from({ length: count }, (_, at) => ({
          role: 'tool',
          tool_call_id: `call_${at}`,
          content: 'up',
        })),
      ],
    },
    new Headers(),
  );
  return request.messages;
}

function citations(count: number): readonly Message[] {
  const { request } = decode(
    {
      model: 'coder',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'It grew.',
              citations: Array.from({ length: count }, (_, at) => ({
                type: 'char_location',
                cited_text: 'grew',
                document_index: 0,
                start_char_index: at,
                end_char_index: at + 4,
              })),
            },
          ],
        },
      ],
    },
    new Headers(),
  );
  return request.messages;
}

test('citations put back are written as they always were', () => {
  expect(
    JSON.stringify(encode('claude-haiku-5-5', { messages: citations(3) }).body),
  ).toBe(
    '{"max_tokens":64000,"model":"claude-haiku-5-5","messages":[{"role":"assistant","content":[{"type":"text","text":"It grew.","citations":[{"type":"char_location","cited_text":"grew","document_index":0,"start_char_index":0,"end_char_index":4},{"type":"char_location","cited_text":"grew","document_index":0,"start_char_index":1,"end_char_index":5},{"type":"char_location","cited_text":"grew","document_index":0,"start_char_index":2,"end_char_index":6}]}]}],"stream":true}',
  );
});

// The least of five rounds is read, so a busy machine does not fail it.
function quickest(messages: readonly Message[]): number {
  let least = Number.POSITIVE_INFINITY;
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    encode('claude-haiku-5-5', { messages });
    least = Math.min(least, performance.now() - start);
  }
  return least;
}

// Four times the input takes four times as long when the work grows with
// it, and sixteen when it grows with its square.
test.each([
  ['results of tools, a turn each', results],
  ['citations of one text', citations],
])(
  '%s are encoded in time that grows with their number, not its square',
  (_, made) => {
    expect(quickest(made(40_000)) / quickest(made(10_000))).toBeLessThan(8);
  },
  60_000,
);

test.each([
  [
    { effort: 'high' } as const,
    {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    },
  ],
  [
    { budgetTokens: 2048 },
    {
      thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
    },
  ],
  [{ exclude: true }, {}],
])(
  'reasoning %j is sent the same with a connection that states thinking and without one',
  (reasoning, sent) => {
    const bare = encode('claude-opus-5-5', {
      messages: [{ role: 'user', text: 'Hello' }],
      options: { reasoning },
    });
    const { body, leftOut } = encode(
      'claude-opus-5-5',
      { messages: [{ role: 'user', text: 'Hello' }], options: { reasoning } },
      {
        thinking: { type: 'enabled', budget_tokens: 4000, display: 'omitted' },
        output_config: { effort: 'low' },
        top_k: 40,
      },
    );

    expect(bare.body).toEqual({
      ...sent,
      max_tokens: 64000,
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(body).toEqual({
      ...sent,
      top_k: 40,
      max_tokens: 64000,
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(leftOut).toEqual(bare.leftOut);
  },
);

test('a request that says nothing of reasoning is sent the connection`s as stated', () => {
  expect(
    encode(
      'claude-opus-5-5',
      { messages: [{ role: 'user', text: 'Hello' }] },
      {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'low' },
      },
    ),
  ).toMatchObject({
    body: {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
      max_tokens: 64000,
    },
    leftOut: [],
  });
});

test('the author`s own thinking replaces the connection`s whole, with and without an effort', () => {
  const silent = encode(
    'claude-sonnet-5-5',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: {
        provider: { anthropic: { thinking: { type: 'between_tools' } } },
      },
    },
    { thinking: { type: 'adaptive', display: 'summarized' } },
  );
  const asked = encode(
    'claude-sonnet-5-5',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: {
        reasoning: { effort: 'high' },
        provider: { anthropic: { thinking: { type: 'between_tools' } } },
      },
    },
    {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    },
  );

  expect(silent.body).toMatchObject({ thinking: { type: 'between_tools' } });
  expect(silent.body).not.toHaveProperty('output_config');
  expect(asked.body).toMatchObject({
    thinking: { type: 'between_tools' },
    output_config: { effort: 'high' },
  });
  expect(asked.leftOut).toEqual([]);
});

test('a connection`s system is sent when the request has none, and its limit fills a request with none', () => {
  expect(
    encode(
      'claude-opus-5-5',
      { messages: [{ role: 'user', text: 'Hello' }] },
      { system: 'Be terse.', max_tokens: 8192 },
    ).body,
  ).toEqual({
    system: 'Be terse.',
    max_tokens: 8192,
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  });
});

test('the rule is asked by the name the upstream knows the model by', () => {
  const { body, leftOut } = encode(
    'claude-opus-4-7',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: { temperature: 0.2 },
    },
    {},
    (model) =>
      model === 'claude-opus-4-7'
        ? {
            temperature: 1,
            topP: 0.99,
            topK: false,
            presencePenalty: false,
            frequencyPenalty: false,
            together: false,
            effort: true,
          }
        : undefined,
  );

  expect(body).not.toHaveProperty('temperature');
  expect(leftOut).toEqual([
    {
      setting: 'temperature.model',
      detail:
        'Anthropic Messages has no field for a temperature the model does not take',
    },
  ]);
});

test('a message with an entry for each family is sent this one`s own', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      {
        role: 'user',
        text: 'Hello',
        provider: { 'openai.chat': { y: 2 }, anthropic: { x: 1 } },
      },
    ],
  });

  expect(body).toMatchObject({
    messages: [{ role: 'user', content: 'Hello', x: 1 }],
  });
});

test('a temperature the request states replaces the connection`s, also when the model takes neither', () => {
  const { body, leftOut } = encode(
    'claude-opus-5-5',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: { temperature: 0.7 },
    },
    { temperature: 0.2, top_k: 40 },
    () => ({
      temperature: 1,
      topP: 0.99,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    }),
  );

  expect(body).toEqual({
    top_k: 40,
    max_tokens: 64000,
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['temperature.model']);
});
