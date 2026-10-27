import { expect, test } from 'bun:test';
import type { Chunk, Json, RunStream } from '@mottyjs/core/host';
import { chatCompletions } from '../../src/chat-completions/index.ts';
import { messages } from '../../src/messages/index.ts';
import { field } from '../../src/responses/fields.ts';
import { responses, responsesIn } from '../../src/responses/index.ts';
import { list, parsed } from '../../src/wire/json.ts';

test('a request decoded and encoded again reaches the upstream with the same meaning', () => {
  const { request } = responses.decode(
    {
      model: 'coder',
      instructions: 'You are a coding agent.',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      metadata: { ticket: 'T-1' },
      prompt_cache_key: 'k1',
      truncation: 'auto',
      max_output_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      parallel_tool_calls: false,
      reasoning: { effort: 'medium', summary: 'auto' },
      text: {
        verbosity: 'low',
        format: {
          type: 'json_schema',
          name: 'answer',
          strict: true,
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
      tool_choice: {
        type: 'allowed_tools',
        mode: 'auto',
        tools: [
          { type: 'function', name: 'weather' },
          { type: 'custom', name: 'patch' },
        ],
      },
      tools: [
        {
          type: 'function',
          name: 'weather',
          description: 'Looks up the weather',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
        {
          type: 'custom',
          name: 'patch',
          format: { type: 'grammar', syntax: 'lark', definition: 'start: "a"' },
        },
        { type: 'web_search', search_context_size: 'low' },
      ],
      input: [
        { type: 'message', role: 'developer', content: 'Use tools.' },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is in these?' },
            {
              type: 'input_image',
              image_url: 'data:image/png;base64,iVBORw0KGgo=',
              detail: 'high',
            },
            { type: 'input_file', file_id: 'file-1' },
          ],
        },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Look first.' }],
          encrypted_content: 'gAAAAABo',
        },
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          phase: 'commentary',
          content: [
            {
              type: 'output_text',
              text: 'Checking the docs.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://x.test',
                  title: 'Docs',
                  start_index: 13,
                  end_index: 17,
                },
              ],
            },
          ],
        },
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'weather',
          arguments: '{"city":"Oslo"}',
        },
        {
          type: 'custom_tool_call',
          id: 'ctc_1',
          call_id: 'call_2',
          name: 'patch',
          input: '*** Begin Patch',
        },
        { type: 'function_call_output', call_id: 'call_1', output: '4C' },
        {
          type: 'custom_tool_call_output',
          call_id: 'call_2',
          output: [{ type: 'input_text', text: 'Done' }],
        },
        { type: 'message', role: 'user', content: 'Go on.' },
      ],
    },
    new Headers(),
  );
  const { model: _, ...prompt } = request;
  expect(responses.encode('gpt-5', prompt).body).toEqual({
    model: 'gpt-5',
    instructions: 'You are a coding agent.',
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    metadata: { ticket: 'T-1' },
    prompt_cache_key: 'k1',
    truncation: 'auto',
    max_output_tokens: 1024,
    temperature: 0.2,
    top_p: 0.9,
    parallel_tool_calls: false,
    reasoning: { effort: 'medium', summary: 'auto' },
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'answer',
        strict: true,
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    },
    tool_choice: {
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        { type: 'function', name: 'weather' },
        { type: 'custom', name: 'patch' },
      ],
    },
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'Looks up the weather',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
      {
        type: 'custom',
        name: 'patch',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: "a"' },
      },
      { type: 'web_search', search_context_size: 'low' },
    ],
    input: [
      { type: 'message', role: 'developer', content: 'Use tools.' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is in these?' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,iVBORw0KGgo=',
            detail: 'high',
          },
          { type: 'input_file', file_id: 'file-1' },
        ],
      },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Look first.' }],
        encrypted_content: 'gAAAAABo',
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [
          {
            type: 'output_text',
            text: 'Checking the docs.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://x.test',
                title: 'Docs',
                start_index: 13,
                end_index: 17,
              },
            ],
          },
        ],
      },
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Oslo"}',
      },
      {
        type: 'custom_tool_call',
        id: 'ctc_1',
        call_id: 'call_2',
        name: 'patch',
        input: '*** Begin Patch',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '4C' },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_2',
        output: [{ type: 'input_text', text: 'Done' }],
      },
      { type: 'message', role: 'user', content: 'Go on.' },
    ],
  });
});

