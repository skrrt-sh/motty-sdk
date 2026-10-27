import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { Chunk } from '@mottyjs/core/host';
import { reply } from '../../src/responses/reply.ts';

test('text opens a message, fills it, and the end completes it', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(push({ type: 'text', text: 'Hel' })).toEqual([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'msg_r1_0',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
    {
      type: 'response.content_part.added',
      item_id: 'msg_r1_0',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
    },
    {
      type: 'response.output_text.delta',
      item_id: 'msg_r1_0',
      output_index: 0,
      content_index: 0,
      delta: 'Hel',
      logprobs: [],
    },
  ]);
  expect(push({ type: 'text', text: 'lo' }).map(({ type }) => type)).toEqual([
    'response.output_text.delta',
  ]);
  expect(closed('whole').map(({ type }) => type)).toEqual([
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
  ]);
  expect(output).toEqual([
    {
      id: 'msg_r1_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'Hello', annotations: [], logprobs: [] },
      ],
    },
  ]);
});

test('each piece of progress is a summary of one reasoning item', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [
      ...push({ type: 'progress', piece: 0, text: 'Rout' }),
      ...push({ type: 'progress', piece: 0, text: 'ing' }),
      ...push({ type: 'progress', piece: 1, text: 'Picked fast' }),
      ...push({ type: 'text', text: 'Hi' }),
    ].map(({ type }) => type),
  ).toEqual([
    'response.output_item.added',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta',
    'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
  ]);
  closed('whole');
  expect(output[0]).toEqual({
    id: 'rs_r1_0',
    type: 'reasoning',
    summary: [
      { type: 'summary_text', text: 'Routing' },
      { type: 'summary_text', text: 'Picked fast' },
    ],
    content: [],
  });
});

test('a reply that failed finished none of the items still being written, and the ones before are done', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(['patch']),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'text', text: 'Hel' });
  push({ type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{"c' });
  push({ type: 'tool_call', id: 'call_2', name: 'patch', arguments: '***' });

  const sent = closed('failed');

  expect(sent.at(-1)).toMatchObject({
    type: 'response.output_item.done',
    item: { type: 'custom_tool_call', input: '***' },
  });
  expect(output).toEqual([
    {
      id: 'msg_r1_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        { type: 'output_text', text: 'Hel', annotations: [], logprobs: [] },
      ],
    },
    {
      id: 'fc_r1_1',
      type: 'function_call',
      status: 'incomplete',
      call_id: 'call_1',
      name: 'weather',
      arguments: '{"c',
    },
    {
      id: 'ctc_r1_2',
      type: 'custom_tool_call',
      call_id: 'call_2',
      name: 'patch',
      input: '***',
    },
  ]);
});

test('reasoning a failure broke off says it did not finish', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'reasoning', text: 'Weigh' });

  closed('failed');

  expect(output).toEqual([
    {
      id: 'rs_r1_0',
      type: 'reasoning',
      status: 'incomplete',
      summary: [{ type: 'summary_text', text: 'Weigh' }],
      content: [],
    },
  ]);
});

test('a reply that was cut off did not finish its last item, and finished the rest', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'text', text: 'Checking.' });
  push({ type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{}' });
  push({ type: 'tool_call', id: 'call_2', name: 'weather', arguments: '{"c' });

  closed('cut');

  expect(output).toMatchObject([
    { type: 'message', status: 'completed' },
    { type: 'function_call', status: 'completed', arguments: '{}' },
    { type: 'function_call', status: 'incomplete', arguments: '{"c' },
  ]);
});

test("progress and the model's own reasoning are separate items", () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'progress', piece: 0, text: 'Routing' });
  push({ type: 'reasoning', text: 'Let me think.' });
  closed('whole');
  expect(output).toEqual([
    {
      id: 'rs_r1_0',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Routing' }],
      content: [],
    },
    {
      id: 'rs_r1_1',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Let me think.' }],
      content: [],
    },
  ]);
});

