import { expect, test } from 'bun:test';
import { pieces } from '../../src/chat-completions/reply-pieces.ts';

test('text and a refusal are added as they are, with their logprobs', () => {
  const piece = pieces(false);
  const token = {
    token: 'Hi',
    logprob: -0.01,
    bytes: [72, 105],
    top_logprobs: [],
  };

  expect(piece({ type: 'text', text: 'Hi' })).toEqual({
    kind: 'content',
    text: 'Hi',
  });
  expect(
    piece({
      type: 'text',
      text: 'Hi',
      provider: { 'openai.chat': { logprobs: [token] } },
    }),
  ).toEqual({ kind: 'content', text: 'Hi', logprobs: [token] });
  expect(piece({ type: 'refusal', text: 'No.' })).toEqual({
    kind: 'refusal',
    text: 'No.',
  });
});

test('progress is added as reasoning, a line break between two pieces', () => {
  const piece = pieces(false);

  expect(piece({ type: 'progress', piece: 0, text: 'Reading ' })).toEqual({
    kind: 'reasoning',
    text: 'Reading ',
  });
  expect(piece({ type: 'progress', piece: 0, text: 'the question' })).toEqual({
    kind: 'reasoning',
    text: 'the question',
  });
  expect(
    piece({ type: 'progress', piece: 1, text: 'Routing to code' }),
  ).toEqual({ kind: 'reasoning', text: '\nRouting to code' });
});

test('the model`s own reasoning starts on a line after the progress', () => {
  const piece = pieces(false);
  piece({ type: 'progress', piece: 0, text: 'Routing to code' });

  expect(piece({ type: 'reasoning', text: 'The user wants' })).toEqual({
    kind: 'reasoning',
    text: '\nThe user wants',
  });
  expect(piece({ type: 'reasoning', text: ' a loop.' })).toEqual({
    kind: 'reasoning',
    text: ' a loop.',
  });
});

test('a caller who muted reasoning gets neither progress nor reasoning', () => {
  const piece = pieces(true);

  expect(
    piece({ type: 'progress', piece: 0, text: 'Routing' }),
  ).toBeUndefined();
  expect(piece({ type: 'reasoning', text: 'Thinking' })).toBeUndefined();
  expect(piece({ type: 'text', text: 'Hi' })).toEqual({
    kind: 'content',
    text: 'Hi',
  });
});

test('empty progress adds nothing', () => {
  expect(
    pieces(false)({ type: 'progress', piece: 0, text: '' }),
  ).toBeUndefined();
});

test('fragments of tool calls are numbered by call, opened once each', () => {
  const piece = pieces(false);

  expect(
    piece({ type: 'tool_call', id: 'call_a', name: 'weather', arguments: '' }),
  ).toEqual({
    kind: 'call',
    index: 0,
    type: 'function',
    opened: { id: 'call_a', name: 'weather' },
    input: '',
  });
  expect(
    piece({ type: 'tool_call', id: 'call_b', name: 'now', arguments: '{}' }),
  ).toEqual({
    kind: 'call',
    index: 1,
    type: 'function',
    opened: { id: 'call_b', name: 'now' },
    input: '{}',
  });
  expect(
    piece({ type: 'tool_call', id: 'call_a', arguments: '{"city":"Oslo"}' }),
  ).toEqual({
    kind: 'call',
    index: 0,
    type: 'function',
    input: '{"city":"Oslo"}',
  });
});

test('a call this wire marked as free-form stays free-form to its end', () => {
  const piece = pieces(false);

  expect(
    piece({
      type: 'tool_call',
      id: 'call_a',
      name: 'shell',
      arguments: 'ls',
      provider: { 'openai.chat': { type: 'custom' } },
    }),
  ).toMatchObject({ kind: 'call', type: 'custom' });
  expect(piece({ type: 'tool_call', id: 'call_a', arguments: ' -la' })).toEqual(
    { kind: 'call', index: 0, type: 'custom', input: ' -la' },
  );
});

test('what a fragment holds for this API is carried as it came', () => {
  expect(
    pieces(
      false,
      new Set(['shell']),
    )({
      type: 'tool_call',
      id: 'call_a',
      name: 'shell',
      arguments: 'ls',
      provider: {
        'openai.chat': { function: { signature: 's' }, id: 'call_stray' },
        'openai.responses': { namespace: 'time' },
      },
    }),
  ).toEqual({
    kind: 'call',
    index: 0,
    type: 'custom',
    opened: { id: 'call_a', name: 'shell' },
    input: 'ls',
    carried: { function: { signature: 's' }, id: 'call_stray' },
  });
});

