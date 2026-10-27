import { expect, test } from 'bun:test';
import type {
  ChatRequest,
  Closed,
  Draft,
  Json,
  JsonOutput,
  Message,
  Options,
  Part,
  Prompt,
  ReadonlyJson,
  StandardSchema,
  Tool,
  ToolChoice,
} from '../../src/data/message.ts';
import { said } from '../../src/data/message.ts';

function request(): ChatRequest {
  return {
    id: 'req_1',
    model: 'acme/coder:max',
    messages: [
      { role: 'system', text: 'Be brief.' },
      { role: 'user', text: 'Why does this deadlock?' },
    ],
    tools: [],
    options: {},
    headers: new Headers({ 'x-conversation-id': 'c1' }),
  };
}

function summary(): StandardSchema<unknown, { summary: string }> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => ({ value: { summary: 'Fixed the parser' } }),
    },
  };
}

test('text is the shorthand for a message', () => {
  const message: Message = { role: 'system', text: 'Be brief.' };
  const text: string | undefined = message.text;

  expect(text).toBe('Be brief.');
});

test('a message is an ordered list of every kind of part', () => {
  const parts = [
    { type: 'text', text: 'See the diff' },
    { type: 'image', url: 'https://example.com/diff.png' },
    { type: 'image', id: 'file_1' },
    { type: 'file', name: 'a.pdf', data: 'JVBERi0=', mediaType: 'x/pdf' },
    { type: 'file', name: 'notes', data: 'bm90ZXM=' },
    { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' },
    { type: 'reasoning', text: 'The lock order differs' },
    { type: 'tool_call', id: 'call_1', name: 'read', input: { path: 'a' } },
    { type: 'tool_call', id: 'call_2', name: 'read', raw: '{"path":"a' },
    { type: 'tool_call', id: 'call_3', name: 'web', input: {}, hosted: true },
    { type: 'tool_result', id: 'call_1', text: 'contents' },
    { type: 'tool_result', id: 'call_2', failed: true, parts: [] },
    { type: 'tool_result', id: 'call_3', hosted: true, text: 'found' },
    { type: 'citation', title: 'Docs', url: 'https://example.com' },
    { type: 'refusal', text: 'I cannot help with that.' },
    { type: 'provider', provider: { openai: { type: 'compaction' } } },
  ] satisfies Part[];
  const message: Message = { role: 'assistant', parts };

  expect(message.parts?.map((part) => part.type)).toEqual([
    'text',
    'image',
    'image',
    'file',
    'file',
    'audio',
    'reasoning',
    'tool_call',
    'tool_call',
    'tool_call',
    'tool_result',
    'tool_result',
    'tool_result',
    'citation',
    'refusal',
    'provider',
  ]);
});

test('a message has text or parts, never both and never neither', () => {
  // @ts-expect-error
  const both: Message = { role: 'user', text: 'a', parts: [] };
  // @ts-expect-error
  const neither: Message = { role: 'user' };
  // @ts-expect-error
  const unknownRole: Message = { role: 'narrator', text: 'a' };

  expect([both, neither, unknownRole]).toHaveLength(3);
});

test('a tool call has parsed input or raw arguments, never both', () => {
  const both: Part = {
    type: 'tool_call',
    id: 'c',
    name: 'read',
    input: {},
    // @ts-expect-error
    raw: '{',
  };
  // @ts-expect-error
  const neither: Part = { type: 'tool_call', id: 'c', name: 'read' };

  expect([both, neither]).toHaveLength(2);
});

test('a developer message and a named message are messages', () => {
  const messages: Message[] = [
    { role: 'developer', text: 'Answer in French.' },
    { role: 'user', name: 'ada', text: 'Bonjour' },
  ];

  expect(messages.map((message) => message.role)).toEqual([
    'developer',
    'user',
  ]);
});

test('a part, a message and a function tool carry a cache breakpoint', () => {
  const part: Part = { type: 'text', text: 'A long file', cache: {} };
  const message: Message = {
    role: 'system',
    text: 'A long preamble',
    cache: { ttl: '1h' },
  };
  const tool: Tool = {
    type: 'function',
    name: 'read',
    input: { type: 'object' },
    cache: { ttl: '5m' },
  };
  // @ts-expect-error
  const unknownTtl: Message = { role: 'user', text: 'a', cache: { ttl: '2h' } };

  expect([part, message, tool, unknownTtl]).toHaveLength(4);
});

test('a part keeps what only its provider family reads', () => {
  const reasoning: Part = {
    type: 'reasoning',
    text: 'The lock order differs',
    provider: { anthropic: { signature: 'EqQBCg==' } },
  };
  const cached: Message = {
    role: 'user',
    text: 'A long file',
    provider: { anthropic: { cache_control: { type: 'ephemeral' } } },
  };

  expect(reasoning.provider).toEqual({ anthropic: { signature: 'EqQBCg==' } });
  expect(cached.provider).toBeDefined();
});

test('whatever carries provider data carries droppable hints beside it', () => {
  const options: Options = { hints: { openai: { prompt_cache_key: 'k1' } } };
  const part: Part = { type: 'text', text: 'A long file', hints: {} };
  const opaque: Part = { type: 'provider', provider: {}, hints: {} };
  const message: Message = { role: 'user', text: 'Hello', hints: {} };
  const tools = [
    { type: 'function', name: 'read', input: {}, hints: {} },
    { type: 'custom', name: 'shell', hints: {} },
    { type: 'provider', provider: {}, hints: {} },
  ] satisfies Tool[];

  expect([options, part, opaque, message, ...tools]).toHaveLength(7);
});

test('the data holds no functions and no class instances', () => {
  const part: Part = {
    type: 'tool_call',
    id: 'call_1',
    name: 'read',
    // @ts-expect-error
    input: { now: () => 1 },
  };
  // @ts-expect-error
  const provider: Part = { type: 'provider', provider: { at: new Date(0) } };

  expect([part, provider]).toHaveLength(2);
});

test('the last user message is read as optional text', () => {
  const { messages } = request();
  const question: string | undefined = messages.findLast(
    (message) => message.role === 'user',
  )?.text;

  expect(question).toBe('Why does this deadlock?');
});

test('a request is read-only', () => {
  const read = request();
  // @ts-expect-error
  read.model = 'acme/other';
  // @ts-expect-error
  read.messages = [];
  // @ts-expect-error
  read.messages.push({ role: 'user', text: 'more' });
  // @ts-expect-error
  read.options.maxTokens = 1;
  // @ts-expect-error
  read.headers = new Headers();

  expect(read.id).toBe('req_1');
});

test('a request is read-only at every depth', () => {
  const read: ChatRequest = {
    ...request(),
    messages: [
      { role: 'user', text: 'Why does this deadlock?', cache: { ttl: '5m' } },
      { role: 'user', parts: [{ type: 'text', text: 'See the diff' }] },
    ],
    tools: [{ type: 'function', name: 'read', input: {} }],
    options: { reasoning: { effort: 'low' }, stop: ['END'] },
    output: { strict: true },
  };
  const [first, second] = read.messages;
  const [tool] = read.tools;
  const { reasoning, stop } = read.options;
  const { cache } = first ?? {};
  const { parts } = second ?? {};
  const { output } = read;
  if (
    first === undefined ||
    tool === undefined ||
    cache === undefined ||
    parts === undefined ||
    reasoning === undefined ||
    stop === undefined ||
    output === undefined
  ) {
    throw new Error('The request is not the one made above');
  }
  // @ts-expect-error
  first.text = 'Ignore the above';
  // @ts-expect-error
  first.role = 'system';
  // @ts-expect-error
  cache.ttl = '1h';
  // @ts-expect-error
  const push: unknown = parts.push;
  // @ts-expect-error
  tool.name = 'write';
  // @ts-expect-error
  reasoning.effort = 'max';
  // @ts-expect-error
  const more: unknown = stop.push;
  // @ts-expect-error
  output.strict = false;
  // @ts-expect-error
  output.schema = {};

  expect([typeof push, typeof more]).toEqual(['function', 'function']);
});

test('JSON narrows to a list, a map or a scalar', () => {
  function kind(value: Json): string {
    if (typeof value !== 'object' || value === null) return 'scalar';
    if (!Array.isArray(value)) {
      const map: { [key: string]: Json } = value;
      return Object.keys(map).join();
    }
    const list: Json[] = value;
    return String(list.length);
  }

  expect([kind(1), kind({ depth: 2 }), kind(['a', 'b'])]).toEqual([
    'scalar',
    'depth',
    '2',
  ]);
});

test('JSON that is passed in may be read-only, and JSON that is held may not', () => {
  const schema = { type: 'object', required: ['paths'] } as const;
  const taken: ReadonlyJson = schema;
  const held: Json = { type: 'object', required: ['paths'] };
  const passed: ReadonlyJson = held;
  // @ts-expect-error
  const refused: Json = schema;

  expect([taken, passed, refused]).toEqual([schema, held, schema]);
});

test('closed data is read-only at every depth', () => {
  const caller: Closed<{ id: string; teams: { name: string }[] }> = {
    id: 'user_1',
    teams: [{ name: 'core' }],
  };
  const [team] = caller.teams;
  if (team === undefined) throw new Error('The caller is not the one above');
  // @ts-expect-error
  caller.id = 'user_2';
  // @ts-expect-error
  const push: unknown = caller.teams.push;
  // @ts-expect-error
  team.name = 'docs';

  expect([caller.id, team.name, typeof push]).toEqual([
    'user_2',
    'docs',
    'function',
  ]);
});

test('closing stops at JSON, which still narrows', () => {
  const settings: Closed<{ [group: string]: Json }> = {
    coder: { effort: 'high' },
    lanes: ['fast', 'deep'],
  };
  const { coder, lanes } = settings;
  // @ts-expect-error
  settings.coder = {};
  const group: { [key: string]: Json } =
    typeof coder === 'object' && coder !== null && !Array.isArray(coder)
      ? coder
      : {};
  const count = Array.isArray(lanes) ? lanes.push('slow') : 0;

  expect([group, count]).toEqual([{ effort: 'high' }, 3]);
});

test('a function in closed data is still called, and a branded scalar is still its scalar', async () => {
  const kept = new Map<string, Json>();
  const supplied: Closed<{
    storage: {
      get: (key: string) => Promise<Json | undefined>;
      set: (key: string, value: Json) => Promise<void>;
    };
    code: 'rate_limited' | (string & {});
  }> = {
    storage: {
      get: async (key) => kept.get(key),
      set: async (key, value) => {
        kept.set(key, value);
      },
    },
    code: 'teapot',
  };
  await supplied.storage.set('turn', 3);
  const turn = await supplied.storage.get('turn');
  const code: string = supplied.code;
  // @ts-expect-error
  supplied.storage.get = async () => undefined;

  expect([turn, code]).toEqual([3, 'teapot']);
});

test('a closed request is passed on as a prompt, its messages and tools as they are', () => {
  function sent(prompt: Prompt<JsonOutput>): Prompt<JsonOutput> {
    return prompt;
  }
  const read: ChatRequest = {
    ...request(),
    messages: [
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', id: 'call_1', name: 'read', input: ['a', 'b'] },
        ],
      },
    ],
    output: { strict: true },
  };
  const { messages, tools, options, output } = read;
  const picked = sent({
    messages,
    tools,
    options,
    ...(output === undefined ? {} : { output }),
  });

  expect([sent(read).messages, picked.messages, picked.output]).toEqual([
    messages,
    messages,
    output,
  ]);
});

