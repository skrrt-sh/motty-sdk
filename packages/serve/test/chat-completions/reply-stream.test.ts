import { expect, test } from 'bun:test';
import type { Json, Progress, StreamEvent } from '@mottyjs/core/host';
import { streamed } from '../../src/chat-completions/reply-stream.ts';

async function* run(...events: (StreamEvent | Progress)[]) {
  yield* events;
}

async function frames(
  events: AsyncIterable<StreamEvent | Progress>,
  given: { muted?: boolean; usage?: boolean } = {},
): Promise<Json[]> {
  const sent = await Array.fromAsync(
    streamed(events, {
      id: 'req_1',
      model: 'coder',
      muted: given.muted ?? false,
      usage: given.usage ?? false,
    }),
  );
  return sent.map(({ event, data }) => {
    expect(event).toBeUndefined();
    return data === '[DONE]' ? data : JSON.parse(data);
  });
}

test('text is sent as deltas, the role first, then the reason and the end', async () => {
  expect(
    await frames(
      run(
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'finish', reason: 'stop' },
      ),
    ),
  ).toEqual([
    {
      id: 'chatcmpl-req_1',
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'coder',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Hel' },
          logprobs: null,
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-req_1',
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'coder',
      choices: [
        {
          index: 0,
          delta: { content: 'lo' },
          logprobs: null,
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-req_1',
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'coder',
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
    },
    '[DONE]',
  ]);
});

test('progress and reasoning are sent under both names clients read', async () => {
  const sent = await frames(
    run(
      { type: 'progress', piece: 0, text: 'Routing to code' },
      { type: 'reasoning', text: 'A loop will do.' },
      { type: 'text', text: 'Use a loop.' },
      { type: 'finish', reason: 'stop' },
    ),
  );

  expect(sent).toMatchObject([
    {
      choices: [
        {
          delta: {
            role: 'assistant',
            reasoning: 'Routing to code',
            reasoning_content: 'Routing to code',
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            reasoning: '\nA loop will do.',
            reasoning_content: '\nA loop will do.',
          },
        },
      ],
    },
    { choices: [{ delta: { content: 'Use a loop.' } }] },
    { choices: [{ finish_reason: 'stop' }] },
    '[DONE]',
  ]);
});

test('tool call fragments are sent by index, id and name on the first', async () => {
  const sent = await frames(
    run(
      { type: 'tool_call', id: 'call_a', name: 'weather', arguments: '' },
      { type: 'tool_call', id: 'call_a', arguments: '{"city":' },
      { type: 'tool_call', id: 'call_b', name: 'now', arguments: '{}' },
      { type: 'tool_call', id: 'call_a', arguments: '"Oslo"}' },
      { type: 'finish', reason: 'tool_calls' },
    ),
  );

  expect(sent).toMatchObject([
    {
      choices: [
        {
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_a',
                type: 'function',
                function: { name: 'weather', arguments: '' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"city":' } }],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 1,
                id: 'call_b',
                type: 'function',
                function: { name: 'now', arguments: '{}' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]);
});

test('a refusal, logprobs, a citation and sound each have their field', async () => {
  const token = {
    token: 'No',
    logprob: -0.2,
    bytes: [78, 111],
    top_logprobs: [],
  };
  const sent = await frames(
    run(
      {
        type: 'text',
        text: 'No',
        provider: { 'openai.chat': { logprobs: [token] } },
      },
      {
        type: 'refusal',
        text: 'No',
        provider: { 'openai.chat': { logprobs: [token] } },
      },
      { type: 'citation', title: 'Oslo', url: 'https://x.test/oslo' },
      {
        type: 'provider',
        provider: { 'openai.chat': { audio: { transcript: 'No' } } },
      },
      { type: 'finish', reason: 'stop' },
    ),
  );

  expect(sent).toMatchObject([
    {
      choices: [
        {
          delta: { content: 'No' },
          logprobs: { content: [token], refusal: null },
        },
      ],
    },
    {
      choices: [
        {
          delta: { refusal: 'No' },
          logprobs: { content: null, refusal: [token] },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            annotations: [
              {
                type: 'url_citation',
                url_citation: {
                  start_index: 2,
                  end_index: 2,
                  title: 'Oslo',
                  url: 'https://x.test/oslo',
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: { audio: { transcript: 'No' } } }] },
    { choices: [{ finish_reason: 'stop' }] },
    '[DONE]',
  ]);
});

test('usage is sent in its own chunk before the end when it was asked for', async () => {
  const sent = await frames(
    run(
      { type: 'text', text: 'Hi' },
      {
        type: 'finish',
        reason: 'length',
        usage: { input: 12, output: 1, cached: 8, reasoning: 0 },
      },
    ),
    { usage: true },
  );

  expect(sent).toMatchObject([
    { choices: [{ delta: { content: 'Hi' } }], usage: null },
    { choices: [{ delta: {}, finish_reason: 'length' }], usage: null },
    {
      id: 'chatcmpl-req_1',
      object: 'chat.completion.chunk',
      model: 'coder',
      choices: [],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 1,
        total_tokens: 13,
        prompt_tokens_details: { cached_tokens: 8 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    },
    '[DONE]',
  ]);
});

test('usage is not sent to a caller who did not ask, nor made up', async () => {
  const unasked = await frames(
    run({ type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } }),
  );
  const unreported = await frames(run({ type: 'finish', reason: 'stop' }), {
    usage: true,
  });

  expect(unasked).toHaveLength(2);
  expect(unasked[0]).not.toHaveProperty('usage');
  expect(unreported).toMatchObject([
    { choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop' }] },
    '[DONE]',
  ]);
});

test('reasons this wire lacks are sent as a stop, with the upstream`s fields', async () => {
  const [paused] = await frames(
    run({
      type: 'finish',
      reason: 'pause',
      provider: {
        'openai.chat': { system_fingerprint: 'fp_1', service_tier: 'flex' },
      },
    }),
  );

  expect(paused).toMatchObject({
    system_fingerprint: 'fp_1',
    service_tier: 'flex',
    choices: [{ finish_reason: 'stop' }],
  });
});

test('a failure in the middle ends the stream on an error frame, not done', async () => {
  const sent = await frames(
    run(
      { type: 'text', text: 'Hel' },
      {
        type: 'error',
        error: {
          code: 'overloaded',
          status: 503,
          message: 'The upstream is overloaded',
          upstream: true,
        },
      },
    ),
  );

  expect(sent).toEqual([
    expect.objectContaining({ object: 'chat.completion.chunk' }),
    {
      error: {
        message: 'The upstream is overloaded',
        type: 'service_unavailable_error',
        param: null,
        code: 'server_is_overloaded',
      },
    },
  ]);
});

test('nothing is read from the run after its terminal event', async () => {
  let read = 0;
  async function* counting() {
    for (const event of [
      { type: 'finish', reason: 'stop' },
      { type: 'text', text: 'late' },
    ] satisfies StreamEvent[]) {
      read++;
      yield event;
    }
  }

  const sent = await frames(counting());

  expect(read).toBe(1);
  expect(sent).toHaveLength(2);
});

test('reasoning details are sent on as they came, beside the text or alone', async () => {
  const sent = await frames(
    run(
      {
        type: 'reasoning',
        text: 'Pa',
        provider: {
          'openai.chat': {
            reasoning_details: [
              { type: 'reasoning.text', text: 'Pa', index: 0 },
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
              { type: 'reasoning.text', signature: 'EqQB', index: 0 },
            ],
          },
        },
      },
      { type: 'text', text: 'Paris' },
      { type: 'finish', reason: 'stop' },
    ),
  );

  expect(sent).toMatchObject([
    {
      choices: [
        {
          delta: {
            role: 'assistant',
            reasoning: 'Pa',
            reasoning_content: 'Pa',
            reasoning_details: [
              { type: 'reasoning.text', text: 'Pa', index: 0 },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            reasoning_details: [
              { type: 'reasoning.text', signature: 'EqQB', index: 0 },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: { content: 'Paris' } }] },
    { choices: [{ finish_reason: 'stop' }] },
    '[DONE]',
  ]);
  expect(JSON.stringify(sent[1])).not.toContain('"reasoning":');
});

test('a caller who muted reasoning is sent no details of it', async () => {
  const sent = await frames(
    run(
      {
        type: 'reasoning',
        text: '',
        provider: {
          'openai.chat': {
            reasoning_details: [
              { type: 'reasoning.text', signature: 'EqQB', index: 0 },
            ],
          },
        },
      },
      { type: 'text', text: 'Paris' },
      { type: 'finish', reason: 'stop' },
    ),
    { muted: true },
  );

  expect(JSON.stringify(sent)).not.toContain('reasoning');
});

test('a picture a model made is sent in a delta of its own field', async () => {
  expect(
    await frames(
      run(
        { type: 'text', text: 'Here it is.' },
        { type: 'file', data: 'iVBORw0=', mediaType: 'image/png' },
        { type: 'finish', reason: 'stop' },
      ),
    ),
  ).toMatchObject([
    { choices: [{ delta: { role: 'assistant', content: 'Here it is.' } }] },
    {
      choices: [
        {
          delta: {
            images: [
              {
                type: 'image_url',
                image_url: { url: 'data:image/png;base64,iVBORw0=' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]);
});

test('what a tool call came with is sent on the fragment that holds it, where it sat', async () => {
  const [first, second] = await frames(
    run(
      {
        type: 'tool_call',
        id: 'call_a',
        name: 'weather',
        arguments: '',
        provider: {
          'openai.chat': {
            extra_content: { google: { thought_signature: 'c2ln' } },
            function: { signature: 'c2ln' },
          },
        },
      },
      { type: 'tool_call', id: 'call_a', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls' },
    ),
  );

  expect(first).toMatchObject({
    choices: [
      {
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              extra_content: { google: { thought_signature: 'c2ln' } },
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { signature: 'c2ln', name: 'weather', arguments: '' },
            },
          ],
        },
      },
    ],
  });
  expect(second).toMatchObject({
    choices: [
      { delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } },
    ],
  });
  expect(JSON.stringify(second)).not.toContain('c2ln');
});

test.each([[{ function: { name: 'stray' } }]])(
  'a carried field the call has of its own is not written on a fragment that does not open it: %j',
  async (carried) => {
    const [, second] = await frames(
      run(
        { type: 'tool_call', id: 'call_a', name: 'weather', arguments: '' },
        {
          type: 'tool_call',
          id: 'call_a',
          arguments: '{}',
          provider: { 'openai.chat': carried },
        },
        { type: 'finish', reason: 'tool_calls' },
      ),
    );

    expect(second).toMatchObject({
      choices: [
        {
          delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
        },
      ],
    });
    expect(JSON.stringify(second)).not.toContain('stray');
  },
);

test.each([
  [
    { type: 'custom', custom: { arguments: 'stray', input: 'stray' } },
    { type: 'custom', custom: { name: 'shell', input: 'ls' } },
  ],
])(
  'a carried field never takes the place of the call`s own on the fragment that opens it: %j',
  async (carried, call) => {
    const [first] = await frames(
      run(
        {
          type: 'tool_call',
          id: 'call_a',
          name: 'shell',
          arguments: 'ls',
          provider: { 'openai.chat': carried },
        },
        { type: 'finish', reason: 'tool_calls' },
      ),
    );

    expect(first).toMatchObject({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{ index: 0, id: 'call_a', ...call }],
          },
        },
      ],
    });
    expect(JSON.stringify(first)).not.toContain('stray');
  },
);
