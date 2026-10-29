import { expect, test } from 'bun:test';
import { events } from '../../src/responses/events.ts';

async function* sse(...sent: { type: string; [field: string]: unknown }[]) {
  for (const event of sent) {
    yield { event: event.type, data: JSON.stringify(event) };
  }
}

test('text deltas become text, and the completed response the finish', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.created',
            sequence_number: 0,
            response: { id: 'resp_1', status: 'in_progress' },
          },
          {
            type: 'response.output_item.added',
            sequence_number: 1,
            output_index: 0,
            item: {
              id: 'msg_1',
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          },
          {
            type: 'response.content_part.added',
            sequence_number: 2,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          {
            type: 'response.output_text.delta',
            sequence_number: 3,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'Hel',
          },
          {
            type: 'response.output_text.delta',
            sequence_number: 4,
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'lo',
          },
          {
            type: 'response.output_item.done',
            sequence_number: 5,
            output_index: 0,
            item: {
              id: 'msg_1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                { type: 'output_text', text: 'Hello', annotations: [] },
              ],
            },
          },
          {
            type: 'response.completed',
            sequence_number: 6,
            response: {
              id: 'resp_1',
              model: 'gpt-5-2025-08-07',
              status: 'completed',
              usage: {
                input_tokens: 12,
                input_tokens_details: {
                  cached_tokens: 8,
                  cache_write_tokens: 2,
                },
                output_tokens: 5,
                output_tokens_details: { reasoning_tokens: 3 },
                total_tokens: 17,
              },
            },
          },
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel', block: 0 },
    { type: 'text', text: 'lo', block: 0 },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'completed',
      id: 'resp_1',
      model: 'gpt-5-2025-08-07',
      usage: { input: 12, output: 5, cached: 8, cacheWrite: 2, reasoning: 3 },
    },
  ]);
});

test('a reasoning item is passed on whole, with its summary as reasoning', async () => {
  const item = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [
      { type: 'summary_text', text: 'Plan.' },
      { type: 'summary_text', text: 'Act.' },
    ],
    encrypted_content: 'gAAAAABo',
  };
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'rs_1', type: 'reasoning', summary: [] },
          },
          {
            type: 'response.reasoning_summary_part.added',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          },
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 0,
            delta: 'Plan.',
          },
          {
            type: 'response.reasoning_summary_part.added',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 1,
            part: { type: 'summary_text', text: '' },
          },
          {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_1',
            output_index: 0,
            summary_index: 1,
            delta: 'Act.',
          },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: {
        'openai.responses': { id: 'rs_1', type: 'reasoning', summary: [] },
      },
    },
    {
      type: 'reasoning',
      text: 'Plan.',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    },
    {
      type: 'reasoning',
      text: '\n\n',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    },
    {
      type: 'reasoning',
      text: 'Act.',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    },
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { 'openai.responses': item },
    },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('a reasoning item sent whole is read in full, each kind of part joined by paragraph', async () => {
  const item = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [
      { type: 'summary_text', text: 'Plan.' },
      { type: 'summary_text', text: 'Act.' },
    ],
    content: [{ type: 'reasoning_text', text: 'Paris is at 48.86N.' }],
  };
  expect(
    await Array.fromAsync(
      events(
        sse(
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { id: 'rs_2', type: 'reasoning', summary: [] },
          },
          {
            type: 'response.reasoning_text.delta',
            output_index: 1,
            content_index: 0,
            delta: 'One.',
          },
          {
            type: 'response.content_part.added',
            output_index: 1,
            content_index: 1,
            part: { type: 'reasoning_text', text: '' },
          },
          {
            type: 'response.reasoning_text.delta',
            output_index: 1,
            content_index: 1,
            delta: 'Two.',
          },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'reasoning',
      text: 'Plan.\n\nAct.',
      block: 0,
      provider: { 'openai.responses': { type: 'summary_text' } },
    },
    {
      type: 'reasoning',
      text: 'Paris is at 48.86N.',
      block: 0,
      provider: { 'openai.responses': { type: 'reasoning_text' } },
    },
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { 'openai.responses': item },
    },
    {
      type: 'reasoning',
      text: '',
      block: 1,
      provider: {
        'openai.responses': { id: 'rs_2', type: 'reasoning', summary: [] },
      },
    },
    {
      type: 'reasoning',
      text: 'One.',
      block: 1,
      provider: { 'openai.responses': { type: 'reasoning_text' } },
    },
    {
      type: 'reasoning',
      text: '\n\n',
      block: 1,
      provider: { 'openai.responses': { type: 'reasoning_text' } },
    },
    {
      type: 'reasoning',
      text: 'Two.',
      block: 1,
      provider: { 'openai.responses': { type: 'reasoning_text' } },
    },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('argument deltas are fragments of one call, and a call ends in tool_calls', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'in_progress',
              call_id: 'call_1',
              name: 'weather',
              arguments: '',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 1,
            delta: '{"city"',
          },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_1',
            output_index: 1,
            delta: ':"Oslo"}',
          },
          {
            type: 'response.function_call_arguments.done',
            item_id: 'fc_1',
            output_index: 1,
            arguments: '{"city":"Oslo"}',
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_1',
              name: 'weather',
              arguments: '{"city":"Oslo"}',
            },
          },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'weather',
      arguments: '',
      block: 1,
    },
    { type: 'tool_call', id: 'call_1', arguments: '{"city"', block: 1 },
    { type: 'tool_call', id: 'call_1', arguments: ':"Oslo"}', block: 1 },
    {
      type: 'tool_call',
      id: 'call_1',
      arguments: '',
      ended: true,
      block: 1,
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
  ]);
});

