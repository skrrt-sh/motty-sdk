import { expect, test } from 'bun:test';
import { events } from '../../src/chat-completions/events.ts';

async function* sent(...frames: string[]) {
  for (const data of frames) yield { data };
}

test('content deltas are read as text, and the stream ends in one finish', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x-2026-01-01","service_tier":"default","system_fingerprint":"fp_1","choices":[{"index":0,"delta":{"role":"assistant","content":"","refusal":null},"logprobs":null,"finish_reason":null}],"usage":null}',
          '{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x-2026-01-01","choices":[{"index":0,"delta":{"content":"Hel"},"logprobs":null,"finish_reason":null}],"usage":null}',
          '{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x-2026-01-01","choices":[{"index":0,"delta":{"content":"lo"},"logprobs":null,"finish_reason":null}],"usage":null}',
          '{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x-2026-01-01","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"stop"}],"usage":null}',
          '{"id":"chatcmpl-9","object":"chat.completion.chunk","created":1791585631,"model":"gpt-x-2026-01-01","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11,"prompt_tokens_details":{"cached_tokens":0,"audio_tokens":0},"completion_tokens_details":{"reasoning_tokens":0}}}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'stop',
      usage: { input: 9, output: 2, cached: 0, reasoning: 0 },
      id: 'chatcmpl-9',
      model: 'gpt-x-2026-01-01',
      provider: {
        'openai.chat': { system_fingerprint: 'fp_1', service_tier: 'default' },
      },
    },
  ]);
});

test('tool call deltas are read as fragments that share their call`s id', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":""}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"now","arguments":"{}"}},{"index":0,"function":{"arguments":"\\"Oslo\\"}"}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'tool_call', id: 'call_a', name: 'weather', arguments: '' },
    { type: 'tool_call', id: 'call_a', arguments: '{"city":' },
    { type: 'tool_call', id: 'call_b', name: 'now', arguments: '{}' },
    { type: 'tool_call', id: 'call_a', arguments: '"Oslo"}' },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ]);
});

test('a custom tool call is read as a fragment marked free-form', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"custom","custom":{"name":"shell","input":"ls"}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"custom":{"input":" -la"}}]},"finish_reason":"tool_calls"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'call_a',
      name: 'shell',
      arguments: 'ls',
      provider: { 'openai.chat': { type: 'custom' } },
    },
    {
      type: 'tool_call',
      id: 'call_a',
      arguments: ' -la',
      provider: { 'openai.chat': { type: 'custom' } },
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ]);
});

test('reasoning is read under either name, and a refusal as a refusal', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"reasoning_content":"The user "},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"reasoning":"asks for a weapon."},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"refusal":"I cannot help."},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'The user ' },
    { type: 'reasoning', text: 'asks for a weapon.' },
    { type: 'refusal', text: 'I cannot help.' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('logprobs ride on the text they score', async () => {
  const [text, refusal] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"Hi"},"logprobs":{"content":[{"token":"Hi","logprob":-0.01,"bytes":[72,105],"top_logprobs":[{"token":"Hi","logprob":-0.01,"bytes":[72,105]}]}],"refusal":null},"finish_reason":null}]}',
        '{"choices":[{"index":0,"delta":{"refusal":"No"},"logprobs":{"content":null,"refusal":[{"token":"No","logprob":-0.2,"bytes":[78,111],"top_logprobs":[]}]},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
    ),
  );

  expect(text).toEqual({
    type: 'text',
    text: 'Hi',
    provider: {
      'openai.chat': {
        logprobs: [
          {
            token: 'Hi',
            logprob: -0.01,
            bytes: [72, 105],
            top_logprobs: [{ token: 'Hi', logprob: -0.01, bytes: [72, 105] }],
          },
        ],
      },
    },
  });
  expect(refusal).toEqual({
    type: 'refusal',
    text: 'No',
    provider: {
      'openai.chat': {
        logprobs: [
          { token: 'No', logprob: -0.2, bytes: [78, 111], top_logprobs: [] },
        ],
      },
    },
  });
});