async function* upstream() {
  const sent = [
    { type: 'response.created', response: { id: 'resp_up' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'rs_up',
        type: 'reasoning',
        summary: [],
        encrypted_content: 'gAAAAABo-start',
      },
    },
    {
      type: 'response.reasoning_summary_part.added',
      output_index: 0,
      summary_index: 0,
    },
    {
      type: 'response.reasoning_summary_text.delta',
      output_index: 0,
      summary_index: 0,
      delta: 'Look it up.',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'rs_up',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Look it up.' }],
        encrypted_content: 'gAAAAABo-whole',
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: 'msg_up', type: 'message', phase: 'commentary', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Checking ' },
    { type: 'response.output_text.delta', output_index: 1, delta: 'Oslo.' },
    {
      type: 'response.output_text.annotation.added',
      output_index: 1,
      annotation: {
        type: 'url_citation',
        url: 'https://x.test',
        title: 'Docs',
        start_index: 9,
        end_index: 13,
      },
    },
    {
      type: 'response.output_item.added',
      output_index: 2,
      item: {
        id: 'fc_up',
        type: 'function_call',
        call_id: 'call_1',
        name: 'weather',
        namespace: 'multi_agent_v1',
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '{"city":',
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 2,
      delta: '"Oslo"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 2,
      item: {
        id: 'fc_up',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'weather',
        namespace: 'multi_agent_v1',
        arguments: '{"city":"Oslo"}',
      },
    },
    {
      type: 'response.output_item.done',
      output_index: 3,
      item: { id: 'ws_up', type: 'web_search_call', status: 'completed' },
    },
    {
      type: 'response.output_item.added',
      output_index: 4,
      item: {
        id: 'ctc_up',
        type: 'custom_tool_call',
        status: 'in_progress',
        call_id: 'call_2',
        input: '',
        name: 'exec',
      },
    },
    {
      type: 'response.custom_tool_call_input.delta',
      output_index: 4,
      delta: '1+1\n',
    },
    {
      type: 'response.output_item.done',
      output_index: 4,
      item: {
        id: 'ctc_up',
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'call_2',
        input: '1+1\n',
        name: 'exec',
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_up',
        model: 'gpt-5-2025-08-07',
        status: 'completed',
        end_turn: false,
        service_tier: 'priority',
        usage: {
          input_tokens: 40,
          input_tokens_details: { cached_tokens: 32 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 60,
        },
      },
    },
  ];
  for (const event of sent) yield { data: JSON.stringify(event) };
}

test("an upstream's reply written back to the caller keeps what the model sent", async () => {
  const decoded = responses.decode(
    {
      model: 'coder',
      input: 'Weather in Oslo?',
      stream: true,
      reasoning: { summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    },
    new Headers(),
  );
  const sent = await Array.fromAsync(
    decoded.streamed(responses.events(upstream()), 'r1'),
  );
  expect(
    sent.flatMap(({ event, data }) =>
      event === 'response.output_item.done'
        ? [field(field(parsed(data), 'item'), 'type')]
        : [],
    ),
  ).toEqual([
    'reasoning',
    'message',
    'function_call',
    'web_search_call',
    'custom_tool_call',
  ]);
  expect(
    sent.flatMap(({ event }) =>
      event?.startsWith('response.custom_tool_call') ? [event] : [],
    ),
  ).toEqual([
    'response.custom_tool_call_input.delta',
    'response.custom_tool_call_input.done',
  ]);
  expect(parsed(sent.at(-1)?.data ?? '')).toMatchObject({
    type: 'response.completed',
    response: {
      id: 'resp_r1',
      model: 'coder',
      status: 'completed',
      end_turn: false,
      output: [
        {
          id: 'rs_up',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Look it up.' }],
          encrypted_content: 'gAAAAABo-whole',
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          phase: 'commentary',
          content: [
            {
              type: 'output_text',
              text: 'Checking Oslo.',
              annotations: [
                {
                  type: 'url_citation',
                  url: 'https://x.test',
                  title: 'Docs',
                  start_index: 9,
                  end_index: 13,
                },
              ],
            },
          ],
        },
        {
          type: 'function_call',
          status: 'completed',
          call_id: 'call_1',
          name: 'weather',
          namespace: 'multi_agent_v1',
          arguments: '{"city":"Oslo"}',
        },
        { id: 'ws_up', type: 'web_search_call', status: 'completed' },
        {
          id: 'ctc_r1_4',
          type: 'custom_tool_call',
          call_id: 'call_2',
          name: 'exec',
          input: '1+1\n',
        },
      ],
      usage: {
        input_tokens: 40,
        input_tokens_details: { cached_tokens: 32 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 12 },
        total_tokens: 60,
      },
    },
  });
  expect(sent.at(-1)?.data).not.toContain('service_tier');
});

test('a collected reply sent back as input reaches the upstream as the model wrote it', async () => {
  const all = await Array.fromAsync(responses.events(upstream()));
  const finish = all.at(-1);
  if (finish?.type !== 'finish') throw new Error('the reply did not finish');
  const reply = responses
    .decode({ model: 'coder', input: 'Weather in Oslo?' }, new Headers())
    .collected(
      all.filter((event): event is Chunk => event.type !== 'finish'),
      finish,
      'r1',
    );
  const output = field(reply, 'output');
  if (!Array.isArray(output)) throw new Error('the reply has no output');
  const { model: _, ...prompt } = responses.decode(
    {
      model: 'coder',
      input: [
        { role: 'user', content: 'Weather in Oslo?' },
        ...output,
        { type: 'function_call_output', call_id: 'call_1', output: '4C' },
        { type: 'custom_tool_call_output', call_id: 'call_2', output: '2' },
      ],
    },
    new Headers(),
  ).request;
  expect(field(responses.encode('gpt-5', prompt).body, 'input')).toEqual([
    { type: 'message', role: 'user', content: 'Weather in Oslo?' },
    // The caller asked for no summary, so none was shown; the item is whole.
    {
      id: 'rs_up',
      type: 'reasoning',
      summary: [],
      encrypted_content: 'gAAAAABo-whole',
    },
    {
      id: 'msg_r1_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      phase: 'commentary',
      content: [
        {
          type: 'output_text',
          text: 'Checking Oslo.',
          logprobs: [],
          annotations: [
            {
              type: 'url_citation',
              url: 'https://x.test',
              title: 'Docs',
              start_index: 9,
              end_index: 13,
            },
          ],
        },
      ],
    },
    {
      id: 'fc_r1_2',
      type: 'function_call',
      status: 'completed',
      call_id: 'call_1',
      name: 'weather',
      namespace: 'multi_agent_v1',
      arguments: '{"city":"Oslo"}',
    },
    { id: 'ws_up', type: 'web_search_call', status: 'completed' },
    {
      id: 'ctc_r1_4',
      type: 'custom_tool_call',
      call_id: 'call_2',
      name: 'exec',
      input: '1+1\n',
    },
    { type: 'function_call_output', call_id: 'call_1', output: '4C' },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: '2' },
  ]);
});

test("a Claude model's signed reasoning item reaches the caller as sent, and goes back upstream unchanged", async () => {
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
  async function* claude() {
    const sent = [
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
        output_index: 0,
        item_id: 'rs_tmp_z582ajgark',
        content_index: 0,
        part: { type: 'reasoning_text', text: '' },
      },
      {
        type: 'response.reasoning_text.delta',
        output_index: 0,
        item_id: 'rs_tmp_z582ajgark',
        content_index: 0,
        delta: 'Paris s',
      },
      {
        type: 'response.reasoning_text.delta',
        output_index: 0,
        item_id: 'rs_tmp_z582ajgark',
        content_index: 0,
        delta:
          "its further north than Lyon (48.86N vs 45.76N), so I'll check the weather for Paris.",
      },
      { type: 'response.output_item.done', output_index: 0, item },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          id: 'fc_tmp_3v5d0e8vm7b',
          type: 'function_call',
          status: 'in_progress',
          call_id: 'toolu_019o6fssKWToJo6JGRK6GkA6',
          name: 'get_weather',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        delta: '{"city": "Paris"}',
      },
      {
        type: 'response.completed',
        response: { id: 'gen-1791619700', model: 'anthropic/claude-haiku-5.5' },
      },
    ];
    for (const event of sent) yield { data: JSON.stringify(event) };
  }
  const asked = {
    model: 'relay',
    reasoning: { effort: 'low', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
  };
  const input = 'Which is further north, Paris or Lyon? Get its weather.';

  const sent = await Array.fromAsync(
    responses
      .decode({ ...asked, input, stream: true }, new Headers())
      .streamed(responses.events(claude()), 'r1'),
  );
  const done = sent
    .map(({ data }) => parsed(data))
    .find(
      (event) =>
        field(event, 'type') === 'response.output_item.done' &&
        field(event, 'output_index') === 0,
    );
  expect(JSON.stringify(field(done, 'item'))).toBe(JSON.stringify(item));

  const all = await Array.fromAsync(responses.events(claude()));
  const finish = all.at(-1);
  if (finish?.type !== 'finish') throw new Error('the reply did not finish');
  const reply = responses.decode({ ...asked, input }, new Headers()).collected(
    all.filter((event): event is Chunk => event.type !== 'finish'),
    finish,
    'r1',
  );
  const output = field(reply, 'output');
  if (!Array.isArray(output)) throw new Error('the reply has no output');
  expect(JSON.stringify(output[0])).toBe(JSON.stringify(item));

  const { model: _, ...prompt } = responses.decode(
    {
      ...asked,
      input: [
        { role: 'user', content: input },
        ...output,
        {
          type: 'function_call_output',
          call_id: 'toolu_019o6fssKWToJo6JGRK6GkA6',
          output: '{"temp_c":21,"sky":"sunny"}',
        },
      ],
    },
    new Headers(),
  ).request;
  const { body, leftOut } = responses.encode(
    'anthropic/claude-haiku-5.5',
    prompt,
  );
  const back = field(body, 'input');
  if (!Array.isArray(back)) throw new Error('the request has no input');
  expect(JSON.stringify(back[1])).toBe(JSON.stringify(item));
  expect(leftOut).toEqual([]);
});

test('an upstream failure is answered in the shape of this API', () => {
  const facts = responses.failure(
    429,
    new Headers({ 'retry-after': '2' }),
    '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}',
  );
  expect(facts).toMatchObject({
    code: 'quota_exceeded',
    retryAfter: 2000,
    provider: {
      'openai.responses': { status: 429, code: 'insufficient_quota' },
    },
  });
  expect(responses.error(facts)).toEqual({
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

test('a provider`s own reader names a failed response and both failures in a stream', async () => {
  const codec = responsesIn({}, (_, __, { message }) =>
    message === 'Insufficient Balance' ? { code: 'quota_exceeded' } : undefined,
  );
  const streamed = async (event: Json) =>
    Array.fromAsync(
      codec.events(
        (async function* () {
          yield { data: JSON.stringify(event) };
        })(),
      ),
    );

  expect(
    codec.failure(
      400,
      new Headers(),
      '{"error":{"message":"Insufficient Balance","code":"invalid_prompt"}}',
    ).code,
  ).toBe('quota_exceeded');
  expect(
    await streamed({
      type: 'response.failed',
      response: { error: { message: 'Insufficient Balance' } },
    }),
  ).toMatchObject([{ type: 'error', error: { code: 'quota_exceeded' } }]);
  expect(
    await streamed({ type: 'error', message: 'Insufficient Balance' }),
  ).toMatchObject([{ type: 'error', error: { code: 'quota_exceeded' } }]);
  expect(
    codec.failure(400, new Headers(), '{"error":{"message":"Bad request"}}')
      .code,
  ).toBe('invalid_request');
});

test('what the adapter cuts is cut from a failed response and from both failures in a stream', async () => {
  const cut = (text: string) => text.replaceAll('hunter2-hunter2', '[cut]');
  const streamed = async (event: Json) =>
    Array.fromAsync(
      responses.events(
        (async function* () {
          yield { data: JSON.stringify(event) };
        })(),
        cut,
      ),
    );

  expect(
    responses.failure(
      400,
      new Headers(),
      '{"error":{"message":"No key hunter2-hunter2","param":"hunter2-hunter2"}}',
      cut,
    ),
  ).toMatchObject({
    message: 'No key [cut]',
    provider: { 'openai.responses': { param: '[cut]' } },
  });
  expect(
    await streamed({
      type: 'response.failed',
      response: {
        error: { message: 'No key hunter2-hunter2', param: 'hunter2-hunter2' },
      },
    }),
  ).toMatchObject([
    {
      type: 'error',
      error: {
        message: 'No key [cut]',
        provider: { 'openai.responses': { param: '[cut]' } },
      },
    },
  ]);
  expect(
    await streamed({
      type: 'error',
      message: 'No key hunter2-hunter2',
      param: 'hunter2-hunter2',
    }),
  ).toMatchObject([
    {
      type: 'error',
      error: {
        message: 'No key [cut]',
        provider: { 'openai.responses': { param: '[cut]' } },
      },
    },
  ]);
});

test('a function sent with no strictness reaches either OpenAI API with none', () => {
  const tool = {
    type: 'function',
    name: 'weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' }, units: { type: 'string' } },
      required: ['city'],
    },
  };
  const { model: _, ...prompt } = responses.decode(
    { model: 'coder', input: 'Hi', tools: [tool] },
    new Headers(),
  ).request;

  expect(field(responses.encode('gpt-5', prompt).body, 'tools')).toEqual([
    tool,
  ]);
  expect(field(chatCompletions.encode('gpt-5', prompt).body, 'tools')).toEqual([
    {
      type: 'function',
      function: { name: 'weather', parameters: tool.parameters },
    },
  ]);
});

test('a tool echoed with null fields can be sent to any family', () => {
  const { tools } = responses.decode(
    {
      model: 'coder',
      input: 'Hi',
      tools: [
        {
          type: 'function',
          name: 'weather',
          description: null,
          parameters: { type: 'object' },
          strict: null,
          output_schema: null,
          allowed_callers: [],
        },
      ],
    },
    new Headers(),
  ).request;

  expect(tools).toEqual([
    { type: 'function', name: 'weather', input: { type: 'object' } },
  ]);
});

test('whatever the upstream, the reasoning a caller is streamed is the reasoning the finished item holds', async () => {
  async function* sse(...sent: Json[]) {
    for (const event of sent) yield { data: JSON.stringify(event) };
  }
  const sources = [
    {
      events: () => responses.events(upstream()),
      holds: 'summary',
      said: 'Look it up.',
    },
    {
      events: () =>
        responses.events(
          sse(
            {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: 'rs_tmp_v2j0j28jpob',
                type: 'reasoning',
                status: 'in_progress',
                summary: [],
              },
            },
            {
              type: 'response.content_part.added',
              output_index: 0,
              item_id: 'rs_tmp_v2j0j28jpob',
              content_index: 0,
              part: { type: 'reasoning_text', text: '' },
            },
            {
              type: 'response.reasoning_text.delta',
              output_index: 0,
              item_id: 'rs_tmp_v2j0j28jpob',
              content_index: 0,
              delta: 'The',
            },
            {
              type: 'response.reasoning_text.delta',
              output_index: 0,
              item_id: 'rs_tmp_v2j0j28jpob',
              content_index: 0,
              delta: ' user wants',
            },
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'rs_tmp_v2j0j28jpob',
                type: 'reasoning',
                status: 'completed',
                content: [{ type: 'reasoning_text', text: 'The user wants' }],
                summary: [],
              },
            },
            { type: 'response.completed', response: {} },
          ),
        ),
      holds: 'content',
      said: 'The user wants',
    },
    {
      events: () =>
        messages.events(
          sse(
            {
              type: 'message_start',
              message: {
                id: 'msg_011CZq7Lm2Xv9Rt4Kp8Wd3Nh',
                type: 'message',
                role: 'assistant',
                content: [],
                model: 'anthropic/claude-haiku-5.5',
                usage: { input_tokens: 28, output_tokens: 8 },
              },
            },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: '17×' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking: '23 breaks into 17×20 plus 17×3, giving 340+51=391.',
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'signature_delta',
                signature: 'CAQSggUKEAgSGAI4AUIIdGhpbmtpbmcSDDUuYHXC',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'text_delta', text: '391' },
            },
            { type: 'content_block_stop', index: 1 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 61 },
            },
            { type: 'message_stop' },
          ),
        ),
      holds: 'summary',
      said: '17×23 breaks into 17×20 plus 17×3, giving 340+51=391.',
    },
    {
      events: () =>
        chatCompletions.events(
          sse(
            {
              choices: [
                {
                  index: 0,
                  delta: { content: '', role: 'assistant', reasoning: 'We' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                {
                  index: 0,
                  delta: { content: '', role: 'assistant', reasoning: ' are' },
                  finish_reason: null,
                },
              ],
            },
            {
              choices: [
                { index: 0, delta: { content: '391' }, finish_reason: null },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ),
        ),
      holds: 'summary',
      said: 'We are',
    },
  ];
  for (const { events, holds, said } of sources) {
    const { streamed, collected } = responses.decode(
      { model: 'relay', input: 'Hi', reasoning: { summary: 'auto' } },
      new Headers(),
    );
    const frames = (await Array.fromAsync(streamed(events(), 'r1'))).map(
      ({ data }) => parsed(data),
    );
    const first = frames.filter((frame) => field(frame, 'output_index') === 0);
    const heard = (type: string, key: string) =>
      first
        .filter((frame) => field(frame, 'type') === type)
        .map((frame) => field(frame, key));
    const item = heard('response.output_item.done', 'item')[0];
    const held = (key: string) =>
      list(field(item, key)).map((part) => field(part, 'text'));

    expect(frames.map((frame) => field(frame, 'sequence_number'))).toEqual(
      frames.map((_, index) => index),
    );
    expect(field(item, 'type')).toBe('reasoning');
    expect(held(holds)).toEqual([said]);
    expect(held(holds === 'summary' ? 'content' : 'summary')).toEqual([]);
    expect(
      heard('response.reasoning_summary_text.delta', 'delta').join(''),
    ).toBe(held('summary').join(''));
    expect(heard('response.reasoning_text.delta', 'delta').join('')).toBe(
      held('content').join(''),
    );
    expect(heard('response.reasoning_summary_text.done', 'text')).toEqual(
      held('summary'),
    );
    expect(heard('response.reasoning_text.done', 'text')).toEqual(
      held('content'),
    );
    for (const part of ['reasoning_summary_part', 'content_part']) {
      expect(heard(`response.${part}.added`, 'part')).toHaveLength(
        heard(`response.${part}.done`, 'part').length,
      );
    }

    const all = await Array.fromAsync(events());
    const finish = all.at(-1);
    if (finish?.type !== 'finish') throw new Error('the reply did not finish');
    const whole = collected(
      all.filter((event): event is Chunk => event.type !== 'finish'),
      finish,
      'r1',
    );
    expect(list(field(whole, 'output'))[0]).toEqual(item);
  }
});

test('a caller who asked for a reasoning summary is sent progress as one', async () => {
  const { streamed, collected } = responses.decode(
    { model: 'coder', input: 'Hi', reasoning: { summary: 'auto' } },
    new Headers(),
  );
  async function* run(): RunStream {
    yield { type: 'progress', piece: 0, text: 'Routing to code' };
    yield { type: 'finish', reason: 'stop' };
  }

  const frames = await Array.fromAsync(streamed(run(), 'r1'));
  const reply = collected(
    [{ type: 'progress', piece: 0, text: 'Routing to code' }],
    { type: 'finish', reason: 'stop' },
    'r1',
  );

  expect(
    frames
      .filter(({ event }) => event === 'response.reasoning_summary_text.delta')
      .map(({ data }) => parsed(data)),
  ).toMatchObject([{ item_id: 'rs_r1_0', delta: 'Routing to code' }]);
  expect(field(reply, 'output')).toEqual([
    {
      id: 'rs_r1_0',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'Routing to code' }],
      content: [],
    },
  ]);
});

