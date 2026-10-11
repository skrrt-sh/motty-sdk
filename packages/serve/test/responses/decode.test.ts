import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import { decode } from '../../src/responses/decode.ts';

test('the smallest request is a model and what the user said', () => {
  const { request, stream } = decode({ model: 'coder', input: 'Hello' });
  expect(request).toEqual({
    model: 'coder',
    messages: [{ role: 'user', text: 'Hello' }],
    tools: [],
    options: {},
  });
  expect(stream).toBe(false);
});

test('a stream is asked for by name', () => {
  expect(decode({ model: 'coder', input: 'Hi', stream: true }).stream).toBe(
    true,
  );
  expect(decode({ model: 'coder', input: 'Hi', stream: null }).stream).toBe(
    false,
  );
});

test('instructions lead the conversation, marked as instructions', () => {
  expect(
    decode({ model: 'coder', instructions: 'Be brief.', input: 'Hi' }).request
      .messages,
  ).toEqual([
    {
      role: 'system',
      text: 'Be brief.',
      hints: { 'openai.responses': { instructions: true } },
    },
    { role: 'user', text: 'Hi' },
  ]);
});

test('sampling, length and the choice of tools are read as options', () => {
  expect(
    decode({
      model: 'coder',
      input: 'Hi',
      max_output_tokens: 256,
      temperature: 0.2,
      top_p: 0.9,
      user: 'u_1',
      parallel_tool_calls: false,
      tool_choice: 'required',
      tools: [{ type: 'function', name: 'weather', parameters: {} }],
    }).request,
  ).toMatchObject({
    tools: [{ type: 'function', name: 'weather', input: {} }],
    options: {
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.9,
      user: 'u_1',
      parallelToolCalls: false,
      toolChoice: 'required',
    },
  });
});

test('a field given as null is a field left out', () => {
  expect(
    decode({
      model: 'coder',
      input: 'Hi',
      instructions: null,
      max_output_tokens: null,
      temperature: null,
      tool_choice: null,
      tools: null,
      reasoning: null,
      previous_response_id: null,
      conversation: null,
      store: null,
      metadata: null,
    }).request,
  ).toEqual({
    model: 'coder',
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [],
    options: {},
  });
});

test('reasoning effort is read, and with no summary asked for it is muted', () => {
  expect(
    decode({ model: 'coder', input: 'Hi', reasoning: { effort: 'high' } })
      .request.options,
  ).toEqual({ reasoning: { effort: 'high', exclude: true } });
});

test('a summary asked for shows reasoning and is put back for this API', () => {
  expect(
    decode({
      model: 'coder',
      input: 'Hi',
      reasoning: { effort: 'xhigh', summary: 'detailed', context: 'all_turns' },
    }).request.options,
  ).toEqual({
    reasoning: { effort: 'xhigh' },
    hints: { 'openai.responses': { reasoning: { summary: 'detailed' } } },
    provider: { 'openai.responses': { reasoning: { context: 'all_turns' } } },
  });
});

test('an effort that is not known is refused', () => {
  expect(() =>
    decode({ model: 'coder', input: 'Hi', reasoning: { effort: 'extreme' } }),
  ).toThrow(InvalidRequest);
});