test('an annotation is read as a citation, and sound as this wire`s data', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Oslo."},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"annotations":[{"type":"url_citation","url_citation":{"start_index":0,"end_index":5,"title":"Oslo","url":"https://x.test/oslo"}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"audio":{"id":"audio_1","transcript":"Oslo."}},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Oslo.' },
    {
      type: 'citation',
      url: 'https://x.test/oslo',
      title: 'Oslo',
      provider: { 'openai.chat': { start_index: 0, end_index: 5 } },
    },
    {
      type: 'provider',
      provider: {
        'openai.chat': { audio: { id: 'audio_1', transcript: 'Oslo.' } },
      },
    },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('each finish reason is read, one not listed as other with its name', async () => {
  const last = async (reason: string) =>
    (
      await Array.fromAsync(
        events(
          sent(
            `{"choices":[{"index":0,"delta":{},"finish_reason":"${reason}"}]}`,
            '[DONE]',
          ),
        ),
      )
    ).at(-1);

  expect(await last('length')).toEqual({
    type: 'finish',
    reason: 'length',
    rawReason: 'length',
  });
  expect(await last('content_filter')).toEqual({
    type: 'finish',
    reason: 'content_filter',
    rawReason: 'content_filter',
  });
  expect(await last('function_call')).toEqual({
    type: 'finish',
    reason: 'tool_calls',
    rawReason: 'function_call',
  });
  expect(await last('eos')).toEqual({
    type: 'finish',
    reason: 'other',
    rawReason: 'eos',
  });
});

test('a stream that gave its reason and then just ended is finished', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hi' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a stream that ends with no reason given and no done mark ends in one error', async () => {
  const cut = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
      ),
    ),
  );
  const empty = await Array.fromAsync(events(sent()));

  expect(cut).toEqual([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream closed the stream before it finished',
        retryable: true,
        upstream: true,
      },
    },
  ]);
  expect(empty).toEqual(cut.slice(1));
});

test('a stream marked done that never gave a reason stopped, as a reply of sound does', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"gen-1","object":"chat.completion.chunk","created":1791623471,"model":"openai/gpt-audio-mini","provider":"OpenAI","system_fingerprint":"fp_6f28079852","choices":[{"index":0,"delta":{"content":"","role":"assistant","audio":{"id":"audio_6aca","transcript":"Hi"}},"finish_reason":null,"native_finish_reason":null}]}',
          '{"id":"gen-1","object":"chat.completion.chunk","created":1791623471,"model":"openai/gpt-audio-mini","provider":"OpenAI","system_fingerprint":"fp_6f28079852","choices":[{"index":0,"delta":{"content":"","role":"assistant","audio":{"data":"UklGRg=="}},"finish_reason":null,"native_finish_reason":null}]}',
          '{"id":"gen-1","object":"chat.completion.chunk","created":1791623471,"model":"openai/gpt-audio-mini","provider":"OpenAI","system_fingerprint":"fp_6f28079852","service_tier":"default","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":null,"native_finish_reason":null}],"usage":{"prompt_tokens":14,"completion_tokens":18,"total_tokens":32,"cost":0.0000516}}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'provider',
      provider: {
        'openai.chat': { audio: { id: 'audio_6aca', transcript: 'Hi' } },
      },
    },
    {
      type: 'provider',
      provider: { 'openai.chat': { audio: { data: 'UklGRg==' } } },
    },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 14, output: 18, cost: 0.0000516 },
      id: 'gen-1',
      model: 'openai/gpt-audio-mini',
      provider: {
        'openai.chat': {
          system_fingerprint: 'fp_6f28079852',
          service_tier: 'default',
        },
      },
    },
  ]);
});

test('a frame that cannot be read ends the stream in one error', async () => {
  for (const frame of [
    '{"choices":[{"index":0,"delta":{"cont',
    '"ping"',
    '[]',
    `{"error":{"message":"Busy","trace":${'['.repeat(100_000)}${']'.repeat(100_000)}}}`,
  ]) {
    expect(
      await Array.fromAsync(
        events(
          sent(
            '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
            frame,
            '{"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
            '[DONE]',
          ),
        ),
      ),
    ).toEqual([
      { type: 'text', text: 'Hel' },
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

test('a chunk with fields of the wrong types is read for what is sound', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":7,"choices":"none"}',
          '{"choices":[{"index":0,"delta":{"content":7,"tool_calls":"no","annotations":[{"type":"url_citation"}]},"logprobs":"no","finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":"many"}}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'tool_call', id: 'call_0', arguments: '{}' },
    {
      type: 'finish',
      reason: 'tool_calls',
      rawReason: 'tool_calls',
      usage: {},
    },
  ]);
});

test('content a provider filtered ends the reply as filtered, under the provider`s name', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"sensitive"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'finish', reason: 'content_filter', rawReason: 'sensitive' },
  ]);
});