test('the reasoning item a caller was written is read back as the reasoning it held', () => {
  const { collected } = responses.decode(
    { model: 'relay', input: 'Hi', reasoning: { summary: 'auto' } },
    new Headers(),
  );
  const written = collected(
    [{ type: 'reasoning', text: 'Paris is north.', block: 0 }],
    { type: 'finish', reason: 'stop' },
    'r1',
  );

  expect(
    responses.decode(
      {
        model: 'relay',
        input: [
          { role: 'user', content: 'Hi' },
          ...list(field(written, 'output')),
        ],
      },
      new Headers(),
    ).request.messages,
  ).toEqual([
    { role: 'user', text: 'Hi' },
    {
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'Paris is north.',
          provider: {
            'openai.responses': {
              id: 'rs_r1_0',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Paris is north.' }],
              content: [],
            },
          },
        },
      ],
    },
  ]);
});

test('a caller who asked for no reasoning summary is sent no progress', async () => {
  async function* run(): RunStream {
    yield { type: 'progress', piece: 0, text: 'Routing to code' };
    yield { type: 'text', text: 'Use a loop.' };
    yield { type: 'finish', reason: 'stop' };
  }

  for (const reasoning of [undefined, { effort: 'high' }]) {
    const { streamed, collected } = responses.decode(
      {
        model: 'coder',
        input: 'Hi',
        ...(reasoning === undefined ? {} : { reasoning }),
      },
      new Headers(),
    );
    const frames = await Array.fromAsync(streamed(run(), 'r1'));
    const reply = collected(
      [
        { type: 'progress', piece: 0, text: 'Routing to code' },
        { type: 'text', text: 'Use a loop.' },
      ],
      { type: 'finish', reason: 'stop' },
      'r1',
    );

    expect(frames.map(({ data }) => data).join('\n')).not.toContain('Routing');
    expect(field(reply, 'output')).toMatchObject([{ type: 'message' }]);
  }
});