test('a muted caller gets no progress and no reasoning of another family', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(push({ type: 'progress', piece: 0, text: 'Routing' })).toEqual([]);
  expect(
    push({
      type: 'reasoning',
      text: 'Hm.',
      provider: { anthropic: { signature: 'EqQBCg==' } },
    }),
  ).toEqual([]);
  closed('whole');
  expect(output).toEqual([]);
});

test("this API's own reasoning item is handed back with its id and its encrypted content, muted or not", () => {
  const item = {
    type: 'reasoning',
    id: 'rs_up',
    summary: [],
    encrypted_content: 'gAAAAABo',
  };
  const muted = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    muted.push({
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { 'openai.responses': { type: 'reasoning', id: 'rs_up' } },
    }),
  ).toEqual([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_up', summary: [] },
    },
  ]);
  expect(muted.push({ type: 'reasoning', text: 'Secret.', block: 0 })).toEqual(
    [],
  );
  muted.push({
    type: 'reasoning',
    text: '',
    block: 0,
    provider: { 'openai.responses': item },
  });
  muted.closed('whole');
  expect(muted.output).toEqual([item]);

  const shown = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  shown.push({
    type: 'reasoning',
    text: 'Plan.',
    block: 0,
    provider: { 'openai.responses': { type: 'summary_text' } },
  });
  shown.push({
    type: 'reasoning',
    text: '',
    block: 0,
    provider: { 'openai.responses': item },
  });
  shown.closed('whole');
  expect(shown.output).toEqual([
    {
      ...item,
      id: 'rs_r1_0',
      summary: [{ type: 'summary_text', text: 'Plan.' }],
    },
  ]);
});

test("this API's reasoning that came as content is streamed as content, to a muted caller too", () => {
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
  for (const muted of [false, true]) {
    const { output, push, closed } = reply(
      {
        body: {},
        muted,
        custom: new Set(),
        spaced: new Map(),
        clients: new Set(),
        encrypted: false,
      },
      'r1',
    );
    expect([
      ...push({
        type: 'reasoning',
        text: '',
        block: 0,
        provider: {
          'openai.responses': {
            id: 'rs_tmp_z582ajgark',
            type: 'reasoning',
            status: 'in_progress',
            summary: [],
          },
        },
      }),
      ...push({
        type: 'reasoning',
        text: 'Paris s',
        block: 0,
        provider: { 'openai.responses': { type: 'reasoning_text' } },
      }),
      ...push({
        type: 'reasoning',
        text: "its further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
        block: 0,
        provider: { 'openai.responses': { type: 'reasoning_text' } },
      }),
      ...push({
        type: 'reasoning',
        text: '',
        block: 0,
        provider: { 'openai.responses': item },
      }),
      ...closed('whole'),
    ]).toEqual([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'rs_tmp_z582ajgark',
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
        },
      },
      {
        type: 'response.content_part.added',
        item_id: 'rs_tmp_z582ajgark',
        output_index: 0,
        content_index: 0,
        part: { type: 'reasoning_text', text: '' },
      },
      {
        type: 'response.reasoning_text.delta',
        item_id: 'rs_tmp_z582ajgark',
        output_index: 0,
        content_index: 0,
        delta: 'Paris s',
      },
      {
        type: 'response.reasoning_text.delta',
        item_id: 'rs_tmp_z582ajgark',
        output_index: 0,
        content_index: 0,
        delta:
          "its further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
      },
      {
        type: 'response.reasoning_text.done',
        item_id: 'rs_tmp_z582ajgark',
        output_index: 0,
        content_index: 0,
        text: "Paris sits further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
      },
      {
        type: 'response.content_part.done',
        item_id: 'rs_tmp_z582ajgark',
        output_index: 0,
        content_index: 0,
        part: {
          type: 'reasoning_text',
          text: "Paris sits further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
        },
      },
      { type: 'response.output_item.done', output_index: 0, item },
    ]);
    expect(JSON.stringify(output)).toBe(JSON.stringify([item]));
  }
});

