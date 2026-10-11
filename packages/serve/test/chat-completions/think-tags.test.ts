import { expect, test } from 'bun:test';
import { events } from '../../src/chat-completions/events.ts';
import { untagged } from '../../src/chat-completions/think-tags.ts';

async function* sent(...frames: string[]) {
  for (const data of frames) yield { data };
}

test('text between the tags is reasoning and the rest is text', () => {
  const tags = untagged();

  expect([
    ...tags.read('<think>9.8 is greater.</think>9.8'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'reasoning', text: '9.8 is greater.' },
    { type: 'text', text: '9.8' },
  ]);
});

test('a reply with no tags is read as it came', () => {
  const tags = untagged();

  expect([
    ...tags.read('9.8 is'),
    ...tags.read(' greater.'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'text', text: '9.8 is' },
    { type: 'text', text: ' greater.' },
  ]);
});

test('an opening tag that is never closed leaves the rest as reasoning', () => {
  const tags = untagged();

  expect([
    ...tags.read('<think>Weighing'),
    ...tags.read(' it'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'reasoning', text: 'Weighing' },
    { type: 'reasoning', text: ' it' },
  ]);
});

test('the line breaks an upstream puts around the tags are left as it sent them', () => {
  const tags = untagged();

  expect([
    ...tags.read('<think>\nWeighing it\n</think>\n\nYes'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'reasoning', text: '\nWeighing it\n' },
    { type: 'text', text: '\n\nYes' },
  ]);
});

test("a tag after the first closing one is the answer's own text", () => {
  const tags = untagged();

  expect([
    ...tags.read('<think>One</think>Yes<think>Two</think>.'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'reasoning', text: 'One' },
    { type: 'text', text: 'Yes<think>Two</think>.' },
  ]);
});

test("an opening tag after the reply's first words is text, and so is what it holds", () => {
  const tags = untagged();

  expect([
    ...tags.read('Write `<think>plan</think>` to mark reasoning.'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'text', text: 'Write `<think>plan</think>` to mark reasoning.' },
  ]);
});

test('white space before the opening tag is text and the tag still opens', () => {
  const tags = untagged();

  expect([...tags.read('\n\n<think>One</think>Yes'), ...tags.ended()]).toEqual([
    { type: 'text', text: '\n\n' },
    { type: 'reasoning', text: 'One' },
    { type: 'text', text: 'Yes' },
  ]);
});

test('a reply said to begin inside its thinking is reasoning up to the first closing tag', () => {
  const tags = untagged(true);

  expect([
    ...tags.read('Weighing it</think>Yes</think>.'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'reasoning', text: 'Weighing it' },
    { type: 'text', text: 'Yes</think>.' },
  ]);
});

test('a reply said to begin inside its thinking that never closes it is all reasoning', () => {
  const tags = untagged(true);

  expect([
    ...tags.read('Weighing'),
    ...tags.read(' it'),
    ...tags.ended(),
  ]).toEqual([
    { type: 'reasoning', text: 'Weighing' },
    { type: 'reasoning', text: ' it' },
  ]);
});

test.each([1, 2, 3, 4, 5, 6])(
  'an opening tag cut after %d of its characters is no text',
  (cut) => {
    const tags = untagged();

    expect([
      ...tags.read(`\n${'<think>'.slice(0, cut)}`),
      ...tags.read(`${'<think>'.slice(cut)}Weighing it</think>Yes`),
      ...tags.ended(),
    ]).toEqual([
      { type: 'text', text: '\n' },
      { type: 'reasoning', text: 'Weighing it' },
      { type: 'text', text: 'Yes' },
    ]);
  },
);

test.each([1, 2, 3, 4, 5, 6, 7])(
  'a closing tag cut after %d of its characters is no reasoning',
  (cut) => {
    const tags = untagged();

    expect([
      ...tags.read(`<think>Weighing it${'</think>'.slice(0, cut)}`),
      ...tags.read(`${'</think>'.slice(cut)}Yes`),
      ...tags.ended(),
    ]).toEqual([
      { type: 'reasoning', text: 'Weighing it' },
      { type: 'text', text: 'Yes' },
    ]);
  },
);

test.each([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
  22, 23,
])('a reply cut in two at character %d reads the same', (cut) => {
  const tags = untagged();
  const read = [
    ...tags.read(' <think>B</think>C<think>D'.slice(0, cut)),
    ...tags.read(' <think>B</think>C<think>D'.slice(cut)),
    ...tags.ended(),
  ];

  expect(
    read.flatMap(({ type, text }) => (type === 'text' ? [text] : [])).join(''),
  ).toBe(' C<think>D');
  expect(
    read
      .flatMap(({ type, text }) => (type === 'reasoning' ? [text] : []))
      .join(''),
  ).toBe('B');
});