test('progress a caller sends back never reaches the upstream', () => {
  const { request } = responses.decode(
    {
      model: 'coder',
      input: [
        { role: 'user', content: 'Hi' },
        {
          id: 'rs_r1_0',
          type: 'reasoning',
          summary: [
            { type: 'summary_text', text: 'Routing to the fast model.' },
          ],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
        },
      ],
    },
    new Headers(),
  );

  expect(field(responses.encode('gpt-5', request).body, 'input')).toEqual([
    { type: 'message', role: 'user', content: 'Hi' },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
    },
  ]);
});

test('a JSON schema is held as strictly as its caller`s API holds it, on every API it goes to', () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } } };
  const asked = {
    chat: chatCompletions.decode(
      {
        model: 'coder',
        messages: [{ role: 'user', content: 'Hi' }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'city', schema },
        },
      },
      new Headers(),
    ),
    responses: responses.decode(
      {
        model: 'coder',
        input: 'Hi',
        text: { format: { type: 'json_schema', name: 'city', schema } },
      },
      new Headers(),
    ),
    messages: messages.decode(
      {
        model: 'coder',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hi' }],
        output_config: { format: { type: 'json_schema', schema } },
      },
      new Headers(),
    ),
  };
  for (const [caller, strict] of [
    ['chat', false],
    ['responses', true],
    ['messages', true],
  ] as const) {
    const { request } = asked[caller];
    expect(request.output).toMatchObject({ strict });
    expect(chatCompletions.encode('gpt-x', request).body).toMatchObject({
      response_format: { json_schema: { strict } },
    });
    expect(responses.encode('gpt-x', request).body).toMatchObject({
      text: { format: { strict } },
    });
  }
  // Anthropic always holds the answer to the schema, which a loose one is
  // not told, so that alone is reported.
  expect(
    messages.encode('claude-x', {
      messages: asked.responses.request.messages,
      output: { schema, strict: true },
    }).leftOut,
  ).toEqual([]);
  expect(
    messages.encode('claude-x', {
      messages: asked.chat.request.messages,
      output: { schema, strict: false },
    }).leftOut,
  ).toEqual([
    {
      setting: 'output.name',
      detail:
        'Anthropic Messages has no field for the name or description of a JSON output, or a schema held loosely',
    },
  ]);
  expect(
    responses.encode('gpt-x', {
      messages: [{ role: 'user', text: 'Hi' }],
      output: { schema },
    }).body,
  ).toMatchObject({ text: { format: { strict: false } } });
});