test("this API's summary is streamed as a summary, and a muted caller is sent none", () => {
  const item = {
    id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
    type: 'reasoning',
    status: 'completed',
    summary: [
      {
        type: 'summary_text',
        text: '**Calculating multiplication**\n\nI need',
      },
    ],
    encrypted_content: 'gAAAAABqyfJx',
  };
  const told: Chunk[] = [
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: {
        'openai.responses': {
          id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
        },
      },
    },
    {
      type: 'reasoning',
      text: '**Calculating multiplication**\n\nI',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    },
    {
      type: 'reasoning',
      text: ' need',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    },
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { 'openai.responses': item },
    },
  ];
  const shown = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [...told.flatMap(shown.push), ...shown.closed('whole')].slice(1),
  ).toEqual([
    {
      type: 'response.reasoning_summary_part.added',
      item_id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
      output_index: 0,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
      output_index: 0,
      summary_index: 0,
      delta: '**Calculating multiplication**\n\nI',
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
      output_index: 0,
      summary_index: 0,
      delta: ' need',
    },
    {
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
      output_index: 0,
      summary_index: 0,
      text: '**Calculating multiplication**\n\nI need',
    },
    {
      type: 'response.reasoning_summary_part.done',
      item_id: 'rs_0123456789abcdef0123456789abcdef0123456789abcdef01',
      output_index: 0,
      summary_index: 0,
      part: {
        type: 'summary_text',
        text: '**Calculating multiplication**\n\nI need',
      },
    },
    { type: 'response.output_item.done', output_index: 0, item },
  ]);
  expect(shown.output).toEqual([item]);

  const muted = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [...told.flatMap(muted.push), ...muted.closed('whole')].map(
      ({ type }) => type,
    ),
  ).toEqual(['response.output_item.added', 'response.output_item.done']);
  expect(muted.output).toEqual([{ ...item, summary: [] }]);
});

test('an item with a summary and content ends each part once, each counted on its own', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  const sent = [
    ...push({
      type: 'reasoning',
      text: 'Comparing latitudes.',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    }),
    ...push({
      type: 'reasoning',
      text: 'Paris is at 48.86N,',
      block: 0,
      provider: { 'openai.responses': { type: 'reasoning_text' } },
    }),
    ...push({
      type: 'reasoning',
      text: ' Lyon at 45.76N.',
      block: 0,
      provider: { 'openai.responses': { type: 'reasoning_text' } },
    }),
    ...push({
      type: 'reasoning',
      text: 'Paris it is.',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    }),
    ...closed('whole'),
  ];
  expect(
    sent.map(({ type, summary_index, content_index }) => [
      type,
      summary_index ?? content_index,
    ]),
  ).toEqual([
    ['response.output_item.added', undefined],
    ['response.reasoning_summary_part.added', 0],
    ['response.reasoning_summary_text.delta', 0],
    ['response.reasoning_summary_text.done', 0],
    ['response.reasoning_summary_part.done', 0],
    ['response.content_part.added', 0],
    ['response.reasoning_text.delta', 0],
    ['response.reasoning_text.delta', 0],
    ['response.reasoning_text.done', 0],
    ['response.content_part.done', 0],
    ['response.reasoning_summary_part.added', 1],
    ['response.reasoning_summary_text.delta', 1],
    ['response.reasoning_summary_text.done', 1],
    ['response.reasoning_summary_part.done', 1],
    ['response.output_item.done', undefined],
  ]);
  expect(output).toEqual([
    {
      id: 'rs_r1_0',
      type: 'reasoning',
      summary: [
        { type: 'summary_text', text: 'Comparing latitudes.' },
        { type: 'summary_text', text: 'Paris it is.' },
      ],
      content: [
        { type: 'reasoning_text', text: 'Paris is at 48.86N, Lyon at 45.76N.' },
      ],
    },
  ]);
});

test('thinking another family signed is written as a summary, without its signature', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [
      ...push({ type: 'reasoning', text: 'Paris is north.', block: 0 }),
      ...push({
        type: 'reasoning',
        text: '',
        block: 0,
        provider: { anthropic: { signature: 'EqQBCg==' } },
      }),
    ].map(({ type }) => type),
  ).toEqual([
    'response.output_item.added',
    'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta',
  ]);
  closed('whole');
  expect(output).toEqual([
    {
      id: 'rs_r1_0',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Paris is north.' }],
      content: [],
    },
  ]);
});