test('a JSON schema format is the structured output', () => {
  expect(
    decode({
      model: 'coder',
      input: 'Hi',
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'answer',
          description: 'The answer',
          strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
    }).request,
  ).toMatchObject({
    output: {
      name: 'answer',
      description: 'The answer',
      strict: true,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
    options: { hints: { 'openai.responses': { text: { verbosity: 'low' } } } },
  });
});

test('a JSON object format asks for any JSON, and a text format for none', () => {
  expect(
    decode({
      model: 'coder',
      input: 'Hi',
      text: { format: { type: 'json_object' } },
    }).request.output,
  ).toEqual({});
  expect(
    decode({ model: 'coder', input: 'Hi', text: { format: { type: 'text' } } })
      .request,
  ).not.toHaveProperty('output');
  expect(() =>
    decode({
      model: 'coder',
      input: 'Hi',
      text: { format: { type: 'json_schema', name: 'a' } },
    }),
  ).toThrow('text.format needs a schema');
});

test('what another family may leave out is a hint and the rest must arrive', () => {
  expect(
    decode({
      model: 'coder',
      input: 'Hi',
      store: false,
      background: false,
      stream_options: { include_obfuscation: false },
      include: ['reasoning.encrypted_content'],
      metadata: { ticket: 'T-1' },
      prompt_cache_key: 'k1',
      service_tier: 'flex',
      safety_identifier: 's1',
      truncation: 'auto',
      top_logprobs: 3,
    }).request.options,
  ).toEqual({
    hints: {
      'openai.responses': {
        include: ['reasoning.encrypted_content'],
        metadata: { ticket: 'T-1' },
        prompt_cache_key: 'k1',
        service_tier: 'flex',
        safety_identifier: 's1',
      },
    },
    provider: { 'openai.responses': { truncation: 'auto', top_logprobs: 3 } },
  });
});

test('state the server would hold is refused, each by its name', () => {
  expect(() =>
    decode({ model: 'coder', input: 'Hi', previous_response_id: 'resp_1' }),
  ).toThrow(Unsupported);
  expect(() =>
    decode({ model: 'coder', input: 'Hi', previous_response_id: 'resp_1' }),
  ).toThrow(
    'No response state is held here. previous_response_id continues a stored response: send the whole conversation as input',
  );
  expect(() =>
    decode({ model: 'coder', input: 'Hi', conversation: 'conv_1' }),
  ).toThrow('conversation names a stored conversation');
  expect(() =>
    decode({ model: 'coder', input: 'Hi', conversation: { id: 'conv_1' } }),
  ).toThrow(Unsupported);
  expect(() => decode({ model: 'coder', input: 'Hi', store: true })).toThrow(
    'store must be false or left out',
  );
  expect(() =>
    decode({ model: 'coder', input: 'Hi', background: true }),
  ).toThrow('background mode is not served');
  expect(() => decode({ model: 'coder', prompt: { id: 'pmpt_1' } })).toThrow(
    'prompt names a stored prompt template',
  );
  expect(() =>
    decode({ model: 'coder', input: [{ type: 'item_reference', id: 'm' }] }),
  ).toThrow(Unsupported);
});

test('a body that cannot be read is refused', () => {
  expect(() => decode('Hi')).toThrow('The body must be a JSON object');
  expect(() => decode({ input: 'Hi' })).toThrow('The body needs a model');
  expect(() => decode({ model: 'coder' })).toThrow(
    'input must be a string or a list of items',
  );
  expect(() => decode({ model: 'coder', input: 'Hi', stream: 'yes' })).toThrow(
    InvalidRequest,
  );
  expect(() => decode({ model: 'coder', input: 'Hi', tools: {} })).toThrow(
    'tools must be a list',
  );
  expect(() =>
    decode({ model: 'coder', input: 'Hi', temperature: 'hot' }),
  ).toThrow('temperature must be a number');
  expect(() =>
    decode({ model: 'coder', input: 'Hi', instructions: ['a'] }),
  ).toThrow('instructions must be a string');
});

test('progress is shown only to a caller who asked for a reasoning summary', async () => {
  async function* run() {
    yield { type: 'progress', piece: 0, text: 'Routing' } as const;
    yield { type: 'finish', reason: 'stop' } as const;
  }
  const shown = decode({
    model: 'coder',
    input: 'Hi',
    reasoning: { summary: 'auto' },
  });
  const muted = decode({ model: 'coder', input: 'Hi' });
  const effort = decode({
    model: 'coder',
    input: 'Hi',
    reasoning: { effort: 'low' },
  });
  const names = async (decoded: typeof shown) =>
    (await Array.fromAsync(decoded.streamed(run(), 'r1'))).map(
      ({ event }) => event,
    );
  expect(await names(shown)).toContain('response.reasoning_summary_text.delta');
  expect(await names(muted)).toEqual([
    'response.created',
    'response.in_progress',
    'response.completed',
  ]);
  expect(await names(effort)).not.toContain(
    'response.reasoning_summary_text.delta',
  );
});

test('a collected reply is a response object with the request id', () => {
  const reply = decode({ model: 'coder', input: 'Hi' }).collected(
    [{ type: 'text', text: 'Hello.' }],
    { type: 'finish', reason: 'stop' },
    'r1',
  );
  expect(reply).toMatchObject({
    id: 'resp_r1',
    object: 'response',
    status: 'completed',
    model: 'coder',
  });
});

test('a million content parts in one message are read, not a stack too deep', () => {
  const one = '{"type":"output_text","text":"a"}';
  const { request } = decode({
    model: 'coder',
    input: [
      {
        type: 'message',
        role: 'assistant',
        content: JSON.parse(`[${`${one},`.repeat(999_999)}${one}]`),
      },
    ],
  });

  expect(request.messages[0]?.parts).toHaveLength(1_000_000);
});