test('a reply that comes one character at a time reads the same', () => {
  const tags = untagged();
  const read = [
    ...[...'<think>a<b</think>x</thin<think>'].flatMap((each) =>
      tags.read(each),
    ),
    ...tags.ended(),
  ];

  expect(
    read.flatMap(({ type, text }) => (type === 'text' ? [text] : [])).join(''),
  ).toBe('x</thin<think>');
  expect(
    read
      .flatMap(({ type, text }) => (type === 'reasoning' ? [text] : []))
      .join(''),
  ).toBe('a<b');
});

test('ordinary text is not held back, and only an ending that may become a tag waits', () => {
  const tags = untagged();

  expect(tags.read('<think>2 < 3 and </th')).toEqual([
    { type: 'reasoning', text: '2 < 3 and ' },
  ]);
  expect(tags.read('en some')).toEqual([
    { type: 'reasoning', text: '</then some' },
  ]);
});

test('what was held when the reply ended is text', () => {
  const tags = untagged();

  expect(tags.read(' <')).toEqual([{ type: 'text', text: ' ' }]);
  expect(tags.ended()).toEqual([{ type: 'text', text: '<' }]);
  expect(tags.ended()).toEqual([]);
});

test('once what was held is told as text the reply has begun, so a tag after it opens nothing', () => {
  const tags = untagged();

  expect(tags.read('<thi')).toEqual([]);
  expect(tags.ended()).toEqual([{ type: 'text', text: '<thi' }]);
  expect(tags.read('<think>no</think>')).toEqual([
    { type: 'text', text: '<think>no</think>' },
  ]);
});

test('a stream of a dialect that says so has its tagged text read as reasoning, across chunks', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"id":"06","model":"MiniMax-M2","choices":[{"index":0,"delta":{"role":"assistant","content":"<thi"}}]}',
          '{"id":"06","model":"MiniMax-M2","choices":[{"index":0,"delta":{"content":"nk>\\nThe user asks 17*23."}}]}',
          '{"id":"06","model":"MiniMax-M2","choices":[{"index":0,"delta":{"content":" 391.\\n</th"}}]}',
          '{"id":"06","model":"MiniMax-M2","choices":[{"index":0,"delta":{"content":"ink>\\n\\n17 times 23 is"}}]}',
          '{"id":"06","model":"MiniMax-M2","choices":[{"index":0,"delta":{"content":" 391."},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'minimax', tagged: true },
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: '\nThe user asks 17*23.' },
    { type: 'reasoning', text: ' 391.\n' },
    { type: 'text', text: '\n\n17 times 23 is' },
    { type: 'text', text: ' 391.' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'stop',
      id: '06',
      model: 'MiniMax-M2',
    },
  ]);
});

test('a whole reply in one chunk is read the same', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"role":"assistant","content":"<think>\\nThe user asks 17*23.\\n</think>\\n\\n391"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'minimax', tagged: true },
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: '\nThe user asks 17*23.\n' },
    { type: 'text', text: '\n\n391' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('text held when a stream ends is sent before the finish', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":" <"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'minimax', tagged: true },
      ),
    ),
  ).toEqual([
    { type: 'text', text: ' ' },
    { type: 'text', text: '<' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('a dialect that does not say so is shown the tags as text', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"<think>Hm</think>Yes"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'deepseek' },
      ),
    ),
  ).toEqual([
    { type: 'text', text: '<think>Hm</think>Yes' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('reasoning a tagged upstream sends in a field of its own is read beside its text', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"reasoning":"Hm"}}]}',
          '{"choices":[{"index":0,"delta":{"content":"Yes"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'local', tagged: true },
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'Hm' },
    { type: 'text', text: 'Yes' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('the likelihoods of a chunk stay on the text it held', async () => {
  const [, text] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"<think>Hm</think>Yes"},"logprobs":{"content":[{"token":"Yes","logprob":-0.1}]},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      { name: 'local', tagged: true },
    ),
  );

  expect(text).toEqual({
    type: 'text',
    text: 'Yes',
    provider: {
      'openai.chat': { logprobs: [{ token: 'Yes', logprob: -0.1 }] },
    },
  });
});

test('text held when the upstream tells a failure is sent before it', async () => {
  const [said, held] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"<think>2 <"}}]}',
        '{"error":{"message":"Overloaded","code":"server_is_overloaded"}}',
      ),
      { name: 'groq', tagged: true },
    ),
  );

  expect(said).toEqual({ type: 'reasoning', text: '2 ' });
  expect(held).toEqual({ type: 'reasoning', text: '<' });
});