test('a context window that ran out ends the reply by length', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{},"finish_reason":"model_context_window_exceeded"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'finish',
      reason: 'length',
      rawReason: 'model_context_window_exceeded',
    },
  ]);
});

test('a provider out of capacity ends the stream in an error, with what came and the usage', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"insufficient_system_resource"}]}',
          '{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}',
          '[DONE]',
        ),
        { name: 'deepseek' },
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'overloaded',
        message: 'The upstream ran out of capacity before it finished',
        provider: {
          deepseek: { finish_reason: 'insufficient_system_resource' },
        },
        upstream: true,
      },
      usage: { input: 9, output: 1 },
    },
  ]);
});

test('a provider that lost its connection ends the stream in an error worth another try', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{},"finish_reason":"network_error"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream lost its connection before it finished',
        retryable: true,
        provider: { 'openai.chat': { finish_reason: 'network_error' } },
        upstream: true,
      },
    },
  ]);
});

test('an ending a dialect names as failed ends the stream in an error and no finish, with what came and the usage', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"error"}]}',
          '{"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":1}}',
          '[DONE]',
        ),
        { name: 'mistral', broken: ['error'] },
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream failed before it finished',
        retryable: true,
        provider: { mistral: { finish_reason: 'error' } },
        upstream: true,
      },
      usage: { input: 9, output: 1 },
    },
  ]);
});

test('an error frame with a number for its code is named by that number', async () => {
  const [failed] = await Array.fromAsync(
    events(
      sent(
        '{"error":{"message":"Rate limit exceeded","code":429},"choices":[]}',
      ),
    ),
  );

  expect(failed).toMatchObject({
    type: 'error',
    error: { code: 'rate_limited', message: 'Rate limit exceeded' },
  });
});

test('a provider`s own reader names an error frame before the family does', async () => {
  const [failed] = await Array.fromAsync(
    events(
      sent(
        '{"error":{"message":"Insufficient Balance","code":"rate_limit_exceeded"}}',
      ),
      {
        name: 'deepseek',
        failures: (_, __, { message }) =>
          message === 'Insufficient Balance'
            ? { code: 'quota_exceeded' }
            : undefined,
      },
    ),
  );

  expect(failed).toMatchObject({
    type: 'error',
    error: { code: 'quota_exceeded', message: 'Insufficient Balance' },
  });
});

test('an error frame ends the stream in that error, with the usage so far', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}],"usage":{"prompt_tokens":9,"completion_tokens":1}}',
          '{"error":{"message":"The server had an error while processing your request.","type":"server_error","param":null,"code":null}}',
          '{"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}]}',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The server had an error while processing your request.',
        provider: {
          'openai.chat': {
            code: null,
            type: 'server_error',
            param: null,
          },
        },
        upstream: true,
      },
      usage: { input: 9, output: 1 },
    },
  ]);
});

test('an error frame is named by what the upstream calls it', async () => {
  const [failed] = await Array.fromAsync(
    events(
      sent(
        '{"error":{"message":"Rate limit reached","type":"tokens","param":null,"code":"rate_limit_exceeded"}}',
      ),
    ),
  );

  expect(failed).toMatchObject({
    type: 'error',
    error: { code: 'rate_limited', message: 'Rate limit reached' },
  });
});

test('a read that throws is left to the transport, which tells it one way', async () => {
  const hangUp = new TypeError('socket hang up');
  async function* breaking() {
    yield {
      data: '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
    };
    throw hangUp;
  }
  const read = events(breaking())[Symbol.asyncIterator]();

  expect(await read.next()).toEqual({
    done: false,
    value: { type: 'text', text: 'Hel' },
  });
  expect(read.next()).rejects.toBe(hangUp);
});

