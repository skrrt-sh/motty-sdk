import { expect, test } from 'bun:test';
import { isTerminal, type RunStream } from '@mottyjs/core/host';
import {
  chatCompletions,
  chatCompletionsIn,
} from '../../src/chat-completions/index.ts';
import { responses } from '../../src/responses/index.ts';
import { isDict, parsed } from '../../src/wire/json.ts';

async function* sent(...frames: string[]) {
  for (const data of frames) yield { data };
}

test('the codec serves the chat completions path', () => {
  expect(chatCompletions.paths).toEqual(['/v1/chat/completions']);
});

test('a request read and sent on again reaches the upstream unchanged', () => {
  const messages = [
    { role: 'developer', content: 'Be brief.' },
    {
      role: 'user',
      name: 'bo',
      content: [
        {
          type: 'text',
          text: 'A long manual',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,iVBORw0KGgo=',
            detail: 'low',
          },
        },
        { type: 'image_url', image_url: { url: 'https://x.test/cat.png' } },
        {
          type: 'input_audio',
          input_audio: { data: 'UklGRg==', format: 'wav' },
        },
        {
          type: 'file',
          file: {
            file_data: 'data:application/pdf;base64,JVBERi0=',
            filename: 'terms.pdf',
          },
        },
        { type: 'file', file: { file_id: 'file-6F2ksmvXxt4VdoqmHRw6kL' } },
      ],
    },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"Oslo"}' },
        },
        {
          id: 'call_def',
          type: 'custom',
          custom: { name: 'shell', input: 'ls -la' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call_abc', content: '4°C' },
    {
      role: 'tool',
      tool_call_id: 'call_def',
      content: [{ type: 'text', text: 'terms.pdf' }],
    },
    { role: 'assistant', content: null, audio: { id: 'audio_abc123' } },
    { role: 'user', content: 'And tomorrow?' },
  ];
  const tools = [
    {
      type: 'function',
      function: {
        name: 'weather',
        description: 'The weather in a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
      },
    },
    {
      type: 'custom',
      custom: {
        name: 'shell',
        format: {
          type: 'grammar',
          grammar: { syntax: 'regex', definition: '^ls( -[al]+)?$' },
        },
      },
    },
    { type: 'web_search_preview', search_context_size: 'low' },
  ];
  const options = {
    tool_choice: {
      type: 'allowed_tools',
      allowed_tools: {
        mode: 'auto',
        tools: [
          { type: 'function', function: { name: 'weather' } },
          { type: 'custom', custom: { name: 'shell' } },
        ],
      },
    },
    parallel_tool_calls: false,
    reasoning_effort: 'high',
    stop: ['END'],
    max_completion_tokens: 256,
    temperature: 0.2,
    top_p: 0.9,
    seed: 7,
    presence_penalty: 0.5,
    frequency_penalty: -0.5,
    user: 'user-1234',
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'forecast',
        strict: true,
        schema: { type: 'object', properties: { celsius: { type: 'number' } } },
      },
    },
    logprobs: true,
    top_logprobs: 3,
    logit_bias: { '50256': -100 },
    metadata: { ticket: 'MOT-12' },
    store: true,
    service_tier: 'flex',
    prompt_cache_key: 'manual-v3',
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    verbosity: 'low',
  };

  const { request } = chatCompletions.decode(
    { model: 'coder', messages, tools, ...options, stream: false, n: 1 },
    new Headers(),
  );
  const { body } = chatCompletionsIn({
    name: 'openai.chat',
    breakpoints: true,
  }).encode('gpt-x', request);

  expect(body).toEqual({
    model: 'gpt-x',
    messages,
    tools,
    ...options,
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('fields the API has two spellings of are sent in the current one', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'coder',
      max_tokens: 64,
      stop: 'END',
      messages: [
        { role: 'assistant', content: 'Sure.', refusal: 'Not that part.' },
        { role: 'assistant', content: 'Hi', reasoning_content: 'Greet.' },
      ],
      tools: [{ type: 'function', function: { name: 'now' } }],
      tool_choice: { type: 'function', function: { name: 'now' } },
    },
    new Headers(),
  );

  expect(chatCompletions.encode('gpt-x', request).body).toEqual({
    model: 'gpt-x',
    max_completion_tokens: 64,
    stop: ['END'],
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sure.' },
          { type: 'refusal', refusal: 'Not that part.' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'now',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'now' } },
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('an upstream`s stream read and sent on reaches the caller unchanged', async () => {
  const { streamed } = chatCompletions.decode(
    {
      model: 'gpt-x',
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    },
    new Headers(),
  );
  const upstream = [
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"Look it up.","reasoning_content":"Look it up."},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"content":"Oslo."},"logprobs":{"content":[{"token":"Oslo.","logprob":-0.1,"bytes":null,"top_logprobs":[]}],"refusal":null},"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"annotations":[{"type":"url_citation","url_citation":{"start_index":0,"end_index":5,"title":"Oslo","url":"https://x.test/oslo"}}]},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"refusal":"No more."},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":""}}]},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Oslo\\"}"}}]},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"custom","custom":{"name":"shell","input":"ls"}}]},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","choices":[{"index":0,"delta":{"audio":{"id":"audio_1","transcript":"Oslo."}},"logprobs":null,"finish_reason":null}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","system_fingerprint":"fp_1","service_tier":"flex","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"tool_calls"}],"usage":null}',
    '{"id":"chatcmpl-req_1","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x","system_fingerprint":"fp_1","service_tier":"flex","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":40,"total_tokens":160,"prompt_tokens_details":{"cached_tokens":100,"cache_write_tokens":20},"completion_tokens_details":{"reasoning_tokens":32}}}',
    '[DONE]',
  ];

  const frames = await Array.fromAsync(
    streamed(chatCompletions.events(sent(...upstream)), 'req_1'),
  );

  expect(
    frames.map(({ data }) =>
      data === '[DONE]' ? data : { ...JSON.parse(data), created: 1791585631 },
    ),
  ).toEqual(
    upstream.map((data) => (data === '[DONE]' ? data : JSON.parse(data))),
  );
});