test('a request carries every header and the caller schema', () => {
  const read: ChatRequest = {
    ...request(),
    output: { schema: { type: 'object' } },
  };
  const conversation: string | null = read.headers.get('X-Conversation-Id');
  const output: JsonOutput | undefined = read.output;

  expect(conversation).toBe('c1');
  expect(output).toEqual({ schema: { type: 'object' } });
});

test('tools pass through as data', () => {
  const tools = [
    {
      type: 'function',
      name: 'read',
      description: 'Read a file',
      input: { type: 'object', properties: { path: { type: 'string' } } },
      strict: true,
    },
    {
      type: 'custom',
      name: 'patch',
      description: 'Apply a patch',
      grammar: { syntax: 'lark', definition: 'start: /.+/' },
    },
    { type: 'custom', name: 'shell' },
    {
      type: 'provider',
      name: 'web_search',
      provider: { anthropic: { type: 'web_search_20250305', max_uses: 3 } },
    },
    {
      type: 'provider',
      cache: { ttl: '1h' },
      provider: { openai: { type: 'web_search' } },
    },
  ] satisfies Tool[];
  const read: ChatRequest = { ...request(), tools };

  expect(read.tools.length).toBe(5);
});

test('a tool choice names a mode, one tool or the tools allowed', () => {
  const choices = [
    'auto',
    'none',
    'required',
    { tool: 'read' },
    { allowed: ['read', 'patch'], mode: 'required' },
    {
      provider: { openai: { type: 'mcp', server_label: 'docs', name: 'find' } },
    },
  ] satisfies ToolChoice[];
  // @ts-expect-error
  const noMode: ToolChoice = { allowed: ['read'] };
  // @ts-expect-error
  const noneAllowed: ToolChoice = { allowed: [], mode: 'auto' };

  expect([...choices, noMode, noneAllowed]).toHaveLength(8);
});