test('an item sent whole, with no deltas before it, is still read in full, a custom call marked and a function call not', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              content: [
                { type: 'output_text', text: 'Hello', annotations: [] },
                { type: 'refusal', refusal: 'No more.' },
              ],
            },
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'custom_tool_call',
              call_id: 'call_1',
              name: 'patch',
              input: '*** Begin',
            },
          },
          {
            type: 'response.output_item.done',
            output_index: 2,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_2',
              arguments: '{}',
              name: 'time',
            },
          },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'text',
      text: 'Hello',
      block: 0,
      provider: { 'openai.responses': { phase: 'final_answer' } },
    },
    { type: 'refusal', text: 'No more.', block: 0 },
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'patch',
      arguments: '*** Begin',
      ended: true,
      block: 1,
      provider: { 'openai.responses': { type: 'custom_tool_call' } },
    },
    {
      type: 'tool_call',
      id: 'call_2',
      name: 'time',
      arguments: '{}',
      ended: true,
      block: 2,
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
  ]);
});

test('a picture the model made is a file, and its item stays this family`s own', async () => {
  const routed = {
    id: 'ig_tmp_n8qr5jchufl',
    type: 'image_generation_call',
    status: 'completed',
    result: 'data:image/png;base64,iVBORw0KGgo=',
  };
  const untyped = {
    id: 'ig_2',
    type: 'image_generation_call',
    status: 'completed',
    result: 'iVBORw0KGgo=',
  };
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'ig_tmp_n8qr5jchufl',
              type: 'image_generation_call',
              status: 'in_progress',
              result: null,
            },
          },
          {
            type: 'response.image_generation_call.generating',
            output_index: 0,
            item_id: 'ig_tmp_n8qr5jchufl',
          },
          { type: 'response.output_item.done', output_index: 0, item: routed },
          { type: 'response.output_item.done', output_index: 1, item: untyped },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'file',
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      block: 0,
      provider: { 'openai.responses': routed },
    },
    // The upstream named no type, and the bytes begin as a PNG does.
    {
      type: 'file',
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      block: 1,
      provider: { 'openai.responses': untyped },
    },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test.each([
  ['image/jpeg', '/9j/4AAQSkZJRgABAQAAAQ=='],
  ['image/gif', 'R0lGODdhAQABAIAAAAAAAA=='],
  ['image/webp', 'UklGRiQAAABXRUJQVlA4IA=='],
])(
  'bare bytes of a picture with no format named are %s by how they begin',
  async (mediaType, result) => {
    const item = { id: 'ig_1', type: 'image_generation_call', result };
    expect(
      await Array.fromAsync(
        events(
          sse(
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { status: 'completed' } },
          ),
        ),
      ),
    ).toMatchObject([
      {
        type: 'file',
        data: result,
        mediaType,
        provider: { 'openai.responses': item },
      },
      { type: 'finish' },
    ]);
  },
);