test.each([
  [{ provider: { 'openai.chat': { index: 9, function: { name: 'stray' } } } }],
])(
  'a later fragment with no input and nothing this wire writes adds nothing: %j',
  (more) => {
    const piece = pieces(false);
    piece({
      type: 'tool_call',
      id: 'call_a',
      name: 'weather',
      arguments: '{}',
    });

    expect(
      piece({ type: 'tool_call', id: 'call_a', arguments: '', ...more }),
    ).toBeUndefined();
  },
);

test('a later fragment with no input that carries a field is added', () => {
  const piece = pieces(false);
  piece({ type: 'tool_call', id: 'call_a', name: 'weather', arguments: '{}' });

  expect(
    piece({
      type: 'tool_call',
      id: 'call_a',
      arguments: '',
      provider: { 'openai.chat': { extra_content: { a: 1 } } },
    }),
  ).toEqual({
    kind: 'call',
    index: 0,
    type: 'function',
    input: '',
    carried: { extra_content: { a: 1 } },
  });
});

test('a tool the upstream ran itself, and its result, add nothing', () => {
  const piece = pieces(false);

  expect(
    piece({
      type: 'tool_call',
      id: 'srvtoolu_1',
      name: 'web_search',
      arguments: '{"query":"oslo"}',
      hosted: true,
    }),
  ).toBeUndefined();
  expect(
    piece({ type: 'tool_result', id: 'srvtoolu_1', output: [], hosted: true }),
  ).toBeUndefined();
  expect(
    piece({ type: 'tool_call', id: 'call_a', name: 'now', arguments: '' }),
  ).toMatchObject({ index: 0 });
});

test('a citation is added as a URL annotation with the upstream`s span', () => {
  expect(
    pieces(false)({
      type: 'citation',
      title: 'Oslo',
      url: 'https://en.wikipedia.org/wiki/Oslo',
      provider: { 'openai.chat': { start_index: 12, end_index: 40 } },
    }),
  ).toEqual({
    kind: 'annotation',
    annotation: {
      type: 'url_citation',
      url_citation: {
        start_index: 12,
        end_index: 40,
        title: 'Oslo',
        url: 'https://en.wikipedia.org/wiki/Oslo',
      },
    },
  });
});

test('a citation with no span of its own points at where it was made', () => {
  const piece = pieces(false);
  piece({ type: 'text', text: 'Oslo is the capital.' });

  expect(
    piece({ type: 'citation', url: 'https://en.wikipedia.org/wiki/Oslo' }),
  ).toEqual({
    kind: 'annotation',
    annotation: {
      type: 'url_citation',
      url_citation: {
        start_index: 20,
        end_index: 20,
        title: '',
        url: 'https://en.wikipedia.org/wiki/Oslo',
      },
    },
  });
  expect(
    piece({ type: 'citation', title: 'terms.pdf', text: 'Clause 4' }),
  ).toBeUndefined();
});

test('sound an upstream of this wire sent is added, other data is not', () => {
  const piece = pieces(false);

  expect(
    piece({
      type: 'provider',
      provider: { 'openai.chat': { audio: { id: 'audio_1', data: 'UklG' } } },
    }),
  ).toEqual({ kind: 'audio', audio: { id: 'audio_1', data: 'UklG' } });
  expect(
    piece({
      type: 'provider',
      provider: { anthropic: { type: 'redacted_thinking', data: 'EmwK' } },
    }),
  ).toBeUndefined();
  expect(
    piece({ type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' }),
  ).toBeUndefined();
});

test.each([
  [
    'bytes of an image type',
    { type: 'file', data: 'iVBORw0=', mediaType: 'image/png' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0=' } },
  ],
  [
    'an address this family read as a picture, with what its entry held',
    {
      type: 'file',
      url: 'https://x.test/made.png',
      provider: { 'openai.chat': { type: 'image_url', index: 1 } },
    },
    {
      type: 'image_url',
      index: 1,
      image_url: { url: 'https://x.test/made.png' },
    },
  ],
] as const)('a picture a model made, %s, is added', (_, chunk, image) => {
  expect(pieces(false)(chunk)).toEqual({ kind: 'image', image });
});

test.each([
  [
    'a file by address of no named type',
    { type: 'file', url: 'https://x.test/a' },
  ],
  [
    'an image held by id',
    { type: 'file', id: 'file-1', mediaType: 'image/png' },
  ],
] as const)('%s a model made is not added', (_, chunk) => {
  expect(pieces(false)(chunk)).toBeUndefined();
});
