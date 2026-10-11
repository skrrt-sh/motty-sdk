import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import { decode } from '../../src/chat-completions/decode.ts';

test('a request is read into its model, messages, tools and options', () => {
  const { request, stream } = decode({
    model: 'coder',
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'What is the weather in Oslo?' },
    ],
    tools: [{ type: 'function', function: { name: 'weather' } }],
    tool_choice: 'required',
    parallel_tool_calls: false,
  });

  expect(stream).toBe(false);
  expect(request).toEqual({
    model: 'coder',
    messages: [
      { role: 'system', text: 'Be brief.' },
      { role: 'user', text: 'What is the weather in Oslo?' },
    ],
    tools: [
      {
        type: 'function',
        name: 'weather',
        input: { type: 'object', properties: {} },
      },
    ],
    options: { toolChoice: 'required', parallelToolCalls: false },
  });
});

test('sampling, stops and the token limit are read as options', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    temperature: 0.2,
    top_p: 0.9,
    seed: 7,
    presence_penalty: 0.5,
    frequency_penalty: -0.5,
    max_completion_tokens: 256,
    stop: ['END', '\n\n'],
    user: 'user-1234',
  });

  expect(request.options).toEqual({
    temperature: 0.2,
    topP: 0.9,
    seed: 7,
    presencePenalty: 0.5,
    frequencyPenalty: -0.5,
    maxTokens: 256,
    stop: ['END', '\n\n'],
    user: 'user-1234',
  });
});

test('the older token limit and a single stop are read the same way', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    max_tokens: 64,
    stop: 'END',
  });

  expect(request.options).toEqual({ maxTokens: 64, stop: ['END'] });
});

test('a null option is an option not given', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    temperature: null,
    stop: null,
    max_completion_tokens: null,
    n: null,
    stream: null,
    stream_options: null,
    response_format: null,
    tool_choice: null,
  });

  expect(request.options).toEqual({});
  expect(request.output).toBeUndefined();
});

test('each reasoning effort is read', () => {
  for (const effort of [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ] as const) {
    const { request } = decode({
      model: 'coder',
      messages: [],
      reasoning_effort: effort,
    });

    expect(request.options.reasoning).toEqual({ effort });
  }
});

test('the reasoning object is read with its budget and its mute', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    reasoning: { effort: 'low', max_tokens: 2000, exclude: true },
  });

  expect(request.options.reasoning).toEqual({
    effort: 'low',
    budgetTokens: 2000,
    exclude: true,
  });
});

test('a JSON schema format is read as the output, with name and strictness', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'forecast',
        description: 'A forecast',
        strict: true,
        schema: {
          type: 'object',
          properties: { celsius: { type: 'number' } },
          required: ['celsius'],
          additionalProperties: false,
        },
      },
    },
  });

  expect(request.output).toEqual({
    name: 'forecast',
    description: 'A forecast',
    strict: true,
    schema: {
      type: 'object',
      properties: { celsius: { type: 'number' } },
      required: ['celsius'],
      additionalProperties: false,
    },
  });
});

test('JSON mode is an output with no schema, and text is no output', () => {
  expect(
    decode({
      model: 'coder',
      messages: [],
      response_format: { type: 'json_object' },
    }).request.output,
  ).toEqual({});
  expect(
    decode({ model: 'coder', messages: [], response_format: { type: 'text' } })
      .request.output,
  ).toBeUndefined();
});

test('what changes the answer and only this wire reads is kept as its option', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    logprobs: true,
    top_logprobs: 3,
    logit_bias: { '50256': -100 },
    modalities: ['text', 'audio'],
    audio: { voice: 'alloy', format: 'wav' },
    web_search_options: { search_context_size: 'low' },
    top_k: 40,
  });

  expect(request.options).toEqual({
    provider: {
      'openai.chat': {
        logprobs: true,
        top_logprobs: 3,
        logit_bias: { '50256': -100 },
        modalities: ['text', 'audio'],
        audio: { voice: 'alloy', format: 'wav' },
        web_search_options: { search_context_size: 'low' },
        top_k: 40,
      },
    },
  });
});

test('bookkeeping and tuning only this wire reads are kept as hints', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    metadata: { ticket: 'MOT-12' },
    store: true,
    service_tier: 'flex',
    safety_identifier: 'u_9f2',
    prompt_cache_key: 'manual-v3',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    prompt_cache_retention: '24h',
    prediction: { type: 'content', content: 'const a = 1;' },
    verbosity: 'low',
  });

  expect(request.options).toEqual({
    hints: {
      'openai.chat': {
        metadata: { ticket: 'MOT-12' },
        store: true,
        service_tier: 'flex',
        safety_identifier: 'u_9f2',
        prompt_cache_key: 'manual-v3',
        prompt_cache_options: { mode: 'explicit', ttl: '30m' },
        prompt_cache_retention: '24h',
        prediction: { type: 'content', content: 'const a = 1;' },
        verbosity: 'low',
      },
    },
  });
});

test('how the reply is sent is no option of the model', () => {
  const { request, stream } = decode({
    model: 'coder',
    messages: [],
    stream: true,
    stream_options: { include_usage: true, include_obfuscation: false },
    n: 1,
  });

  expect(stream).toBe(true);
  expect(request.options).toEqual({});
});

