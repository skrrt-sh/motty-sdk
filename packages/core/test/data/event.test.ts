import { expect, test } from 'bun:test';
import {
  chunkOf,
  eventOf,
  isTerminal,
  type StreamEvent,
  usageOf,
} from '../../src/data/event.ts';

test.each([
  [{ type: 'text', text: '', block: 0, provider: { openai: { index: 0 } } }],
  [{ type: 'tool_call', id: 'call_1', arguments: '{"q":' }],
  [{ type: 'tool_result', id: 'call_1', output: null }],
  [{ type: 'file', data: 'iVBORw0=', mediaType: 'image/png' }],
  [{ type: 'file', url: 'https://example.com/a.png' }],
  [{ type: 'file', id: 'file_1', mediaType: 'image/png' }],
  [{ type: 'citation' }],
  [{ type: 'provider', provider: { openai: { logprobs: [] } } }],
])('%j enters as the chunk it is', (chunk) => {
  expect([chunkOf(chunk) === chunk, eventOf(chunk) === chunk]).toEqual([
    true,
    true,
  ]);
});

test.each([
  [null],
  ['text'],
  [{ type: 'image', url: 'https://example.com/a.png' }],
  [{ type: 'text', text: 7 }],
  [{ type: 'text', text: 'Hello', block: '0' }],
  [{ type: 'text', text: 'Hello', provider: 'openai' }],
  [{ type: 'text', text: 'Hello', provider: [] }],
  [{ type: 'tool_call', id: 1, arguments: '{}' }],
  [{ type: 'tool_call', id: 'call_1', arguments: { q: 'motty' } }],
  [{ type: 'tool_call', id: 'call_1', arguments: '', name: 7 }],
  [{ type: 'tool_call', id: 'call_1', arguments: '', hosted: 'yes' }],
  [{ type: 'tool_call', id: 'call_1', arguments: '', ended: 'yes' }],
  [{ type: 'tool_result', output: 'found' }],
  [{ type: 'tool_result', id: 'call_1', output: () => 'found' }],
  [{ type: 'tool_result', id: 'call_1', output: Number.POSITIVE_INFINITY }],
  [{ type: 'tool_result', id: 'call_1', output: 'found', failed: 1 }],
  [{ type: 'tool_result', id: 'call_1', output: 'found', hosted: 'no' }],
  [{ type: 'file' }],
  [{ type: 'file', data: 'iVBORw0=' }],
  [{ type: 'file', data: new Uint8Array(4), mediaType: 'image/png' }],
  [{ type: 'file', data: 'iVBORw0=', mediaType: 'image/png', id: 'file_1' }],
  [{ type: 'file', url: 'https://example.com/a.png', id: 'file_1' }],
  [{ type: 'file', url: new URL('https://example.com/a.png') }],
  [{ type: 'file', id: 'file_1', mediaType: 7 }],
  [{ type: 'citation', title: 7 }],
  [{ type: 'citation', url: new URL('https://example.com') }],
  [{ type: 'citation', text: false }],
  [{ type: 'provider' }],
])('%p is not an event', (value) => {
  expect([chunkOf(value), eventOf(value)]).toEqual([undefined, undefined]);
});

test('progress cannot be forged as an event', () => {
  const value = { type: 'progress', chunk: { type: 'text', text: 'Hello' } };
  expect([chunkOf(value), eventOf(value)]).toEqual([undefined, undefined]);
});

test('provider data, tool output and warnings pass unchecked', () => {
  const chunk = {
    type: 'tool_result',
    id: 'call_1',
    output: { at: new Date(0) },
    provider: { openai: { parse: () => 'logprobs' } },
  };
  const finish = { type: 'finish', reason: 'stop', warnings: [7] };
  expect([
    Object.is(chunkOf(chunk), chunk),
    Object.is(eventOf(finish), finish),
  ]).toEqual([true, true]);
});

test('a finish enters as the terminal event it is', () => {
  const event = {
    type: 'finish',
    reason: 'tool_calls',
    usage: { input: 12, output: 0, cached: 4, cacheWrite: 2, reasoning: 1 },
    rawReason: 'tool_use',
    id: 'msg_1',
    model: 'acme/small',
    warnings: [{ setting: 'seed' }],
    provider: { anthropic: { stop_sequence: null } },
  };
  expect(eventOf(event) === event).toBe(true);
});

