import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { Chunk } from '@mottyjs/core/host';
import { chatCompletions, messages, responses } from '../src/index.ts';
import { events } from '../src/messages/events.ts';

async function* sse(...sent: { type: string; [field: string]: unknown }[]) {
  for (const event of sent) {
    yield { event: event.type, data: JSON.stringify(event) };
  }
}

test('a tool only another API runs is offered to a model of another family by leaving it out, and said so', () => {
  const { request } = responses.decode(
    {
      model: 'relay',
      input: 'Fix the bug.',
      tools: [
        { type: 'web_search', external_web_access: false },
        { type: 'file_search', vector_store_ids: ['vs_1'] },
        { type: 'function', name: 'shell', parameters: { type: 'object' } },
      ],
    },
    new Headers(),
  );

  for (const codec of [messages, chatCompletions]) {
    const { body, leftOut } = codec.encode('model-x', request);
    expect(JSON.stringify(body)).not.toContain('web_search');
    expect(JSON.stringify(body)).not.toContain('file_search');
    expect(JSON.stringify(body)).toContain('shell');
    expect(leftOut.map(({ setting }) => setting)).toEqual(['tool.offered']);
  }
  expect(responses.encode('model-x', request).body).toMatchObject({
    tools: [
      { type: 'web_search', external_web_access: false },
      { type: 'file_search', vector_store_ids: ['vs_1'] },
      { type: 'function', name: 'shell' },
    ],
  });
});