test('text held when a chunk the dialect says holds a failure comes is sent before it', async () => {
  const read = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"<think>2 <"}}]}',
        '{"choices":[],"outcome":{"message":"internal service error"}}',
      ),
      {
        name: 'acme',
        tagged: true,
        envelope: ({ outcome }) =>
          typeof outcome === 'object' &&
          outcome !== null &&
          !Array.isArray(outcome)
            ? outcome
            : undefined,
      },
    ),
  );

  expect(read.map(({ type }) => type)).toEqual([
    'reasoning',
    'reasoning',
    'error',
  ]);
  expect(read[1]).toEqual({ type: 'reasoning', text: '<' });
});

test('text held when a chunk cannot be read is sent before the failure', async () => {
  const read = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"<think>2 <"}}]}',
        '{"cho',
      ),
      { name: 'minimax', tagged: true },
    ),
  );

  expect(read.map(({ type }) => type)).toEqual([
    'reasoning',
    'reasoning',
    'error',
  ]);
  expect(read[1]).toEqual({ type: 'reasoning', text: '<' });
});

test('text held when the read throws is sent before it does', async () => {
  const read: unknown[] = [];
  async function* breaking() {
    yield {
      data: '{"choices":[{"index":0,"delta":{"content":"<think>2 <"}}]}',
    };
    throw new Error('socket closed');
  }

  await expect(
    (async () => {
      for await (const event of events(breaking(), {
        name: 'minimax',
        tagged: true,
      })) {
        read.push(event);
      }
    })(),
  ).rejects.toThrow('socket closed');
  expect(read).toEqual([
    { type: 'reasoning', text: '2 ' },
    { type: 'reasoning', text: '<' },
  ]);
});

test('text held before a tool call of a later chunk is sent before the call', async () => {
  const read = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":" <"}}]}',
        '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"look","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
        '[DONE]',
      ),
      { name: 'minimax', tagged: true },
    ),
  );

  expect(read).toEqual([
    { type: 'text', text: ' ' },
    { type: 'text', text: '<' },
    { type: 'tool_call', id: 'call_1', name: 'look', arguments: '{}' },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ]);
});

test('the likelihoods of a chunk that held reasoning alone stay on it', async () => {
  const [thought] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"<think>Hm"},"logprobs":{"content":[{"token":"Hm","logprob":-0.1}]}}]}',
        '{"choices":[{"index":0,"delta":{"content":"</think>Yes"},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      { name: 'local', tagged: true },
    ),
  );

  expect(thought).toEqual({
    type: 'reasoning',
    text: 'Hm',
    provider: { 'openai.chat': { logprobs: [{ token: 'Hm', logprob: -0.1 }] } },
  });
});

test('the likelihoods of a chunk that was held back whole go with what it became', async () => {
  const [text] = await Array.fromAsync(
    events(
      sent(
        '{"choices":[{"index":0,"delta":{"content":"<"},"logprobs":{"content":[{"token":"<","logprob":-0.2}]}}]}',
        '{"choices":[{"index":0,"delta":{"content":"3"},"finish_reason":"stop"}]}',
        '[DONE]',
      ),
      { name: 'local', tagged: true },
    ),
  );

  expect(text).toEqual({
    type: 'text',
    text: '<3',
    provider: { 'openai.chat': { logprobs: [{ token: '<', logprob: -0.2 }] } },
  });
});

test('a stream of a dialect whose template opens the thinking is reasoning up to the closing tag', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"Weighing it</think>Yes"},"finish_reason":"stop"}]}',
          '[DONE]',
        ),
        { name: 'local', tagged: 'open' },
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'Weighing it' },
    { type: 'text', text: 'Yes' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('the likelihoods of a chunk that was only the opening tag, with nothing after it, are still told', async () => {
  expect(
    await Array.fromAsync(
      events(
        sent(
          '{"choices":[{"index":0,"delta":{"content":"<think>"},"logprobs":{"content":[{"token":"<think>","logprob":-0.3}]},"finish_reason":"length"}]}',
          '[DONE]',
        ),
        { name: 'local', tagged: true },
      ),
    ),
  ).toEqual([
    {
      type: 'text',
      text: '',
      provider: {
        'openai.chat': { logprobs: [{ token: '<think>', logprob: -0.3 }] },
      },
    },
    { type: 'finish', reason: 'length', rawReason: 'length' },
  ]);
});