test('a failure that enters is marked as from outside and is otherwise as it was sent', () => {
  expect<unknown>(
    eventOf({
      type: 'error',
      error: { code: 'db_down', status: 503, message: 'busy', shard: 7 },
      usage: { input: 12 },
      trace: 't_1',
    }),
  ).toStrictEqual({
    type: 'error',
    error: {
      code: 'db_down',
      status: 503,
      message: 'busy',
      shard: 7,
      upstream: true,
    },
    usage: { input: 12 },
    trace: 't_1',
  });
});

test('a failure its host calls its own enters unmarked, and that word is not kept', () => {
  const sent = {
    type: 'error',
    error: { code: 'unsupported', message: 'No audio here', upstream: false },
    usage: { input: 3 },
  };

  expect<unknown>(eventOf(sent)).toStrictEqual({
    type: 'error',
    error: { code: 'unsupported', message: 'No audio here' },
    usage: { input: 3 },
  });
  expect(sent.error.upstream).toBe(false);
});

test('a failure whose host says anything but false of it is marked as from outside', () => {
  expect(
    eventOf({
      type: 'error',
      error: { code: 'rate_limited', message: 'busy', upstream: 'false' },
    }),
  ).toHaveProperty('error.upstream', true);
});

test('a terminal event is not a chunk', () => {
  expect(chunkOf({ type: 'finish', reason: 'stop' })).toBeUndefined();
});

test.each([
  [{ type: 'finish', reason: 'end_turn' }],
  [{ type: 'finish', reason: 'stop', rawReason: 7 }],
  [{ type: 'finish', reason: 'stop', id: 1 }],
  [{ type: 'finish', reason: 'stop', model: ['acme/small'] }],
  [{ type: 'finish', reason: 'stop', warnings: 'seed' }],
  [{ type: 'finish', reason: 'stop', provider: 'anthropic' }],
  [{ type: 'error', error: null }],
  [{ type: 'error', error: { message: 'busy' } }],
  [{ type: 'error', error: { code: 503, message: 'busy' } }],
])('%p is not a terminal event', (value) => {
  expect(eventOf(value)).toBeUndefined();
});

test.each([
  [{ input: 12, output: -1 }, { input: 12 }],
  [{ input: 12, output: 1.5 }, { input: 12 }],
  [{ input: 12, output: 2 ** 53 }, { input: 12 }],
  [{ input: 12, output: '3' }, { input: 12 }],
  ['lots', {}],
])('usage %p costs the wrong counts and keeps the event', (usage, kept) => {
  expect([
    eventOf({ type: 'finish', reason: 'stop', usage }),
    eventOf({
      type: 'error',
      error: { code: 'overloaded', message: 'busy' },
      usage,
    }),
  ]).toStrictEqual([
    { type: 'finish', reason: 'stop', usage: kept },
    {
      type: 'error',
      error: { code: 'overloaded', message: 'busy', upstream: true },
      usage: kept,
    },
  ]);
});

test('a count of zero is a count', () => {
  const finish = { type: 'finish', reason: 'stop', usage: { cached: 0 } };
  expect(eventOf(finish) === finish).toBe(true);
});

test('a cost is an amount, whole or not, and is kept beside the counts', () => {
  const usage = { input: 12, cost: 0.0000023 };
  expect(usageOf(usage) === usage).toBe(true);
});

test('a cost that is not an amount is dropped and the counts kept', () => {
  expect([
    usageOf({ input: 12, cost: -1 }),
    usageOf({ input: 12, cost: Number.POSITIVE_INFINITY }),
    usageOf({ input: 12, cost: '0.5' }),
    usageOf({ input: 12, cost: 0 }),
  ]).toStrictEqual([
    { input: 12 },
    { input: 12 },
    { input: 12 },
    { input: 12, cost: 0 },
  ]);
});

test.each([
  [{ type: 'finish', reason: 'stop' } satisfies StreamEvent, true],
  [
    {
      type: 'error',
      error: { code: 'overloaded', message: 'busy' },
    } satisfies StreamEvent,
    true,
  ],
  [{ type: 'text', text: 'Hello' } satisfies StreamEvent, false],
])('%j is terminal: %p', (event, terminal) => {
  expect(isTerminal(event)).toBe(terminal);
});
