import { expect, test } from 'bun:test';
import type { Progress, StreamEvent } from '@mottyjs/core/host';
import { field } from '../../src/responses/fields.ts';
import { collected, streamed } from '../../src/responses/response.ts';
import { parsed } from '../../src/wire/json.ts';

async function* run(...events: (StreamEvent | Progress)[]) {
  yield* events;
}

test('a stream starts the response, numbers every event and completes it', async () => {
  const sent = await Array.fromAsync(
    streamed(
      { body: { model: 'coder' }, muted: true, custom: new Set() },
      run(
        { type: 'text', text: 'Hello.' },
        {
          type: 'finish',
          reason: 'stop',
          usage: { input: 12, output: 5, cached: 8, reasoning: 2 },
        },
      ),
      'r1',
    ),
  );
  expect(sent.map(({ event }) => event)).toEqual([
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  const read = sent.map(({ data }) => parsed(data));
  expect(read).toMatchObject(
    sent.map(({ event }, index) => ({ type: event, sequence_number: index })),
  );
  expect(read[0]).toMatchObject({
    response: { id: 'resp_r1', status: 'in_progress', output: [], usage: null },
  });
  expect(read.at(-1)).toMatchObject({
    type: 'response.completed',
    response: {
      id: 'resp_r1',
      object: 'response',
      status: 'completed',
      model: 'coder',
      error: null,
      incomplete_details: null,
      store: false,
      previous_response_id: null,
      output: [
        {
          id: 'msg_r1_0',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello.' }],
        },
      ],
      usage: {
        input_tokens: 12,
        input_tokens_details: { cached_tokens: 8 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 17,
      },
    },
  });
});

test('an answer cut short by length or by a filter is incomplete, with its reason', async () => {
  const last = async (reason: 'length' | 'content_filter') =>
    (
      await Array.fromAsync(
        streamed(
          { body: {}, muted: true, custom: new Set() },
          run({ type: 'text', text: 'Hel' }, { type: 'finish', reason }),
          'r1',
        ),
      )
    ).at(-1);
  expect(parsed((await last('length'))?.data ?? '')).toMatchObject({
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', status: 'incomplete' }],
    },
  });
  expect(parsed((await last('content_filter'))?.data ?? '')).toMatchObject({
    type: 'response.incomplete',
    response: {
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
    },
  });
});

test('every other end is a completed response', () => {
  for (const reason of ['stop', 'tool_calls', 'pause', 'other'] as const) {
    expect(
      collected(
        { body: {}, muted: true, custom: new Set() },
        [],
        {
          type: 'finish',
          reason,
        },
        'r1',
      ),
    ).toMatchObject({ status: 'completed', incomplete_details: null });
  }
});

test('an error after the stream started ends it as a failed response', async () => {
  const sent = await Array.fromAsync(
    streamed(
      { body: {}, muted: true, custom: new Set() },
      run(
        { type: 'text', text: 'Hel' },
        {
          type: 'error',
          error: {
            code: 'rate_limited',
            status: 429,
            message: 'The upstream rate limit was reached',
            upstream: true,
          },
          usage: { input: 3, output: 1 },
        },
      ),
      'r1',
    ),
  );
  expect(sent.map(({ event }) => event).slice(-4)).toEqual([
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.failed',
  ]);
  expect(parsed(sent.at(-1)?.data ?? '')).toMatchObject({
    type: 'response.failed',
    sequence_number: sent.length - 1,
    response: {
      status: 'failed',
      error: {
        code: 'rate_limit_exceeded',
        message: 'The upstream rate limit was reached',
      },
      output: [
        { type: 'message', status: 'incomplete', content: [{ text: 'Hel' }] },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    },
  });
  expect(parsed(sent.at(-2)?.data ?? '')).toMatchObject({
    type: 'response.output_item.done',
    item: { type: 'message', status: 'incomplete' },
  });
});

test('a collected reply that was cut off says which item did not finish', () => {
  expect(
    collected(
      { body: {}, muted: true, custom: new Set() },
      [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{"c' },
      ],
      { type: 'finish', reason: 'length' },
      'r1',
    ),
  ).toMatchObject({
    status: 'incomplete',
    output: [
      { type: 'message', status: 'completed' },
      { type: 'function_call', status: 'incomplete', arguments: '{"c' },
    ],
  });
});

test("a caller's own mistake is described in the failed response", async () => {
  const sent = await Array.fromAsync(
    streamed(
      { body: {}, muted: true, custom: new Set() },
      run({
        type: 'error',
        error: { code: 'empty_prompt', status: 400, message: 'Say something' },
      }),
      'r1',
    ),
  );
  expect(parsed(sent.at(-1)?.data ?? '')).toMatchObject({
    response: { error: { code: 'empty_prompt', message: 'Say something' } },
  });
});

test('a collected reply holds progress as reasoning, then the answer', () => {
  expect(
    collected(
      {
        body: { model: 'coder', reasoning: { summary: 'auto' } },
        muted: false,
        custom: new Set(),
      },
      [
        { type: 'progress', piece: 0, text: 'Routing' },
        { type: 'text', text: 'Hello.' },
        { type: 'tool_call', id: 'call_1', name: 'weather', arguments: '{}' },
      ],
      { type: 'finish', reason: 'tool_calls', usage: { input: 2 } },
      'r1',
    ),
  ).toMatchObject({
    id: 'resp_r1',
    status: 'completed',
    output: [
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Routing' }],
      },
      { type: 'message', content: [{ type: 'output_text', text: 'Hello.' }] },
      {
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{}',
      },
    ],
    usage: {
      input_tokens: 2,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  });
});

test('the response echoes what was asked, and usage not reported is null', () => {
  expect(
    collected(
      {
        body: {
          model: 'coder',
          instructions: 'Be brief.',
          max_output_tokens: 64,
          temperature: 0.2,
          top_p: 0.9,
          metadata: { ticket: 'T-1' },
          parallel_tool_calls: false,
          tool_choice: 'required',
          tools: [{ type: 'function', name: 'weather' }],
          reasoning: { effort: 'low', summary: 'auto' },
          text: { format: { type: 'json_object' } },
          truncation: 'auto',
          user: 'u_1',
        },
        muted: false,
        custom: new Set(),
      },
      [],
      { type: 'finish', reason: 'stop' },
      'r1',
    ),
  ).toMatchObject({
    instructions: 'Be brief.',
    max_output_tokens: 64,
    temperature: 0.2,
    top_p: 0.9,
    metadata: { ticket: 'T-1' },
    parallel_tool_calls: false,
    tool_choice: 'required',
    tools: [{ type: 'function', name: 'weather' }],
    reasoning: { effort: 'low', summary: 'auto' },
    text: { format: { type: 'json_object' } },
    truncation: 'auto',
    user: 'u_1',
    usage: null,
    output: [],
  });
  expect(
    collected(
      { body: {}, muted: true, custom: new Set() },
      [],
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cacheWrite: 4 },
      },
      'r1',
    ),
  ).toMatchObject({
    tool_choice: 'auto',
    tools: [],
    parallel_tool_calls: true,
    text: { format: { type: 'text' } },
    usage: {
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 },
    },
  });
});

test.each([
  [{ input: 15, output: 2, cost: 0.0000023 }, 0.0000023],
  [{ input: 15, output: 2 }, undefined],
])('the cost in usage %j is written under its name as %p', (usage, cost) => {
  expect(
    collected(
      { body: { model: 'coder' }, muted: false, custom: new Set() },
      [],
      { type: 'finish', reason: 'stop', usage },
      'r1',
    ),
  ).toMatchObject({
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17 },
  });
  expect(
    parsed(
      JSON.stringify(
        collected(
          { body: { model: 'coder' }, muted: false, custom: new Set() },
          [],
          { type: 'finish', reason: 'stop', usage },
          'r1',
        ),
      ),
    ),
  ).toMatchObject({ usage: cost === undefined ? {} : { cost } });
});