test.each([
  ['sound in the container a WebP is in', 'UklGRiQAAABXQVZFZm10IA=='],
  ['no bytes', ''],
])(
  'bare bytes of %s are given no type, and the item stays opaque',
  async (_, result) => {
    const item = { id: 'ig_1', type: 'image_generation_call', result };
    expect(
      await Array.fromAsync(
        events(
          sse(
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: { status: 'completed' } },
          ),
        ),
      ),
    ).toMatchObject([
      { type: 'provider', block: 0, provider: { 'openai.responses': item } },
      { type: 'finish' },
    ]);
  },
);

test('a format the upstream named is the type, whatever the bytes begin as', async () => {
  const item = {
    id: 'ig_1',
    type: 'image_generation_call',
    output_format: 'jpeg',
    result: 'iVBORw0KGgo=',
  };
  expect(
    await Array.fromAsync(
      events(
        sse(
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { status: 'completed' } },
        ),
      ),
    ),
  ).toMatchObject([
    { type: 'file', mediaType: 'image/jpeg' },
    { type: 'finish' },
  ]);
});

test('the first text of a message says its phase', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', phase: 'commentary' },
          },
          { type: 'response.output_text.delta', output_index: 0, delta: 'A' },
          { type: 'response.output_text.delta', output_index: 0, delta: 'B' },
          { type: 'response.refusal.delta', output_index: 0, delta: 'No.' },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'text',
      text: 'A',
      block: 0,
      provider: { 'openai.responses': { phase: 'commentary' } },
    },
    { type: 'text', text: 'B', block: 0 },
    { type: 'refusal', text: 'No.', block: 0 },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('a phase told only as the item ends, after its text, is told in text that is empty', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', content: [] },
          },
          { type: 'response.output_text.delta', output_index: 0, delta: 'a' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              phase: 'commentary',
              content: [{ type: 'output_text', text: 'a', annotations: [] }],
            },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'a', block: 0 },
    {
      type: 'text',
      text: '',
      block: 0,
      provider: { 'openai.responses': { phase: 'commentary' } },
    },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('a phase is told before a citation that comes ahead of the text, and once', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', phase: 'commentary' },
          },
          {
            type: 'response.output_text.annotation.added',
            output_index: 0,
            annotation: { type: 'url_citation', url: 'https://x.test' },
          },
          { type: 'response.output_text.delta', output_index: 0, delta: 'a' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'message', role: 'assistant', phase: 'commentary' },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'text',
      text: '',
      block: 0,
      provider: { 'openai.responses': { phase: 'commentary' } },
    },
    {
      type: 'citation',
      url: 'https://x.test',
      block: 0,
      provider: {
        'openai.responses': { type: 'url_citation', url: 'https://x.test' },
      },
    },
    { type: 'text', text: 'a', block: 0 },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('an annotation is a citation, and an item of no known kind is passed on', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { id: 'ws_1', type: 'web_search_call', status: 'completed' },
          },
          {
            type: 'response.output_text.annotation.added',
            output_index: 1,
            content_index: 0,
            annotation_index: 0,
            annotation: {
              type: 'url_citation',
              url: 'https://x.test',
              title: 'Docs',
              start_index: 0,
              end_index: 4,
            },
          },
          { type: 'response.web_search_call.searching', output_index: 0 },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'provider',
      block: 0,
      provider: {
        'openai.responses': {
          id: 'ws_1',
          type: 'web_search_call',
          status: 'completed',
        },
      },
    },
    {
      type: 'citation',
      url: 'https://x.test',
      title: 'Docs',
      block: 1,
      provider: {
        'openai.responses': {
          type: 'url_citation',
          url: 'https://x.test',
          title: 'Docs',
          start_index: 0,
          end_index: 4,
        },
      },
    },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('an incomplete response finishes with the reason it was cut for', async () => {
  const last = async (reason?: string) =>
    (
      await Array.fromAsync(
        events(
          sse({
            type: 'response.incomplete',
            response: {
              id: 'resp_1',
              status: 'incomplete',
              incomplete_details: reason === undefined ? null : { reason },
              usage: { input_tokens: 3, output_tokens: 64 },
            },
          }),
        ),
      )
    ).at(-1);
  expect(await last('max_output_tokens')).toEqual({
    type: 'finish',
    reason: 'length',
    rawReason: 'max_output_tokens',
    id: 'resp_1',
    usage: { input: 3, output: 64 },
    provider: {
      'openai.responses': {
        incomplete_details: { reason: 'max_output_tokens' },
      },
    },
  });
  expect(await last('content_filter')).toMatchObject({
    reason: 'content_filter',
    rawReason: 'content_filter',
  });
  expect(await last('steered')).toMatchObject({
    reason: 'other',
    rawReason: 'steered',
  });
  expect(await last()).toEqual({
    type: 'finish',
    reason: 'other',
    rawReason: 'incomplete',
    id: 'resp_1',
    usage: { input: 3, output: 64 },
  });
});

