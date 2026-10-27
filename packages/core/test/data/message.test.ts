import { expect, test } from 'bun:test';
import type {
  ChatRequest,
  Closed,
  Draft,
  Json,
  JsonOutput,
  Message,
  Prompt,
  StandardSchema,
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
  ['no message says nothing', undefined, ''],
] satisfies [string, Message | undefined, string][])(
  '%s',
  (_, message, says) => {
    expect(said(message)).toBe(says);
  },
);