test.each([
  ['bare bytes', 'iVBORw0KGgo='],
  ['a data address', 'data:image/png;base64,iVBORw0KGgo='],
])(
  'a picture an upstream sent as %s with no format reaches a caller of each API that has a place for one',
  async (_, result) => {
    const item = {
      id: 'ig_1',
      type: 'image_generation_call',
      status: 'completed',
      result,
    };
    const made = () =>
      responses.events(
        (async function* () {
          yield {
            data: JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item,
            }),
          };
          yield {
            data: '{"type":"response.completed","response":{"status":"completed"}}',
          };
        })(),
      );
    const [chunk, finish] = await Array.fromAsync(made());
    if (chunk?.type !== 'file' || finish?.type !== 'finish') {
      throw new Error('The item was read as no file');
    }
    const images = [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
      },
    ];

    const chat = chatCompletions.decode(
      { model: 'coder', messages: [{ role: 'user', content: 'Draw' }] },
      new Headers(),
    );
    expect(chat.collected([chunk], finish, 'r1')).toMatchObject({
      choices: [{ message: { images } }],
    });
    const frames = await Array.fromAsync(chat.streamed(made(), 'r1'));
    expect(parsed(frames[0]?.data ?? '')).toMatchObject({
      choices: [{ delta: { images } }],
    });

    // The same API is written the item as the upstream sent it.
    const same = responses.decode(
      { model: 'coder', input: 'Draw' },
      new Headers(),
    );
    expect(same.collected([chunk], finish, 'r1')).toMatchObject({
      output: [item],
    });
    expect(
      parsed(
        (await Array.fromAsync(same.streamed(made(), 'r1'))).at(-1)?.data ?? '',
      ),
    ).toMatchObject({ response: { output: [item] } });

    // An answer of Anthropic Messages holds no picture, of any type.
    const claude = messages.decode(
      {
        model: 'coder',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Draw' }],
      },
      new Headers(),
    );
    expect(() => claude.collected([chunk], finish, 'r1')).toThrow(
      'Anthropic Messages has no form for a file the model made',
    );
    const ended = await Array.fromAsync(claude.streamed(made(), 'r1'));
    expect(ended.at(-1)?.data).toContain(
      'Anthropic Messages has no form for a file the model made',
    );
  },
);

