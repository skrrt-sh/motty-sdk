import { expect, test } from 'bun:test';
import { InvalidRequest, Unsupported } from '@mottyjs/core';
import {
  choiceBody,
  choiceOf,
  toolBody,
  toolOf,
} from '../../src/responses/tools.ts';
import { leaving } from '../../src/wire/fieldless.ts';

test('a function tool is read and written back with the same meaning', () => {
  const tool = toolOf(
    {
      type: 'function',
      name: 'weather',
      description: 'Looks up the weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
      strict: false,
      defer_loading: true,
    },
    'tools[0]',
  );
  expect(tool).toEqual({
    type: 'function',
    name: 'weather',
    description: 'Looks up the weather',
    input: { type: 'object', properties: { city: { type: 'string' } } },
    strict: false,
    provider: { 'openai.responses': { defer_loading: true } },
  });
  expect(toolBody(leaving('responses'), tool)).toEqual({
    defer_loading: true,
    type: 'function',
    name: 'weather',
    description: 'Looks up the weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    strict: false,
  });
});

test('a function with no parameters is read as one that takes none', () => {
  expect(
    toolOf({ type: 'function', name: 'a', parameters: null }, 'tools[0]'),
  ).toEqual({
    type: 'function',
    name: 'a',
    input: { type: 'object', properties: {} },
  });
});

test('a custom tool keeps its grammar', () => {
  const tool = toolOf(
    {
      type: 'custom',
      name: 'patch',
      description: 'Applies a patch',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: "a"' },
    },
    'tools[0]',
  );
  expect(tool).toEqual({
    type: 'custom',
    name: 'patch',
    description: 'Applies a patch',
    grammar: { syntax: 'lark', definition: 'start: "a"' },
  });
  expect(toolBody(leaving('responses'), tool)).toEqual({
    type: 'custom',
    name: 'patch',
    description: 'Applies a patch',
    format: { type: 'grammar', syntax: 'lark', definition: 'start: "a"' },
  });
  expect(toolOf({ type: 'custom', name: 'run' }, 'tools[0]')).toEqual({
    type: 'custom',
    name: 'run',
  });
});

test('a tool the provider runs is carried whole', () => {
  const tool = toolOf(
    { type: 'mcp', server_label: 'docs', server_url: 'https://mcp.test' },
    'tools[0]',
  );
  expect(tool).toEqual({
    type: 'provider',
    provider: {
      'openai.responses': {
        type: 'mcp',
        server_label: 'docs',
        server_url: 'https://mcp.test',
      },
    },
  });
  expect(toolBody(leaving('responses'), tool)).toEqual({
    type: 'mcp',
    server_label: 'docs',
    server_url: 'https://mcp.test',
  });
});

test('a tool that is not an object or has no name is refused', () => {
  expect(() => toolOf('weather', 'tools[2]')).toThrow(
    'tools[2] must be an object',
  );
  expect(() => toolOf({ type: 'function' }, 'tools[0]')).toThrow(
    InvalidRequest,
  );
});

test("a tool of another provider's own kind cannot be sent", () => {
  expect(() =>
    toolBody(leaving('responses'), {
      type: 'provider',
      provider: { anthropic: { type: 'web_search_20250305' } },
    }),
  ).toThrow(Unsupported);
});

test('each mode of tool choice is read and written back', () => {
  for (const mode of ['auto', 'none', 'required'] as const) {
    expect(choiceOf(mode)).toBe(mode);
    expect(choiceBody(mode, new Set())).toBe(mode);
  }
});

test('one named tool is chosen as a function or as a custom tool', () => {
  expect(choiceOf({ type: 'function', name: 'weather' })).toEqual({
    tool: 'weather',
  });
  expect(choiceOf({ type: 'custom', name: 'patch' })).toEqual({
    tool: 'patch',
  });
  expect(choiceBody({ tool: 'weather' }, new Set(['patch']))).toEqual({
    type: 'function',
    name: 'weather',
  });
  expect(choiceBody({ tool: 'patch' }, new Set(['patch']))).toEqual({
    type: 'custom',
    name: 'patch',
  });
});

test('a set of allowed tools keeps its names and its mode', () => {
  const choice = choiceOf({
    type: 'allowed_tools',
    mode: 'required',
    tools: [
      { type: 'function', name: 'weather' },
      { type: 'custom', name: 'patch' },
    ],
  });
  expect(choice).toEqual({ allowed: ['weather', 'patch'], mode: 'required' });
  expect(choiceBody(choice, new Set(['patch']))).toEqual({
    type: 'allowed_tools',
    mode: 'required',
    tools: [
      { type: 'function', name: 'weather' },
      { type: 'custom', name: 'patch' },
    ],
  });
});

test("a choice of the provider's own tool is carried whole", () => {
  const hosted = choiceOf({ type: 'web_search' });
  expect(hosted).toEqual({
    provider: { 'openai.responses': { type: 'web_search' } },
  });
  expect(choiceBody(hosted, new Set())).toEqual({ type: 'web_search' });
  const mixed = choiceOf({
    type: 'allowed_tools',
    mode: 'auto',
    tools: [{ type: 'mcp', server_label: 'docs' }],
  });
  expect(choiceBody(mixed, new Set())).toEqual({
    type: 'allowed_tools',
    mode: 'auto',
    tools: [{ type: 'mcp', server_label: 'docs' }],
  });
});

test('a choice that is neither a mode nor an object is refused', () => {
  expect(() => choiceOf('sometimes')).toThrow(InvalidRequest);
  expect(() =>
    choiceBody({ provider: { anthropic: { type: 'any' } } }, new Set()),
  ).toThrow(Unsupported);
});