test('nothing is read from the upstream after it said it was done', async () => {
  let read = 0;
  async function* counting() {
    for (const data of [
      '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '[DONE]',
      '{"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":null}]}',
    ]) {
      read++;
      yield { data };
    }
  }

  expect(await Array.fromAsync(events(counting()))).toEqual([
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
  expect(read).toBe(2);
});

test('what a chunk leaves out of the head stays as an earlier one gave it', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"gen-1","model":"router/auto","service_tier":"flex","choices":[{"index":0,"delta":{"content":"po"},"finish_reason":null}]}',
          '{"model":"deepseek/deepseek-chat","system_fingerprint":"fp_1","service_tier":null,"choices":[{"index":0,"delta":{"content":"ng"},"finish_reason":"stop"}]}',
          '{"choices":[]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'po' },
    { type: 'text', text: 'ng' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'stop',
      id: 'gen-1',
      model: 'deepseek/deepseek-chat',
      provider: {
        'openai.chat': { system_fingerprint: 'fp_1', service_tier: 'flex' },
      },
    },
  ]);
});

test('a field a chunk names as the prototype is not read as the chunk`s own', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"__proto__":{"error":{"message":"planted"},"id":"planted"},"choices":[{"index":0,"delta":{"__proto__":{"content":"planted"}},"finish_reason":null}]}',
          '{"choices":[{"__proto__":{"finish_reason":"length"},"index":0,"delta":{"content":"pong"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'pong' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a null service tier is no tier', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"gen-1","model":"deepseek/deepseek-chat","service_tier":null,"choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'pong' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'stop',
      id: 'gen-1',
      model: 'deepseek/deepseek-chat',
    },
  ]);
});

test('a chunk the dialect says holds a failure, inside a reply that began well, ends the stream in that failure, in its words', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"06","choices":[{"index":0,"delta":{"content":"Hel"}}],"outcome":{"number":0}}',
          '{"id":"06","choices":[],"outcome":{"number":1000,"message":"unknown error"}}',
        ),
        {
          name: 'acme',
          envelope: ({ outcome }) =>
            typeof outcome === 'object' &&
            outcome !== null &&
            !Array.isArray(outcome) &&
            'message' in outcome
              ? outcome
              : undefined,
        },
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'unknown error',
        retryable: false,
        provider: { acme: { number: 1000 } },
        upstream: true,
      },
    },
  ]);
});

test('the dialect`s own reader names a failure its chunk holds, and says whether to try again', async () => {
  const [failed] = await Array.fromAsync(
    events(sent('{"choices":[],"outcome":{"number":1008}}'), {
      name: 'acme',
      envelope: ({ outcome }) =>
        typeof outcome === 'object' &&
        outcome !== null &&
        !Array.isArray(outcome)
          ? { ...outcome, message: 'insufficient balance' }
          : undefined,
      failures: (status, _, { number }) =>
        status === undefined && number === 1008
          ? { code: 'quota_exceeded', retryable: false }
          : undefined,
    }),
  );

  expect(failed).toMatchObject({
    type: 'error',
    error: {
      code: 'quota_exceeded',
      message: 'insufficient balance',
      retryable: false,
    },
  });
});

test('a chunk the dialect says holds no failure is read as any other', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}],"outcome":{"number":0}}',
          '[DONE]',
        ),
        { name: 'acme', envelope: () => undefined },
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hello' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a failure the dialect`s chunk holds with no words is told as an upstream error', async () => {
  const [failed] = await Array.fromAsync(
    events(sent('{"outcome":{"number":1013}}'), {
      name: 'acme',
      envelope: () => ({ number: 1013 }),
    }),
  );

  expect(failed).toMatchObject({
    type: 'error',
    error: {
      code: 'upstream_failed',
      message: 'The upstream answered with an error',
    },
  });
});

test('one provider`s own status in a chunk tells nothing where the dialect did not say it does', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hello"}}],"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"base_resp":{"status_code":"1008","status_msg":"insufficient balance"}}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hello' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('what the adapter cuts is cut from a failure a stream tells, and from no sentence written here', async () => {
  const cut = (text: string) => text.replaceAll('upstream', '[cut]');

  expect(
    await Promise.all(
      [
        '{"error":{"message":"No route to upstream","upstream":"is down"}}',
        '{"cho',
        '{"choices":[]}',
      ].map((frame) => Array.fromAsync(events(sent(frame), undefined, cut))),
    ),
  ).toMatchObject([
    [
      {
        type: 'error',
        error: {
          message: 'No route to [cut]',
          provider: { 'openai.chat': { '[cut]': 'is down' } },
        },
      },
    ],
    [
      {
        type: 'error',
        error: { message: 'The upstream sent an event that cannot be read' },
      },
    ],
    [
      {
        type: 'error',
        error: { message: 'The upstream closed the stream before it finished' },
      },
    ],
  ]);
});