test('a picture whose type neither the upstream nor its bytes say fails a caller of another API, and reaches one of this API', async () => {
  const item = {
    id: 'ig_1',
    type: 'image_generation_call',
    status: 'completed',
    result: 'Qk02AAAAAAAAADYAAAAoAAAA',
  };
  const made = () =>
    responses.events(
      (async function* () {
        yield {
          data: JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item,
          }),
        };
        yield {
          data: '{"type":"response.completed","response":{"status":"completed"}}',
        };
      })(),
    );
  const [chunk, finish] = await Array.fromAsync(made());
  if (chunk?.type !== 'provider' || finish?.type !== 'finish') {
    throw new Error('The item was given a type');
  }

  const chat = chatCompletions.decode(
    { model: 'coder', messages: [{ role: 'user', content: 'Draw' }] },
    new Headers(),
  );
  expect(() => chat.collected([chunk], finish, 'r1')).toThrow(
    'has no form for a part only another API can read',
  );
  const ended = await Array.fromAsync(chat.streamed(made(), 'r1'));
  expect(ended.at(-1)?.data).toContain(
    'has no form for a part only another API can read',
  );
  expect(
    responses
      .decode({ model: 'coder', input: 'Draw' }, new Headers())
      .collected([chunk], finish, 'r1'),
  ).toMatchObject({ output: [item] });
});