test('more than one choice is rejected', () => {
  expect(() => decode({ model: 'coder', messages: [], n: 2 })).toThrow(
    Unsupported,
  );
  expect(() => decode({ model: 'coder', messages: [], n: 0 })).toThrow(
    'Only one choice is served: n must be 1',
  );
});

test('the functions of the old API are rejected', () => {
  expect(() =>
    decode({ model: 'coder', messages: [], functions: [{ name: 'f' }] }),
  ).toThrow(Unsupported);
  expect(() =>
    decode({ model: 'coder', messages: [], function_call: 'auto' }),
  ).toThrow('functions are not served: send tools');
});

test('a body that is not well formed is refused', () => {
  expect(() => decode('hi')).toThrow('The body must be a JSON object');
  expect(() => decode([])).toThrow(InvalidRequest);
  expect(() => decode({ messages: [] })).toThrow('The body needs a model');
  expect(() => decode({ model: 'coder' })).toThrow(
    'The body needs a list of messages',
  );
  expect(() => decode({ model: 'coder', messages: 'hi' })).toThrow(
    InvalidRequest,
  );
});

test('a null length is an absent one, so the older field still counts', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    max_tokens: 64,
    max_completion_tokens: null,
  });

  expect(request.options).toEqual({ maxTokens: 64 });
  expect(
    decode({
      model: 'coder',
      messages: [],
      max_tokens: 64,
      max_completion_tokens: 32,
    }).request.options,
  ).toEqual({ maxTokens: 32 });
});

test('an option given as null or empty is not held for this family alone', () => {
  const { request } = decode({
    model: 'coder',
    messages: [],
    logit_bias: null,
    modalities: [],
    web_search_options: {},
    metadata: {},
    top_logprobs: 0,
  });

  expect(request.options).toEqual({
    provider: { 'openai.chat': { top_logprobs: 0 } },
    hints: { 'openai.chat': { metadata: {} } },
  });
});

test('an option of the wrong type is refused by name', () => {
  const read = (option: { [name: string]: string | number | number[] }) =>
    decode({ model: 'coder', messages: [], ...option });

  expect(() => read({ temperature: 'hot' })).toThrow(
    'temperature must be a number',
  );
  expect(() => read({ max_tokens: '64' })).toThrow(
    'max_tokens must be a number',
  );
  expect(() => read({ max_completion_tokens: '64' })).toThrow(
    'max_completion_tokens must be a number',
  );
  expect(() => read({ parallel_tool_calls: 1 })).toThrow(
    'parallel_tool_calls must be true or false',
  );
  expect(() => read({ stream: 'yes' })).toThrow('stream must be true or false');
  expect(() => read({ stop: [1, 2] })).toThrow(
    'stop must be a string or a list of strings',
  );
  expect(() => read({ reasoning_effort: 'extreme' })).toThrow(
    'Unknown reasoning effort: "extreme"',
  );
  expect(() => read({ response_format: 'json' })).toThrow(InvalidRequest);
  expect(() => read({ n: 'two' })).toThrow('n must be a number');
});

test('a call to a custom tool the caller declared is answered as a custom call, whoever the upstream was', async () => {
  const { collected, streamed } = decode({
    model: 'coder',
    messages: [{ role: 'user', content: 'List the files.' }],
    tools: [
      { type: 'custom', custom: { name: 'shell' } },
      { type: 'function', function: { name: 'weather' } },
    ],
  });

  expect(
    collected(
      [
        { type: 'tool_call', id: 'call_1', name: 'shell', arguments: 'ls -la' },
        { type: 'tool_call', id: 'call_2', name: 'weather', arguments: '{}' },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'req_1',
    ),
  ).toMatchObject({
    choices: [
      {
        message: {
          tool_calls: [
            {
              id: 'call_1',
              type: 'custom',
              custom: { name: 'shell', input: 'ls -la' },
            },
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'weather', arguments: '{}' },
            },
          ],
        },
      },
    ],
  });

  const [first] = await Array.fromAsync(
    streamed(
      (async function* () {
        yield {
          type: 'tool_call',
          id: 'call_1',
          name: 'shell',
          arguments: 'ls -la',
        } as const;
        yield { type: 'finish', reason: 'tool_calls' } as const;
      })(),
      'req_1',
    ),
  );
  expect(JSON.parse(first?.data ?? '')).toMatchObject({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'custom',
              custom: { name: 'shell', input: 'ls -la' },
            },
          ],
        },
      },
    ],
  });
});

test('a million content parts, pictures or calls in one message are read, not a stack too deep', () => {
  const many = (one: string) =>
    JSON.parse(`[${`${one},`.repeat(999_999)}${one}]`);
  const { request } = decode({
    model: 'coder',
    messages: [
      {
        role: 'assistant',
        content: many('{"type":"text","text":"a"}'),
        images: many('{"image_url":{"url":"https://x.test/a.png"}}'),
        tool_calls: many(
          '{"id":"c","type":"function","function":{"name":"f","arguments":"{}"}}',
        ),
      },
    ],
  });

  expect(request.messages[0]?.parts).toHaveLength(3_000_000);
});