test('of what a response says beside what is read, only what tells the outcome rides on its finish', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse({
          type: 'response.completed',
          response: {
            end_turn: false,
            incomplete_details: null,
            service_tier: 'priority',
            prompt_cache_key: 'k',
            safety_identifier: 's',
            made_up: { a: [1] },
          },
        }),
      ),
    ),
  ).toEqual([
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'completed',
      provider: { 'openai.responses': { end_turn: false } },
    },
  ]);
});

test('a piece of a call that comes after its item was done is not read', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', call_id: 'call_1', name: 'time' },
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              call_id: 'call_1',
              name: 'time',
              arguments: '{"x":',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '1}',
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    { type: 'tool_call', id: 'call_1', name: 'time', arguments: '', block: 0 },
    {
      type: 'tool_call',
      id: 'call_1',
      arguments: '{"x":',
      ended: true,
      block: 0,
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
  ]);
});

test('a failed response is the one error that ends the stream', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          { type: 'response.output_text.delta', output_index: 0, delta: 'Hel' },
          {
            type: 'response.failed',
            response: {
              id: 'resp_1',
              status: 'failed',
              error: {
                code: 'rate_limit_exceeded',
                message: 'Rate limit reached for gpt-5',
              },
              usage: { input_tokens: 3, output_tokens: 1 },
            },
          },
          { type: 'response.output_text.delta', output_index: 0, delta: 'lo' },
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel', block: 0 },
    {
      type: 'error',
      error: {
        code: 'rate_limited',
        message: 'Rate limit reached for gpt-5',
        provider: { 'openai.responses': { code: 'rate_limit_exceeded' } },
        upstream: true,
      },
      usage: { input: 3, output: 1 },
    },
  ]);
});

test('an error event ends the stream, flat or wrapped', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse({
          type: 'error',
          sequence_number: 1,
          code: 'context_length_exceeded',
          message: 'Your input exceeds the context window',
          param: 'input',
        }),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'context_too_long',
        message: 'Your input exceeds the context window',
        provider: {
          'openai.responses': {
            code: 'context_length_exceeded',
            param: 'input',
          },
        },
        upstream: true,
      },
    },
  ]);
  expect(
    await Array.fromAsync(
      events(
        sse({
          type: 'error',
          error: { type: 'server_error', message: 'The server had an error' },
        }),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The server had an error',
        provider: { 'openai.responses': { type: 'server_error' } },
        upstream: true,
      },
    },
  ]);
});