test('a call an Anthropic upstream ended is done for a caller of this API before the item of the next block opens', async () => {
  const { streamed } = responses.decode(
    { model: 'coder', input: 'Weather in Oslo?', stream: true },
    new Headers(),
  );
  const sent = await Array.fromAsync(
    streamed(
      messages.events(
        (async function* () {
          for (const event of [
            {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'weather',
              },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"city":"Oslo"}',
              },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'toolu_2', name: 'time' },
            },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
            { type: 'message_stop' },
          ]) {
            yield { data: JSON.stringify(event) };
          }
        })(),
      ),
      'r1',
    ),
  );
  expect(
    sent.flatMap(({ event, data }) =>
      event === 'response.output_item.added' ||
      event === 'response.output_item.done'
        ? [[event, field(field(parsed(data), 'item'), 'call_id')]]
        : [],
    ),
  ).toEqual([
    ['response.output_item.added', 'toolu_1'],
    ['response.output_item.done', 'toolu_1'],
    ['response.output_item.added', 'toolu_2'],
    ['response.output_item.done', 'toolu_2'],
  ]);
  expect(parsed(sent.at(-1)?.data ?? '')).toMatchObject({
    response: {
      output: [
        {
          call_id: 'toolu_1',
          status: 'completed',
          arguments: '{"city":"Oslo"}',
        },
        { call_id: 'toolu_2', status: 'completed', arguments: '{}' },
      ],
    },
  });
});