test('a new block of text is a new message, and it keeps its phase', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({
    type: 'text',
    text: 'Looking.',
    block: 0,
    provider: { 'openai.responses': { phase: 'commentary' } },
  });
  push({ type: 'text', text: 'Found.', block: 1 });
  closed('whole');
  expect(output).toMatchObject([
    { id: 'msg_r1_0', phase: 'commentary', content: [{ text: 'Looking.' }] },
    { id: 'msg_r1_1', content: [{ text: 'Found.' }] },
  ]);
  expect(output[1]).not.toHaveProperty('phase');
});

test('text that is empty adds nothing with no phase, and with one says of its item alone, as it opens or after its text', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(push({ type: 'text', text: '', block: 0 })).toEqual([]);
  expect(
    push({
      type: 'refusal',
      text: '',
      block: 0,
      provider: { anthropic: { phase: 'commentary' } },
    }),
  ).toEqual([]);
  expect(output).toEqual([]);
  expect(
    push({
      type: 'text',
      text: '',
      block: 0,
      provider: { 'openai.responses': { phase: 'commentary' } },
    }),
  ).toEqual([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        phase: 'commentary',
        id: 'msg_r1_0',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    },
  ]);
  push({ type: 'citation', url: 'https://x.test', block: 0 });
  push({ type: 'text', text: 'a', block: 0 });
  expect(
    push({
      type: 'text',
      text: '',
      block: 0,
      provider: {
        'openai.responses': { phase: 'final_answer', id: 'up', role: 'user' },
      },
    }),
  ).toEqual([]);
  closed('whole');
  expect(output).toEqual([
    {
      phase: 'final_answer',
      id: 'msg_r1_0',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'a',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://x.test',
              title: '',
              start_index: 0,
              end_index: 0,
            },
          ],
          logprobs: [],
        },
      ],
    },
  ]);
});

test('a refusal is its own part of the message it comes in', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'text', text: 'Well.' });
  expect(
    push({ type: 'refusal', text: 'I cannot.' }).map(({ type }) => type),
  ).toEqual([
    'response.output_text.done',
    'response.content_part.done',
    'response.content_part.added',
    'response.refusal.delta',
  ]);
  expect(closed('whole').map(({ type }) => type)).toEqual([
    'response.refusal.done',
    'response.content_part.done',
    'response.output_item.done',
  ]);
  expect(output).toMatchObject([
    {
      content: [
        { type: 'output_text', text: 'Well.' },
        { type: 'refusal', refusal: 'I cannot.' },
      ],
    },
  ]);
});

test('a citation annotates the text before it', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'text', text: 'See the docs.' });
  expect(
    push({ type: 'citation', url: 'https://x.test', title: 'Docs' }),
  ).toEqual([
    {
      type: 'response.output_text.annotation.added',
      item_id: 'msg_r1_0',
      output_index: 0,
      content_index: 0,
      annotation_index: 0,
      annotation: {
        type: 'url_citation',
        url: 'https://x.test',
        title: 'Docs',
        start_index: 13,
        end_index: 13,
      },
    },
  ]);
  push({
    type: 'citation',
    title: 'a.md',
    provider: {
      'openai.responses': {
        type: 'file_citation',
        file_id: 'file-1',
        index: 3,
      },
    },
  });
  expect(push({ type: 'citation', text: 'a quoted passage' })).toEqual([]);
  closed('whole');
  expect(output).toMatchObject([
    {
      content: [
        {
          annotations: [
            { type: 'url_citation', url: 'https://x.test' },
            { type: 'file_citation', file_id: 'file-1', index: 3 },
          ],
        },
      ],
    },
  ]);
});