test('a prompt is mutable and starts from the request', () => {
  const read = request();
  const prompt: Prompt = { messages: [...read.messages] };

  prompt.messages = [
    { role: 'system', text: 'Earlier in this session: ...' },
    ...prompt.messages.slice(1),
  ];
  prompt.options = { ...prompt.options, reasoning: { effort: 'high' } };
  prompt.tools = [...read.tools];

  expect(prompt.messages).toHaveLength(2);
  expect(prompt.options).toEqual({ reasoning: { effort: 'high' } });
});

test('known options are typed and unknown ones ride under their wire', () => {
  const options = {
    toolChoice: { tool: 'read' },
    parallelToolCalls: false,
    reasoning: { effort: 'xhigh', budgetTokens: 8000, exclude: true },
    stop: ['\n\n'],
    maxTokens: 1024,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    seed: 7,
    presencePenalty: 0.1,
    frequencyPenalty: 0.2,
    user: 'user_1',
    provider: { openai: { logit_bias: { '50256': -100 } } },
  } satisfies Options;
  const budgetOnly: Options = { reasoning: { budgetTokens: 2000 } };
  // @ts-expect-error
  const misspelled: Options = { maxTokns: 1024 };
  // @ts-expect-error
  const unknownEffort: Options = { reasoning: { effort: 'extreme' } };
  // @ts-expect-error
  const flat: Options = { extra: { logit_bias: { '50256': -100 } } };

  expect(options.provider.openai.logit_bias).toEqual({ '50256': -100 });
  expect([budgetOnly, misspelled, unknownEffort, flat]).toHaveLength(4);
});