test.each([
  [
    'Chat Completions',
    chatCompletions.decode(
      { model: 'coder', messages: [{ role: 'user', content: 'Hi' }] },
      new Headers(),
    ),
  ],
  [
    'Anthropic Messages',
    messages.decode(
      {
        model: 'coder',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      new Headers(),
    ),
  ],
  [
    'Responses',
    responses.decode({ model: 'coder', input: 'Hi' }, new Headers()),
  ],
])(
  'a caller of %s is sent nothing of the word that a call ended, and no more frames for a chunk that says only that',
  async (_, { streamed }) => {
    async function* run(ended: Chunk[]): RunStream {
      yield {
        type: 'tool_call',
        id: 'call_1',
        name: 'weather',
        arguments: '{}',
      };
      yield* ended;
      yield { type: 'text', text: 'Done.' };
      yield { type: 'finish', reason: 'tool_calls' };
    }

    const frames = await Array.fromAsync(
      streamed(
        run([{ type: 'tool_call', id: 'call_1', arguments: '', ended: true }]),
        'r1',
      ),
    );

    expect(frames.filter(({ data }) => data.includes('ended'))).toEqual([]);
    expect(frames).toHaveLength(
      (await Array.fromAsync(streamed(run([]), 'r1'))).length,
    );
  },
);