test('a stream that ends with no ending is ended with an error', async () => {
  async function* done() {
    yield { data: '[DONE]' };
    yield { data: '{"type":"response.completed","response":{}}' };
  }
  const delta = { type: 'response.output_text.delta', output_index: 0 };
  for (const stream of [sse({ ...delta, delta: 'H' }), sse(), done()]) {
    expect((await Array.fromAsync(events(stream))).at(-1)).toEqual({
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream closed the stream before it finished',
        retryable: true,
        upstream: true,
      },
    });
  }
});

test('a frame that cannot be read ends the stream with an error', async () => {
  async function* frames(data: string) {
    yield { data: '{"type":"response.output_text.delta","delta":"H"}' };
    yield { data };
    yield { data: '{"type":"response.completed","response":{}}' };
  }
  for (const data of [
    '{"type":"response.out',
    '[1,2]',
    '"x"',
    '',
    `{"type":"response.output_item.done","output_index":0,"item":{"type":"future","held":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`,
  ]) {
    expect(await Array.fromAsync(events(frames(data)))).toEqual([
      { type: 'text', text: 'H', block: 0 },
      {
        type: 'error',
        error: {
          code: 'upstream_failed',
          message: 'The upstream sent an event that cannot be read',
          retryable: true,
          upstream: true,
        },
      },
    ]);
  }
});

test('an event of a kind not known is passed over', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          { type: 'response.queued', response: {} },
          { type: 'response.audio.delta', delta: 'UklGRg==' },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([{ type: 'finish', reason: 'stop', rawReason: 'completed' }]);
  async function* untyped() {
    yield { data: '{"delta":"x"}' };
    yield { data: '{"type":"response.completed","response":{}}' };
  }
  expect(await Array.fromAsync(events(untyped()))).toEqual([
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('the cost a router reports is read', async () => {
  const [finish] = await Array.fromAsync(
    events(
      sse({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 15, output_tokens: 2, cost: 0.0000023 },
        },
      }),
    ),
  );

  expect(finish).toMatchObject({
    type: 'finish',
    usage: { input: 15, output: 2, cost: 0.0000023 },
  });
});

test('a message sent whole, with no deltas before it, keeps its annotations', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'Oslo.',
                  annotations: [
                    {
                      type: 'url_citation',
                      url: 'https://x.test',
                      title: 'Docs',
                      start_index: 0,
                      end_index: 4,
                    },
                  ],
                },
              ],
            },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Oslo.', block: 0 },
    {
      type: 'citation',
      url: 'https://x.test',
      title: 'Docs',
      block: 0,
      provider: {
        'openai.responses': {
          type: 'url_citation',
          url: 'https://x.test',
          title: 'Docs',
          start_index: 0,
          end_index: 4,
        },
      },
    },
    { type: 'finish', reason: 'stop', rawReason: 'completed' },
  ]);
});

test('a call whose arguments come only with its end says what else its item held at its start', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            item: {
              id: 'fc_000ee',
              type: 'function_call',
              status: 'in_progress',
              arguments: '',
              call_id: 'call_BeCk',
              name: 'spawn_agent',
              namespace: 'multi_agent_v1',
            },
            output_index: 0,
          },
          {
            type: 'response.function_call_arguments.done',
            arguments: '{"message":"say hi"}',
            item_id: 'fc_000ee',
            output_index: 0,
          },
          {
            type: 'response.output_item.done',
            item: {
              id: 'fc_000ee',
              type: 'function_call',
              status: 'completed',
              arguments: '{"message":"say hi"}',
              call_id: 'call_BeCk',
              name: 'spawn_agent',
              namespace: 'multi_agent_v1',
            },
            output_index: 0,
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'call_BeCk',
      name: 'spawn_agent',
      arguments: '',
      block: 0,
      provider: { 'openai.responses': { namespace: 'multi_agent_v1' } },
    },
    {
      type: 'tool_call',
      id: 'call_BeCk',
      arguments: '{"message":"say hi"}',
      ended: true,
      block: 0,
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
  ]);
});

