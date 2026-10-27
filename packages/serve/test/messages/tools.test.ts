import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import {
  choiceOf,
  choiceTo,
  toolOf,
  toolTo,
} from '../../src/messages/tools.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('a tool the caller defines is a function tool and back', () => {
  const wire = {
    name: 'get_weather',
    description: 'Get the current weather in a given location',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
    strict: true,
    eager_input_streaming: true,
    allowed_callers: ['code_execution_20260120'],
    cache_control: { type: 'ephemeral' },
  };
  const tool = toolOf(wire);
  expect(tool).toEqual({
    type: 'function',
    name: 'get_weather',
    description: 'Get the current weather in a given location',
    input: wire.input_schema,
    strict: true,
    cache: {},
    provider: { anthropic: { allowed_callers: ['code_execution_20260120'] } },
    hints: { anthropic: { eager_input_streaming: true } },
  });
  expect(toolTo(leaving('messages'), tool)).toEqual(wire);
});

test('a tool typed custom is the same function tool', () => {
  expect(
    toolOf({ type: 'custom', name: 'noop', input_schema: { type: 'object' } }),
  ).toEqual({ type: 'function', name: 'noop', input: { type: 'object' } });
});

test('a tool the provider runs travels as it was sent', () => {
  const wire = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };
  const tool = toolOf(wire);
  expect(tool).toEqual({
    type: 'provider',
    name: 'web_search',
    provider: { anthropic: wire },
  });
  expect(toolTo(leaving('messages'), tool)).toEqual(wire);
});

test('a malformed tool is rejected', () => {
  expect(() => toolOf('get_weather')).toThrow(InvalidRequest);
  expect(() => toolOf({ input_schema: {} })).toThrow(InvalidRequest);
  expect(() => toolOf({ name: 'get_weather' })).toThrow(InvalidRequest);
  expect(() => toolOf({ type: 5, name: 'x' })).toThrow(InvalidRequest);
});

test('a free-form tool is one that takes its text in one field', () => {
  expect(
    toolTo(leaving('messages'), { type: 'custom', name: 'shell' }),
  ).toEqual({
    name: 'shell',
    input_schema: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
  });
});

test('a tool this wire cannot say fails the call', () => {
  expect(() =>
    toolTo(leaving('messages'), {
      type: 'provider',
      provider: { 'openai.responses': { type: 'file_search' } },
    }),
  ).toThrow(Unsupported);
  expect(() =>
    toolTo(leaving('messages'), { type: 'provider', provider: {} }),
  ).toThrow(Unsupported);
});

test('each tool choice is read and written back', () => {
  expect(choiceOf(undefined)).toEqual({});
  for (const [wire, toolChoice] of [
    [{ type: 'auto' }, 'auto'],
    [{ type: 'none' }, 'none'],
    [{ type: 'any' }, 'required'],
    [{ type: 'tool', name: 'get_weather' }, { tool: 'get_weather' }],
  ] as const) {
    expect(choiceOf(wire)).toEqual({ toolChoice });
    expect(choiceTo(leaving('messages'), { toolChoice })).toEqual(wire);
  }
  expect(choiceTo(leaving('messages'), {})).toBeUndefined();
});

test('one tool call at a time is a flag on the choice', () => {
  expect(choiceOf({ type: 'any', disable_parallel_tool_use: true })).toEqual({
    toolChoice: 'required',
    parallelToolCalls: false,
  });
  expect(
    choiceTo(leaving('messages'), {
      toolChoice: 'required',
      parallelToolCalls: false,
    }),
  ).toEqual({ type: 'any', disable_parallel_tool_use: true });
  expect(choiceTo(leaving('messages'), { parallelToolCalls: false })).toEqual({
    type: 'auto',
    disable_parallel_tool_use: true,
  });
  expect(
    choiceTo(leaving('messages'), {
      toolChoice: 'none',
      parallelToolCalls: false,
    }),
  ).toEqual({
    type: 'none',
  });
});

test('a choice not known here travels as it was sent', () => {
  const wire = { type: 'auto', future_flag: true };
  expect(choiceOf(wire)).toEqual({
    toolChoice: { provider: { anthropic: wire } },
  });
  expect(
    choiceTo(leaving('messages'), {
      toolChoice: { provider: { anthropic: wire } },
    }),
  ).toEqual(wire);
});

test('a malformed choice is rejected and a foreign one fails the call', () => {
  expect(() => choiceOf('auto')).toThrow(InvalidRequest);
  expect(() => choiceOf({ type: 'tool' })).toThrow(InvalidRequest);
  expect(() => choiceOf({ name: 'x' })).toThrow(InvalidRequest);
  expect(() =>
    choiceTo(leaving('messages'), {
      toolChoice: { allowed: ['a', 'b'], mode: 'auto' },
    }),
  ).toThrow(Unsupported);
  expect(() =>
    choiceTo(leaving('messages'), {
      toolChoice: { provider: { 'openai.chat': { type: 'x' } } },
    }),
  ).toThrow(Unsupported);
});

test('a cache marker is written on a tool of either kind', () => {
  expect(
    toolTo(leaving('messages'), {
      type: 'function',
      name: 'get',
      input: {},
      cache: { ttl: '1h' },
    }),
  ).toEqual({
    name: 'get',
    input_schema: {},
    cache_control: { type: 'ephemeral', ttl: '1h' },
  });
  expect(
    toolTo(leaving('messages'), {
      type: 'provider',
      provider: {
        anthropic: { type: 'web_search_20250305', name: 'web_search' },
      },
      cache: {},
    }),
  ).toEqual({
    type: 'web_search_20250305',
    name: 'web_search',
    cache_control: { type: 'ephemeral' },
  });
});