test('a failure a chunk tells as a sentence ends the stream in an error, and a blank one is none', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]}',
          '{"error":"upstream overloaded"}',
          '[DONE]',
        ),
      ),
    ),
  ).toMatchObject([
    { type: 'text', text: 'Hel' },
    { type: 'error', error: { message: 'upstream overloaded' } },
  ]);
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"error":" ","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'text', text: 'Hello' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a fragment with an empty id belongs to the call its index names', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":""}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"","type":"function","function":{"name":"","arguments":"{\\"city\\":\\"Oslo\\"}"}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toMatchObject([
    { type: 'tool_call', id: 'call_a', name: 'weather', arguments: '' },
    { type: 'tool_call', id: 'call_a', arguments: '{"city":"Oslo"}' },
    { type: 'finish', reason: 'tool_calls' },
  ]);
});

test('reasoning under one name is read where the other name is null', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"reasoning":"Hm.","reasoning_content":null},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'Hm.' },
    { type: 'text', text: 'Hi' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a field of a tool call that is not read rides on the fragment that brought it', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":""},"extra_content":{"google":{"thought_signature":"c2ln"}}}]},"finish_reason":null}]}',
          '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([
    {
      type: 'tool_call',
      id: 'call_a',
      name: 'weather',
      arguments: '',
      provider: {
        'openai.chat': {
          extra_content: { google: { thought_signature: 'c2ln' } },
        },
      },
    },
    { type: 'tool_call', id: 'call_a', arguments: '{}' },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ]);
});

test('a field inside a tool call`s function that is not read is kept inside it', async () => {
  const [first] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"weather","arguments":"{}","signature":"c2ln"}}]},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
    ),
  );

  expect(first).toEqual({
    type: 'tool_call',
    id: 'call_a',
    name: 'weather',
    arguments: '{}',
    provider: { 'openai.chat': { function: { signature: 'c2ln' } } },
  });
});

test('a field of a custom tool call that is not read is kept beside its mark', async () => {
  const [first] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"custom","custom":{"name":"shell","input":"ls","signature":"c2ln"},"vendor":{"a":1}}]},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
    ),
  );

  expect(first).toEqual({
    type: 'tool_call',
    id: 'call_a',
    name: 'shell',
    arguments: 'ls',
    provider: {
      'openai.chat': {
        vendor: { a: 1 },
        custom: { signature: 'c2ln' },
        type: 'custom',
      },
    },
  });
});

test('what a call marked custom holds inside its function object is kept as the custom object`s', async () => {
  const [first] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"custom","function":{"name":"shell","arguments":"ls","signature":"c2ln"}}]},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
    ),
  );

  expect(first).toEqual({
    type: 'tool_call',
    id: 'call_a',
    name: 'shell',
    arguments: 'ls',
    provider: {
      'openai.chat': { custom: { signature: 'c2ln' }, type: 'custom' },
    },
  });
});

test('an entry of tool calls that is no object is no call', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"tool_calls":[null,5,"x",[]]},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
      ),
    ),
  ).toEqual([{ type: 'finish', reason: 'stop', rawReason: 'stop' }]);
});

test.each([
  ['"function":{"name":"weather","arguments":{"a":1}}'],
  ['"type":"custom","custom":{"name":"weather","input":{"a":1}}'],
])(
  'arguments given as an object are read as its JSON text: %s',
  async (call) => {
    const [first] = await Array.fromAsync(
      events(
        sent(
          `{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a",${call}}]},"finish_reason":"tool_calls"}]}`,
          '[DONE]',
        ),
      ),
    );

    expect(first).toMatchObject({
      type: 'tool_call',
      id: 'call_a',
      name: 'weather',
      arguments: '{"a":1}',
    });
  },
);