test('the fragments of a call are assembled, also when calls interleave', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    push({ type: 'tool_call', id: 'call_1', name: 'weather', arguments: '' }),
  ).toEqual([
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_r1_0',
        type: 'function_call',
        status: 'in_progress',
        call_id: 'call_1',
        name: 'weather',
        arguments: '',
      },
    },
  ]);
  push({ type: 'tool_call', id: 'call_2', name: 'time', arguments: '{"tz"' });
  expect(
    push({ type: 'tool_call', id: 'call_1', arguments: '{"city"' }),
  ).toEqual([
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_r1_0',
      output_index: 0,
      delta: '{"city"',
    },
  ]);
  push({ type: 'tool_call', id: 'call_2', arguments: ':"UTC"}' });
  push({ type: 'tool_call', id: 'call_1', arguments: ':"Oslo"}' });
  expect(closed('whole')).toEqual([
    {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_r1_0',
      output_index: 0,
      arguments: '{"city":"Oslo"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_r1_0',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Oslo"}',
      },
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_r1_1',
      output_index: 1,
      arguments: '{"tz":"UTC"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        id: 'fc_r1_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_2',
        name: 'time',
        arguments: '{"tz":"UTC"}',
      },
    },
  ]);
  expect(output).toHaveLength(2);
});

test('a call to a custom tool is written as one, with its free text', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(['patch']),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [
      ...push({
        type: 'tool_call',
        id: 'call_1',
        name: 'patch',
        arguments: '',
      }),
      ...push({ type: 'tool_call', id: 'call_1', arguments: '*** Begin' }),
      ...closed('whole'),
    ].map(({ type }) => type),
  ).toEqual([
    'response.output_item.added',
    'response.custom_tool_call_input.delta',
    'response.custom_tool_call_input.done',
    'response.output_item.done',
  ]);
  expect(output).toEqual([
    {
      id: 'ctc_r1_0',
      type: 'custom_tool_call',
      call_id: 'call_1',
      name: 'patch',
      input: '*** Begin',
    },
  ]);
});

test("this API's own output item is passed on whole, in its place", () => {
  const { output, push } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'text', text: 'Searching.' });
  expect(
    push({
      type: 'provider',
      provider: {
        'openai.responses': {
          type: 'web_search_call',
          id: 'ws_1',
          status: 'completed',
        },
      },
    }).map(({ type }) => type),
  ).toEqual([
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.output_item.added',
    'response.output_item.done',
  ]);
  expect(output[1]).toEqual({
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
  });
});

test('a picture the model made is the item the image tool of this API answers with', () => {
  const { output, push } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  const item = {
    id: 'ig_r1_0',
    type: 'image_generation_call',
    status: 'completed',
    result: 'iVBORw0KGgo=',
  };
  expect(
    push({ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }),
  ).toEqual([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
  ]);
  expect(output).toEqual([item]);
});

test('a picture an upstream of this API made is written as the item it sent', () => {
  const { output, push } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  const item = {
    id: 'ig_tmp_n8qr5jchufl',
    type: 'image_generation_call',
    status: 'completed',
    result: 'data:image/png;base64,iVBORw0KGgo=',
  };
  expect(
    push({
      type: 'file',
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      provider: { 'openai.responses': item },
    }),
  ).toEqual([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
  ]);
  expect(output).toEqual([item]);
});

test('the writer writes nothing for what has no form: the reply is ended before', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: false,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    push({ type: 'provider', provider: { anthropic: { type: 'x' } } }),
  ).toEqual([]);
  expect(
    push({
      type: 'tool_call',
      id: 'srv_1',
      name: 'web_search',
      arguments: '{}',
      hosted: true,
    }),
  ).toEqual([]);
  expect(
    push({ type: 'tool_result', id: 'srv_1', output: 'x', hosted: true }),
  ).toEqual([]);
  expect(push({ type: 'file', url: 'https://example.com/out.pdf' })).toEqual(
    [],
  );
  expect(closed('whole')).toEqual([]);
  expect(output).toEqual([]);
});