test('a prompt asks for output with a Standard Schema or a JSON output', () => {
  const read = request();
  const validated: Prompt = { messages: [], output: summary() };
  const passedThrough: Prompt = {
    messages: [...read.messages],
    output: {
      schema: { type: 'object' },
      name: 'summary',
      description: 'What changed',
      strict: true,
    },
  };
  const anyObject: Prompt = { messages: [], output: {} };
  // @ts-expect-error
  const bareSchema: Prompt = { messages: [], output: { type: 'object' } };
  // @ts-expect-error
  const neither: Prompt = { messages: [], output: 'json' };

  expect([
    validated,
    passedThrough,
    anyObject,
    bareSchema,
    neither,
  ]).toHaveLength(5);
});

test('the output type is inferred from the schema a prompt carries', () => {
  function outputOf<Output>(prompt: Prompt<StandardSchema<unknown, Output>>) {
    return prompt.output?.['~standard'].types?.output;
  }
  const prompt = { messages: [], output: summary() };
  const inferred: { summary: string } | undefined = outputOf(prompt);
  // @ts-expect-error
  const wrong: { files: string[] } | undefined = outputOf(prompt);
  const derived: Prompt<StandardSchema<unknown, { summary: string }>> = {
    ...prompt,
    messages: [{ role: 'user', text: 'Outline the approach.' }],
  };

  expect([inferred, wrong]).toEqual([undefined, undefined]);
  expect(derived.output).toBe(prompt.output);
});

test('what a caller sent is passed on as a prompt without a copy', () => {
  function sent(prompt: Prompt): Prompt {
    return prompt;
  }
  const read = request();
  const whole = sent(read);
  const picked = sent({
    messages: read.messages,
    tools: read.tools,
    options: read.options,
  });

  expect([whole.messages, picked.messages, picked.tools]).toEqual([
    read.messages,
    read.messages,
    read.tools,
  ]);
});