test('a field of a call that this API does not name reaches the caller, streamed and collected', async () => {
  const sent = await Array.fromAsync(
    streamed(
      { body: { model: 'coder' }, muted: true, custom: new Set() },
      run(
        {
          type: 'tool_call',
          id: 'call_1',
          name: 'spawn_agent',
          arguments: '{}',
          provider: { 'openai.responses': { made_up: { kept: true } } },
        },
        { type: 'finish', reason: 'tool_calls' },
      ),
      'r1',
    ),
  );
  expect(
    sent
      .filter(({ event }) => event?.startsWith('response.output_item.'))
      .map(({ data }) => parsed(data)),
  ).toMatchObject([
    {
      type: 'response.output_item.added',
      item: { id: 'fc_r1_0', status: 'in_progress', made_up: { kept: true } },
    },
    {
      type: 'response.output_item.done',
      item: { id: 'fc_r1_0', status: 'completed', made_up: { kept: true } },
    },
  ]);
  expect(
    collected(
      { body: { model: 'coder' }, muted: true, custom: new Set() },
      [
        {
          type: 'tool_call',
          id: 'call_1',
          name: 'spawn_agent',
          arguments: '{}',
          provider: { 'openai.responses': { made_up: { kept: true } } },
        },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'r1',
    ),
  ).toMatchObject({
    output: [
      {
        id: 'fc_r1_0',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'spawn_agent',
        made_up: { kept: true },
        arguments: '{}',
      },
    ],
  });
});

test('what a chunk carries never stands beside a field this API writes of a call, streamed and collected', async () => {
  const sent = await Array.fromAsync(
    streamed(
      { body: { model: 'coder' }, muted: true, custom: new Set() },
      run(
        {
          type: 'tool_call',
          id: 'call_1',
          name: 'exec',
          arguments: 'abc',
          provider: {
            'openai.responses': {
              type: 'custom_tool_call',
              id: 'ctc_up',
              call_id: 'call_up',
              name: 'other',
              arguments: 'LEAK',
              status: 'weird',
              input: 'LEAK',
              namespace: 'agents',
            },
          },
        },
        {
          type: 'tool_call',
          id: 'call_2',
          name: 'time',
          arguments: '{}',
          provider: {
            'openai.responses': {
              id: 'fc_up',
              status: 'weird',
              input: 'LEAK',
              arguments: 'LEAK',
              namespace: 'agents',
            },
          },
        },
        { type: 'finish', reason: 'tool_calls' },
      ),
      'r1',
    ),
  );
  expect(
    sent
      .filter(({ event }) => event?.startsWith('response.output_item.'))
      .map(({ data }) => field(parsed(data), 'item')),
  ).toEqual([
    {
      namespace: 'agents',
      id: 'ctc_r1_0',
      type: 'custom_tool_call',
      call_id: 'call_1',
      name: 'exec',
      input: '',
    },
    {
      namespace: 'agents',
      id: 'fc_r1_1',
      type: 'function_call',
      call_id: 'call_2',
      name: 'time',
      status: 'in_progress',
      arguments: '',
    },
    {
      namespace: 'agents',
      id: 'ctc_r1_0',
      type: 'custom_tool_call',
      call_id: 'call_1',
      name: 'exec',
      input: 'abc',
    },
    {
      namespace: 'agents',
      id: 'fc_r1_1',
      type: 'function_call',
      call_id: 'call_2',
      name: 'time',
      status: 'completed',
      arguments: '{}',
    },
  ]);
  expect(
    field(
      collected(
        { body: { model: 'coder' }, muted: true, custom: new Set() },
        [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'exec',
            arguments: 'abc',
            provider: {
              'openai.responses': {
                type: 'custom_tool_call',
                arguments: 'LEAK',
                status: 'weird',
              },
            },
          },
          {
            type: 'tool_call',
            id: 'call_2',
            name: 'time',
            arguments: '{}',
            provider: { 'openai.responses': { input: 'LEAK' } },
          },
        ],
        { type: 'finish', reason: 'tool_calls' },
        'r1',
      ),
      'output',
    ),
  ).toEqual([
    {
      id: 'ctc_r1_0',
      type: 'custom_tool_call',
      call_id: 'call_1',
      name: 'exec',
      input: 'abc',
    },
    {
      id: 'fc_r1_1',
      type: 'function_call',
      call_id: 'call_2',
      name: 'time',
      status: 'completed',
      arguments: '{}',
    },
  ]);
});