test('an upstream`s stream read and collected is the reply it stood for', async () => {
  const { collected } = chatCompletions.decode(
    { model: 'gpt-x', messages: [] },
    new Headers(),
  );
  const read = await Array.fromAsync(
    chatCompletions.events(
      sent(
        '{"id":"chatcmpl-9","model":"gpt-x","system_fingerprint":"fp_1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"logprobs":{"content":[{"token":"Hel","logprob":-0.1,"bytes":null,"top_logprobs":[]}],"refusal":null},"finish_reason":null}]}',
        '{"id":"chatcmpl-9","model":"gpt-x","choices":[{"index":0,"delta":{"content":"lo"},"logprobs":{"content":[{"token":"lo","logprob":-0.3,"bytes":null,"top_logprobs":[]}],"refusal":null},"finish_reason":null}]}',
        '{"id":"chatcmpl-9","model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
        '{"id":"chatcmpl-9","model":"gpt-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Oslo\\"}"}}]},"finish_reason":"tool_calls"}]}',
        '{"id":"chatcmpl-9","model":"gpt-x","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":12,"total_tokens":21}}',
        '[DONE]',
      ),
    ),
  );
  const chunks = read.filter((event) => !isTerminal(event));
  const finish = read.find((event) => event.type === 'finish');
  if (finish === undefined) throw new Error('The stream did not finish');

  expect(collected(chunks, finish, '9')).toEqual({
    id: 'chatcmpl-9',
    object: 'chat.completion',
    created: expect.any(Number),
    model: 'gpt-x',
    system_fingerprint: 'fp_1',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello',
          refusal: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        logprobs: {
          content: [
            { token: 'Hel', logprob: -0.1, bytes: null, top_logprobs: [] },
            { token: 'lo', logprob: -0.3, bytes: null, top_logprobs: [] },
          ],
          refusal: null,
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
  });
});

test('a caller who muted reasoning is sent no progress', async () => {
  const { streamed, collected } = chatCompletions.decode(
    { model: 'coder', messages: [], reasoning: { exclude: true } },
    new Headers(),
  );
  async function* run(): RunStream {
    yield { type: 'progress', piece: 0, text: 'Routing to code' };
    yield { type: 'text', text: 'Use a loop.' };
    yield { type: 'finish', reason: 'stop' };
  }

  const frames = await Array.fromAsync(streamed(run(), 'req_1'));
  const reply = collected(
    [
      { type: 'progress', piece: 0, text: 'Routing to code' },
      { type: 'text', text: 'Use a loop.' },
    ],
    { type: 'finish', reason: 'stop' },
    'req_1',
  );

  expect(frames.map(({ data }) => data).join('\n')).not.toContain('Routing');
  expect(JSON.stringify(reply)).not.toContain('Routing');
});

test('a caller who did not mute reasoning is sent progress as reasoning', async () => {
  const { streamed, collected } = chatCompletions.decode(
    { model: 'coder', messages: [], reasoning: { exclude: false } },
    new Headers(),
  );
  async function* run(): RunStream {
    yield { type: 'progress', piece: 0, text: 'Routing to code' };
    yield { type: 'finish', reason: 'stop' };
  }

  const [first] = await Array.fromAsync(streamed(run(), 'req_1'));
  const reply = collected(
    [{ type: 'progress', piece: 0, text: 'Routing to code' }],
    { type: 'finish', reason: 'stop' },
    'req_1',
  );

  expect(parsed(first?.data ?? '')).toMatchObject({
    choices: [{ delta: { role: 'assistant', reasoning: 'Routing to code' } }],
  });
  expect(reply).toMatchObject({
    choices: [{ message: { reasoning: 'Routing to code' } }],
  });
});

test('usage is in the stream only for a caller who asked for it there', async () => {
  async function* run(): RunStream {
    yield { type: 'text', text: 'Hi' };
    yield { type: 'finish', reason: 'stop', usage: { input: 3, output: 1 } };
  }
  const frames = async (options: { include_usage: boolean } | undefined) => {
    const { streamed } = chatCompletions.decode(
      {
        model: 'coder',
        messages: [],
        stream: true,
        ...(options === undefined ? {} : { stream_options: options }),
      },
      new Headers(),
    );
    const sent = await Array.fromAsync(streamed(run(), 'req_1'));
    return sent.flatMap(({ data }) => {
      const frame = parsed(data);
      return isDict(frame) ? [frame] : [];
    });
  };

  expect(await frames({ include_usage: true })).toMatchObject([
    { choices: [{ delta: { content: 'Hi' } }], usage: null },
    { choices: [{ finish_reason: 'stop' }], usage: null },
    {
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ]);
  for (const options of [undefined, { include_usage: false }]) {
    const plain = await frames(options);
    expect(plain).toHaveLength(2);
    expect(plain.some((frame) => 'usage' in frame)).toBe(false);
  }
});

test('an upstream`s failure is answered to the caller in the API`s error body', () => {
  const facts = chatCompletions.failure(
    429,
    new Headers({ 'retry-after': '20' }),
    '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}',
  );

  expect(facts).toMatchObject({
    code: 'quota_exceeded',
    retryAfter: 20_000,
    provider: { 'openai.chat': { status: 429, code: 'insufficient_quota' } },
  });
  expect(chatCompletions.error(facts)).toEqual({
    status: 429,
    body: {
      error: {
        message: 'You exceeded your current quota',
        type: 'insufficient_quota',
        param: null,
        code: 'insufficient_quota',
      },
    },
  });
});

test('a provider`s own reader names a failed response and a failure in a stream alike', async () => {
  const codec = chatCompletionsIn({
    name: 'deepseek',
    failures: (_, __, { message }) =>
      message === 'Insufficient Balance'
        ? { code: 'quota_exceeded' }
        : undefined,
  });

  expect(
    codec.failure(
      400,
      new Headers(),
      '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}',
    ).code,
  ).toBe('quota_exceeded');
  expect(
    await Array.fromAsync(
      codec.events(sent('{"error":{"message":"Insufficient Balance"}}')),
    ),
  ).toMatchObject([{ type: 'error', error: { code: 'quota_exceeded' } }]);
  expect(
    codec.failure(400, new Headers(), '{"error":{"message":"Bad request"}}')
      .code,
  ).toBe('invalid_request');
});

test('progress a caller sends back never reaches the upstream', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'coder',
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: 'Hello.',
          reasoning: 'Routing to the fast model.',
          reasoning_content: 'Routing to the fast model.',
        },
      ],
    },
    new Headers(),
  );

  expect(chatCompletions.encode('gpt-x', request).body).toMatchObject({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
    ],
  });
  expect(
    JSON.stringify(chatCompletions.encode('gpt-x', request).body),
  ).not.toContain('Routing');
});

test('a field of a caller that is not known is held under this API`s own key: it goes back in place, and fails the other OpenAI API', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'coder',
      messages: [{ role: 'user', content: 'Hi' }],
      some_new_field: 1,
    },
    new Headers(),
  );
  const { messages, options } = request;

  expect(options.provider).toEqual({ 'openai.chat': { some_new_field: 1 } });
  expect(chatCompletions.encode('gpt-x', { messages, options }).body).toEqual({
    some_new_field: 1,
    model: 'gpt-x',
    messages: [{ role: 'user', content: 'Hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(() => responses.encode('gpt-5', { messages, options })).toThrow(
    'The Responses API cannot carry an option of openai.chat',
  );
});