test('a prompt takes read-only lists at every depth', () => {
  const parts: readonly Part[] = [{ type: 'text', text: 'See the diff' }];
  const stop: readonly string[] = ['END'];
  const allowed: readonly [string, ...string[]] = ['read'];
  const prompt: Prompt = {
    messages: [
      { role: 'user', parts },
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'read',
            input: { paths: ['a', 'b'] } as const,
          },
        ],
      },
    ] as const,
    tools: [
      {
        type: 'function',
        name: 'read',
        input: { type: 'object', required: ['paths'] },
      },
    ] as const,
    options: { stop, toolChoice: { allowed, mode: 'auto' } },
  };

  expect(prompt.options?.stop).toBe(stop);
});

test('a prompt still refuses what is not a message', () => {
  const texts: readonly string[] = ['Why does this deadlock?'];
  // @ts-expect-error
  const prompt: Prompt = { messages: texts };
  const none: readonly string[] = [];
  const choice: ToolChoice = {
    // @ts-expect-error
    allowed: none,
    mode: 'auto',
  };

  expect(prompt.messages).toHaveLength(1);
  expect(choice).toHaveProperty('allowed', none);
});

test('a list in a prompt is replaced, not changed in place', () => {
  const prompt: Prompt = { messages: [] };
  prompt.messages = [...prompt.messages, { role: 'user', text: 'Go on' }];
  // @ts-expect-error
  const push: unknown = prompt.messages.push;

  expect([prompt.messages.length, typeof push]).toEqual([1, 'function']);
});

test('what a context holds of a prompt is changed in place, takes the messages of the caller, and is still a prompt', () => {
  function sent(prompt: Prompt): Prompt {
    return prompt;
  }
  const read = request();
  const draft: Draft = {
    messages: [...read.messages],
    tools: [...read.tools],
    options: { stop: ['END'], toolChoice: { allowed: ['read'], mode: 'auto' } },
  };

  draft.messages.push({ role: 'user', text: 'One more thing' });
  draft.tools?.push({ type: 'function', name: 'read', input: {} });
  draft.options?.stop?.push('STOP');
  draft.messages = read.messages.slice(0, 1);
  // @ts-expect-error
  const shared: Draft = { messages: read.messages };
  // @ts-expect-error
  const fixed: Draft = { messages: [], options: read.options };

  expect(sent(draft).messages).toHaveLength(1);
  expect(draft.options?.stop).toEqual(['END', 'STOP']);
  expect([shared.messages.length, typeof fixed.options]).toEqual([2, 'object']);
});

test('a prompt takes a Standard Schema inside the object form, and what crosses to a host does not', () => {
  const stated: Prompt = {
    messages: [],
    output: {
      schema: summary(),
      name: 'summary',
      description: 'What was done',
      strict: true,
    },
  };
  const crossing: Prompt<JsonOutput> = {
    messages: [],
    // @ts-expect-error
    output: { schema: summary(), strict: true },
  };

  expect([stated, crossing]).toHaveLength(2);
});

// An agent puts its own notes in text parts ahead of what it was asked.
test.each([
  [
    'a message sent as text says that text',
    { role: 'user', text: 'Why does this deadlock?' },
    'Why does this deadlock?',
  ],
  [
    "a message sent as parts says its last text part, past an agent's notes ahead of it",
    {
      role: 'user',
      parts: [
        {
          type: 'text',
          text: '<system-reminder>Keep it short</system-reminder>',
        },
        { type: 'text', text: 'Why does this deadlock?' },
      ],
    },
    'Why does this deadlock?',
  ],
  [
    'reasoning, refusals, tool results and media are not what a message says',
    {
      role: 'user',
      parts: [
        { type: 'reasoning', text: 'The user wants a fix' },
        { type: 'text', text: 'See the diff' },
        { type: 'image', url: 'https://example.com/diff.png' },
        { type: 'tool_result', id: 'call_1', text: 'fn main() {}' },
        { type: 'refusal', text: 'I cannot help with that' },
      ],
    },
    'See the diff',
  ],
  [
    'a message with no text parts says nothing',
    {
      role: 'user',
      parts: [{ type: 'tool_result', id: 'call_1', text: 'fn main() {}' }],
    },
    '',
  ],
  ['no message says nothing', undefined, ''],
] satisfies [string, Message | undefined, string][])(
  '%s',
  (_, message, says) => {
    expect(said(message)).toBe(says);
  },
);