test('a tool choice is not sent when every tool it chose among was only offered and left out', () => {
  const asked = responses.decode(
    {
      model: 'relay',
      input: 'Look it up.',
      tools: [{ type: 'web_search', external_web_access: false }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    },
    new Headers(),
  ).request;
  for (const codec of [messages, chatCompletions]) {
    const { body } = codec.encode('model-x', asked);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('parallel_tool_calls');
  }

  const { body } = responses.encode(
    'gpt-x',
    messages.decode(
      {
        model: 'relay',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Look it up.' }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      },
      new Headers({ 'anthropic-version': '2023-06-01' }),
    ).request,
  );
  expect(body).not.toHaveProperty('tools');
  expect(body).not.toHaveProperty('tool_choice');
  expect(body).not.toHaveProperty('parallel_tool_calls');
});

const search = {
  type: 'tool_search',
  execution: 'client',
  description: 'Searches deferred tools.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

const found = [
  { type: 'message', role: 'user', content: 'Echo ping.' },
  {
    type: 'tool_search_call',
    id: 'tsc_1',
    call_id: 'toolu_1',
    status: 'completed',
    execution: 'client',
    arguments: { query: 'mini echo' },
  },
  {
    type: 'tool_search_output',
    id: 'tso_1',
    call_id: 'toolu_1',
    status: 'completed',
    execution: 'client',
    tools: [
      {
        type: 'namespace',
        name: 'mcp__mini',
        description: 'Tools in the mcp__mini namespace.',
        tools: [
          {
            type: 'function',
            name: 'echo',
            description: 'Says the given text back.',
            strict: false,
            defer_loading: true,
            parameters: { type: 'object' },
          },
        ],
      },
    ],
  },
];

test('a tool of its own type that the caller runs goes to another family as a function, and its call comes back as that type', () => {
  const decoded = responses.decode(
    { model: 'relay', input: 'Echo ping.', tools: [search] },
    new Headers(),
  );

  expect(messages.encode('model-x', decoded.request).body).toMatchObject({
    tools: [
      {
        name: 'tool_search',
        description: 'Searches deferred tools.',
        input_schema: search.parameters,
      },
    ],
  });
  expect(responses.encode('model-x', decoded.request).body).toMatchObject({
    tools: [search],
  });
  expect(
    decoded.collected(
      [
        {
          type: 'tool_call',
          id: 'toolu_1',
          name: 'tool_search',
          arguments: '{"query":',
        },
        { type: 'tool_call', id: 'toolu_1', arguments: '"mini echo"}' },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'r1',
    ),
  ).toMatchObject({
    output: [
      {
        type: 'tool_search_call',
        call_id: 'toolu_1',
        execution: 'client',
        status: 'completed',
        arguments: { query: 'mini echo' },
      },
    ],
  });
});

test('the tools a search the caller ran has found are declared to another family from then on, and called in their namespace', () => {
  const decoded = responses.decode(
    { model: 'relay', input: found, tools: [search] },
    new Headers(),
  );

  const { body, leftOut } = messages.encode('model-x', decoded.request);
  expect(body).toMatchObject({
    tools: [
      { name: 'tool_search' },
      { name: 'mcp__mini__echo', description: 'Says the given text back.' },
    ],
    messages: [
      { role: 'user' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'tool_search',
            input: { query: 'mini echo' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: 'mcp__mini__echo: Says the given text back.',
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain('defer_loading');
  expect(leftOut).toEqual([]);
  expect(responses.encode('model-x', decoded.request).body).toMatchObject({
    tools: [search],
    input: found,
  });
  expect(
    decoded.collected(
      [
        {
          type: 'tool_call',
          id: 'toolu_2',
          name: 'mcp__mini__echo',
          arguments: '{"text":"ping"}',
        },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'r1',
    ),
  ).toMatchObject({
    output: [
      {
        type: 'function_call',
        namespace: 'mcp__mini',
        name: 'echo',
        arguments: '{"text":"ping"}',
      },
    ],
  });
});

test('a tool under the provider`s shared key is one only another API runs, since its two APIs share no shape for one', () => {
  const { body, leftOut } = chatCompletions.encode('gpt-x', {
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [{ type: 'provider', provider: { openai: { type: 'web_search' } } }],
  });

  expect(body).not.toHaveProperty('tools');
  expect(leftOut.map(({ setting }) => setting)).toEqual(['tool.offered']);
});

test('a tool only another API runs that the tool choice requires fails the call', () => {
  const { request } = messages.decode(
    {
      model: 'relay',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Look it up.' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    },
    new Headers(),
  );

  expect(() => responses.encode('model-x', request)).toThrow(Unsupported);
  expect(() => chatCompletions.encode('model-x', request)).toThrow(
    'Chat Completions cannot carry a tool only another API runs, which the tool choice names',
  );
});

test('a free-form custom tool goes to Anthropic Messages as a tool that takes its text in one field, and said so', () => {
  const { request } = responses.decode(
    {
      model: 'relay',
      input: 'Fix the bug.',
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Edit files.',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: 'start: "*** Begin Patch" /(.|\\n)*/',
          },
        },
      ],
    },
    new Headers(),
  );

  const { body, leftOut } = messages.encode('model-x', request);

  expect(body).toMatchObject({
    tools: [
      {
        name: 'apply_patch',
        description:
          'Edit files.\n\nThe input follows this lark grammar:\nstart: "*** Begin Patch" /(.|\\n)*/',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      },
    ],
  });
  expect(leftOut).toEqual([
    {
      setting: 'tool.custom',
      detail:
        'Anthropic Messages has no field for a free-form custom tool, sent as a tool that takes its text in one field',
    },
  ]);
});

test('a call to a custom tool an Anthropic upstream answers is told as its free text, which a Responses caller is written whole', async () => {
  const read: Chunk[] = [];
  for await (const event of events(
    sse(
      {
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 9 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'apply_patch',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"input": "*** Begin',
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ' Patch\\n"}' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { output_tokens: 7 },
      },
      { type: 'message_stop' },
    ),
    undefined,
    [{ type: 'custom', name: 'apply_patch' }],
  )) {
    if (event.type !== 'finish' && event.type !== 'error') read.push(event);
  }

  expect(read).toEqual([
    {
      type: 'tool_call',
      id: 'toolu_1',
      name: 'apply_patch',
      arguments: '',
      block: 0,
    },
    {
      type: 'tool_call',
      id: 'toolu_1',
      arguments: '*** Begin Patch\n',
      block: 0,
    },
  ]);
  const decoded = responses.decode(
    {
      model: 'relay',
      input: 'Fix the bug.',
      tools: [{ type: 'custom', name: 'apply_patch' }],
    },
    new Headers(),
  );
  expect(
    decoded.collected(read, { type: 'finish', reason: 'tool_calls' }, 'r1'),
  ).toMatchObject({
    output: [
      {
        type: 'custom_tool_call',
        call_id: 'toolu_1',
        name: 'apply_patch',
        input: '*** Begin Patch\n',
      },
    ],
  });
});

const spaced = {
  type: 'namespace',
  name: 'mcp__mini',
  description: 'Tools of the mini server.',
  tools: [
    {
      type: 'function',
      name: 'echo',
      description: 'Says it back.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
    { type: 'function', name: 'ping', parameters: { type: 'object' } },
  ],
};

test('the tools of a namespace go to a family with none under flat names, and to the Responses API in their namespace', () => {
  const { request } = responses.decode(
    {
      model: 'relay',
      input: 'Ping the server.',
      tools: [
        { type: 'function', name: 'shell', parameters: { type: 'object' } },
        spaced,
      ],
    },
    new Headers(),
  );

  const { body, leftOut } = messages.encode('model-x', request);
  expect(body).toMatchObject({
    tools: [
      { name: 'shell' },
      { name: 'mcp__mini__echo', description: 'Says it back.' },
      { name: 'mcp__mini__ping' },
    ],
  });
  expect(leftOut).toEqual([]);
  expect(chatCompletions.encode('model-x', request).body).toMatchObject({
    tools: [
      { function: { name: 'shell' } },
      { function: { name: 'mcp__mini__echo' } },
      { function: { name: 'mcp__mini__ping' } },
    ],
  });
  expect(responses.encode('model-x', request).body).toMatchObject({
    tools: [
      { type: 'function', name: 'shell', parameters: { type: 'object' } },
      spaced,
    ],
  });
});

test('a call an upstream of another family makes under a flat name reaches a Responses caller in its namespace', () => {
  const decoded = responses.decode(
    { model: 'relay', input: 'Ping the server.', tools: [spaced] },
    new Headers(),
  );

  expect(
    decoded.collected(
      [
        {
          type: 'tool_call',
          id: 'toolu_1',
          name: 'mcp__mini__ping',
          arguments: '{}',
        },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'r1',
    ),
  ).toMatchObject({
    output: [
      {
        type: 'function_call',
        call_id: 'toolu_1',
        namespace: 'mcp__mini',
        name: 'ping',
        arguments: '{}',
      },
    ],
  });
});

test('a flat name another tool already has, or one no family takes, is made apart, and still reaches the caller in its namespace', () => {
  const decoded = responses.decode(
    {
      model: 'relay',
      input: 'Ping the server.',
      tools: [
        {
          type: 'function',
          name: 'mcp__mini__ping',
          parameters: { type: 'object' },
        },
        spaced,
        {
          type: 'namespace',
          name: 'mcp.docs',
          tools: [{ type: 'function', name: 'find' }],
        },
      ],
    },
    new Headers(),
  );
  const names = decoded.request.tools?.map((tool) =>
    tool.type === 'provider' ? '' : tool.name,
  );

  expect(new Set(names).size).toBe(4);
  for (const name of names ?? []) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  const [, , ping = '', find = ''] = names ?? [];
  expect(ping).not.toBe('mcp__mini__ping');
  expect(
    decoded.collected(
      [
        { type: 'tool_call', id: 'toolu_1', name: ping, arguments: '{}' },
        { type: 'tool_call', id: 'toolu_2', name: find, arguments: '{}' },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'r1',
    ),
  ).toMatchObject({
    output: [
      { call_id: 'toolu_1', namespace: 'mcp__mini', name: 'ping' },
      { call_id: 'toolu_2', namespace: 'mcp.docs', name: 'find' },
    ],
  });
});

test('what a Claude model went on from before a search found more tools is told by its text alone, since its signature is bound to the tools it was shown', () => {
  const [asked, call, output] = found;
  const thought = (text: string, signature: string) => ({
    type: 'reasoning',
    summary: [{ type: 'summary_text', text }],
    encrypted_content: JSON.stringify({ anthropic: { signature } }),
  });
  const { request } = responses.decode(
    {
      model: 'relay',
      input: [
        asked ?? {},
        thought('Search first.', 'S1'),
        call ?? {},
        output ?? {},
        thought('Now echo.', 'S2'),
        {
          type: 'function_call',
          call_id: 'toolu_2',
          namespace: 'mcp__mini',
          name: 'echo',
          arguments: '{"text":"ping"}',
        },
      ],
      tools: [search],
    },
    new Headers(),
  );

  const { body, leftOut } = messages.encode('model-x', request);

  expect(JSON.stringify(body)).not.toContain('S1');
  expect(body).toMatchObject({
    messages: [
      { role: 'user' },
      { role: 'assistant', content: [{ type: 'tool_use' }] },
      { role: 'user', content: [{ type: 'tool_result' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Now echo.', signature: 'S2' },
          { type: 'tool_use', name: 'mcp__mini__echo' },
        ],
      },
    ],
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning']);
});