test('the end of a call that holds more than its opening told says what it holds', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'in_progress',
              arguments: '',
              call_id: 'call_1',
              name: 'spawn_agent',
              caller: 'model',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '{}',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              arguments: '{}',
              call_id: 'call_1',
              name: 'spawn_agent',
              caller: 'model',
              namespace: 'agents',
            },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'spawn_agent',
      arguments: '',
      block: 0,
      provider: { 'openai.responses': { caller: 'model' } },
    },
    { type: 'tool_call', id: 'call_1', arguments: '{}', block: 0 },
    {
      type: 'tool_call',
      id: 'call_1',
      arguments: '',
      ended: true,
      block: 0,
      provider: {
        'openai.responses': { caller: 'model', namespace: 'agents' },
      },
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
  ]);
});

test('a piece of a call that comes before its item waits for it, and goes out under its id and name', async () => {
  expect(
    await Array.fromAsync(
      events(
        sse(
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: '{"a"',
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'in_progress',
              arguments: '',
              call_id: 'call_REAL',
              name: 'f',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            delta: ':1}',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              arguments: '{"a":1}',
              call_id: 'call_REAL',
              name: 'f',
            },
          },
          {
            type: 'response.custom_tool_call_input.delta',
            output_index: 1,
            delta: '1+',
          },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              id: 'ctc_1',
              type: 'custom_tool_call',
              status: 'completed',
              input: '1+1',
              call_id: 'call_2',
              name: 'exec',
            },
          },
          {
            type: 'response.function_call_arguments.delta',
            output_index: 2,
            delta: '{}',
          },
          {
            type: 'response.output_item.done',
            output_index: 2,
            item: { type: 'function_call', call_id: 'call_3', name: 'time' },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'call_REAL',
      name: 'f',
      arguments: '{"a"',
      block: 0,
    },
    { type: 'tool_call', id: 'call_REAL', arguments: ':1}', block: 0 },
    {
      type: 'tool_call',
      id: 'call_REAL',
      arguments: '',
      ended: true,
      block: 0,
    },
    {
      type: 'tool_call',
      id: 'call_2',
      name: 'exec',
      arguments: '1+1',
      ended: true,
      block: 1,
      provider: { 'openai.responses': { type: 'custom_tool_call' } },
    },
    {
      type: 'tool_call',
      id: 'call_3',
      name: 'time',
      arguments: '{}',
      ended: true,
      block: 2,
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
  ]);
});

test.each([
  [
    'completed',
    [{ type: 'tool_call', id: 'call_1', arguments: '', ended: true, block: 0 }],
  ],
  ['incomplete', []],
] as const)(
  'the end of a call that holds what its opening told and is %s says only whether the call is whole',
  async (status, whole) => {
    expect(
      await Array.fromAsync(
        events(
          sse(
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: 'fc_1',
                type: 'function_call',
                status: 'in_progress',
                arguments: '',
                call_id: 'call_1',
                name: 'spawn_agent',
                namespace: 'agents',
                caller: { kind: 'model', tools: ['a', { b: null }] },
              },
            },
            {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: '{}',
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'fc_1',
                type: 'function_call',
                status,
                arguments: '{}',
                call_id: 'call_1',
                name: 'spawn_agent',
                namespace: 'agents',
                caller: { kind: 'model', tools: ['a', { b: null }] },
              },
            },
            { type: 'response.completed', response: {} },
          ),
        ),
      ),
    ).toEqual([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'spawn_agent',
        arguments: '',
        block: 0,
        provider: {
          'openai.responses': {
            namespace: 'agents',
            caller: { kind: 'model', tools: ['a', { b: null }] },
          },
        },
      },
      { type: 'tool_call', id: 'call_1', arguments: '{}', block: 0 },
      ...whole,
      { type: 'finish', reason: 'tool_calls', rawReason: 'completed' },
    ]);
  },
);