test('a call the upstream marked as custom is written as one where no tool was declared', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [
      ...push({
        type: 'tool_call',
        id: 'call_1',
        name: 'exec',
        arguments: '',
        provider: { 'openai.responses': { type: 'custom_tool_call' } },
      }),
      ...push({ type: 'tool_call', id: 'call_1', arguments: '1+1\n' }),
      ...closed('whole'),
    ].map(({ type }) => type),
  ).toEqual([
    'response.output_item.added',
    'response.custom_tool_call_input.delta',
    'response.custom_tool_call_input.done',
    'response.output_item.done',
  ]);
  expect(output).toEqual([
    {
      id: 'ctc_r1_0',
      type: 'custom_tool_call',
      call_id: 'call_1',
      name: 'exec',
      input: '1+1\n',
    },
  ]);
});

test('a late chunk of a call adds nothing that was written for another family', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{' });
  push({
    type: 'tool_call',
    id: 'call_1',
    arguments: '}',
    provider: { 'openai.chat': { namespace: 'agents' } },
  });
  closed('whole');
  expect(output).toEqual([
    {
      id: 'fc_r1_0',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'weather',
      arguments: '{}',
    },
  ]);
});

test('each item is done in the place the upstream gave it, a call when its chunk says it ended', () => {
  const { push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  expect(
    [
      ...push({
        type: 'reasoning',
        text: '',
        block: 0,
        provider: {
          'openai.responses': { type: 'reasoning', id: 'rs_1', summary: [] },
        },
      }),
      ...push({
        type: 'tool_call',
        id: 'call_1',
        name: 'weather',
        arguments: '{}',
        ended: true,
        block: 1,
      }),
      ...push({
        type: 'provider',
        block: 2,
        provider: {
          'openai.responses': { type: 'web_search_call', id: 'ws_1' },
        },
      }),
      ...push({
        type: 'tool_call',
        id: 'call_2',
        name: 'exec',
        arguments: '1+1',
        ended: true,
        block: 3,
        provider: { 'openai.responses': { type: 'custom_tool_call' } },
      }),
      ...push({ type: 'text', text: 'Done.', block: 4 }),
      ...closed('whole'),
    ].flatMap(({ type, output_index: index, item }) =>
      type === 'response.output_item.done'
        ? [[index, typeof item === 'object' ? item : undefined]]
        : [],
    ),
  ).toMatchObject([
    [0, { type: 'reasoning' }],
    [1, { type: 'function_call', status: 'completed', arguments: '{}' }],
    [2, { type: 'web_search_call' }],
    [3, { type: 'custom_tool_call', input: '1+1' }],
    [4, { type: 'message', status: 'completed' }],
  ]);
});

test('calls in a row are each done as they end, with what the last chunk held, and the end of the reply adds nothing', () => {
  const { push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{"c' });
  expect(
    push({
      type: 'tool_call',
      id: 'call_1',
      arguments: '":1}',
      ended: true,
      provider: { 'openai.responses': { namespace: 'agents' } },
    }),
  ).toEqual([
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_r1_0',
      output_index: 0,
      delta: '":1}',
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: 'fc_r1_0',
      output_index: 0,
      arguments: '{"c":1}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        namespace: 'agents',
        id: 'fc_r1_0',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"c":1}',
      },
    },
  ]);
  push({ type: 'tool_call', id: 'call_2', name: 'time', arguments: '{}' });
  expect(
    push({ type: 'tool_call', id: 'call_2', arguments: '', ended: true }),
  ).toMatchObject([
    { type: 'response.function_call_arguments.done', arguments: '{}' },
    { type: 'response.output_item.done', output_index: 1 },
  ]);
  expect(closed('whole')).toEqual([]);
});

test('a call to a custom tool whose pieces come around text, with none said to be the last, is written whole when the reply ends', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(['patch']),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({
    type: 'tool_call',
    id: 'call_1',
    name: 'patch',
    arguments: '*** Begin',
  });
  expect(push({ type: 'text', text: 'Patching.' })).not.toContainEqual(
    expect.objectContaining({ type: 'response.output_item.done' }),
  );
  expect(
    push({ type: 'tool_call', id: 'call_1', arguments: '\n*** End' }),
  ).toEqual([
    {
      type: 'response.custom_tool_call_input.delta',
      item_id: 'ctc_r1_0',
      output_index: 0,
      delta: '\n*** End',
    },
  ]);
  expect(closed('whole')).toMatchObject([
    { type: 'response.output_text.done' },
    { type: 'response.content_part.done' },
    { type: 'response.output_item.done', output_index: 1 },
    {
      type: 'response.custom_tool_call_input.done',
      input: '*** Begin\n*** End',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'custom_tool_call', input: '*** Begin\n*** End' },
    },
  ]);
  expect(output).toHaveLength(2);
});