test('a field of a call told after its opening is in the item as done, streamed and collected', async () => {
  const sent = await Array.fromAsync(
    streamed(
      { body: { model: 'coder' }, muted: true, custom: new Set() },
      run(
        { type: 'tool_call', id: 'call_1', name: 'spawn_agent', arguments: '' },
        { type: 'tool_call', id: 'call_1', arguments: '{}' },
        {
          type: 'tool_call',
          id: 'call_1',
          arguments: '',
          provider: {
            'openai.responses': {
              namespace: 'agents',
              type: 'custom_tool_call',
              id: 'fc_up',
              status: 'weird',
              input: 'LEAK',
            },
          },
        },
        { type: 'finish', reason: 'tool_calls' },
      ),
      'r1',
    ),
  );
  expect(
    sent
      .filter(({ event }) => event?.startsWith('response.output_item.'))
      .map(({ data }) => field(parsed(data), 'item')),
  ).toEqual([
    {
      id: 'fc_r1_0',
      type: 'function_call',
      call_id: 'call_1',
      name: 'spawn_agent',
      status: 'in_progress',
      arguments: '',
    },
    {
      id: 'fc_r1_0',
      type: 'function_call',
      call_id: 'call_1',
      name: 'spawn_agent',
      namespace: 'agents',
      status: 'completed',
      arguments: '{}',
    },
  ]);
  expect(
    field(
      collected(
        { body: { model: 'coder' }, muted: true, custom: new Set() },
        [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'spawn_agent',
            arguments: '',
          },
          {
            type: 'tool_call',
            id: 'call_1',
            arguments: '{}',
            provider: { 'openai.responses': { namespace: 'agents' } },
          },
        ],
        { type: 'finish', reason: 'tool_calls' },
        'r1',
      ),
      'output',
    ),
  ).toEqual([
    {
      id: 'fc_r1_0',
      type: 'function_call',
      call_id: 'call_1',
      name: 'spawn_agent',
      namespace: 'agents',
      status: 'completed',
      arguments: '{}',
    },
  ]);
});