test('a call told more after it ended fails the reply, and an empty piece after its end adds nothing', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({
    type: 'tool_call',
    id: 'call_1',
    name: 'weather',
    arguments: '{}',
    ended: true,
  });
  expect(push({ type: 'tool_call', id: 'call_1', arguments: '' })).toEqual([]);
  expect(() =>
    push({ type: 'tool_call', id: 'call_1', arguments: '1}' }),
  ).toThrow(
    new Unsupported(
      'The Responses API cannot write a tool call that was told more after it ended',
    ),
  );
  expect(closed('failed')).toEqual([]);
  expect(output).toMatchObject([
    { type: 'function_call', call_id: 'call_1', arguments: '{}' },
  ]);
  expect(output).toHaveLength(1);
});

test('a call the upstream ended stays completed in a reply that failed, and the call still open is not', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({
    type: 'tool_call',
    id: 'call_1',
    name: 'weather',
    arguments: '{}',
    ended: true,
  });
  push({ type: 'tool_call', id: 'call_2', name: 'weather', arguments: '{"c' });

  closed('failed');

  expect(output).toMatchObject([
    { type: 'function_call', status: 'completed', arguments: '{}' },
    { type: 'function_call', status: 'incomplete', arguments: '{"c' },
  ]);
});

test('a field named as the prototype that a later chunk of a call holds is a field of its item', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{}' });
  push({
    type: 'tool_call',
    id: 'call_1',
    arguments: '',
    provider: {
      'openai.responses': { namespace: 'agents', ['__proto__']: { a: 1 } },
    },
  });
  closed('whole');

  expect(Object.entries(output[0] ?? {})).toEqual([
    ['id', 'fc_r1_0'],
    ['type', 'function_call'],
    ['call_id', 'call_1'],
    ['name', 'weather'],
    ['namespace', 'agents'],
    ['__proto__', { a: 1 }],
    ['status', 'completed'],
    ['arguments', '{}'],
  ]);
});

test('a function call that ended with no arguments is done with an empty object, and a custom call with no input and a call a failure broke off are left with none', () => {
  const { output, push, closed } = reply(
    {
      body: {},
      muted: true,
      custom: new Set(['patch']),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  push({ type: 'tool_call', id: 'call_1', name: 'now', arguments: '' });
  expect(
    push({ type: 'tool_call', id: 'call_1', arguments: '', ended: true }),
  ).toMatchObject([
    { type: 'response.function_call_arguments.done', arguments: '{}' },
    { type: 'response.output_item.done', item: { arguments: '{}' } },
  ]);
  push({ type: 'tool_call', id: 'call_2', name: 'today', arguments: '' });
  push({ type: 'tool_call', id: 'call_3', name: 'patch', arguments: '' });
  expect(closed('whole')).toMatchObject([
    { type: 'response.function_call_arguments.done', arguments: '{}' },
    { type: 'response.output_item.done', item: { arguments: '{}' } },
    { type: 'response.custom_tool_call_input.done', input: '' },
    { type: 'response.output_item.done', item: { input: '' } },
  ]);
  expect(output).toMatchObject([
    { arguments: '{}' },
    { arguments: '{}' },
    { input: '' },
  ]);

  const broken = reply(
    {
      body: {},
      muted: true,
      custom: new Set(),
      spaced: new Map(),
      clients: new Set(),
      encrypted: false,
    },
    'r1',
  );
  broken.push({ type: 'tool_call', id: 'call_1', name: 'now', arguments: '' });
  expect(broken.closed('failed')).toMatchObject([
    { type: 'response.function_call_arguments.done', arguments: '' },
    {
      type: 'response.output_item.done',
      item: { status: 'incomplete', arguments: '' },
    },
  ]);
});
