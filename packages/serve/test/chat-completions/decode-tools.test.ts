import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { choiceOf, toolOf } from '../../src/chat-completions/decode-tools.ts';

test('a function tool is read with its schema and strictness', () => {
  expect(
    toolOf({
      type: 'function',
      function: {
        name: 'weather',
        description: 'The weather in a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
          additionalProperties: false,
        },
        strict: true,
      },
    }),
  ).toEqual({
    type: 'function',
    name: 'weather',
    description: 'The weather in a city',
    input: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strict: true,
  });
});

test('a function tool with no strictness named is read with none', () => {
  expect(
    toolOf({
      type: 'function',
      function: { name: 'weather', parameters: { type: 'object' } },
    }),
  ).toEqual({ type: 'function', name: 'weather', input: { type: 'object' } });
});

test('a function tool with no parameters takes none', () => {
  expect(toolOf({ type: 'function', function: { name: 'now' } })).toEqual({
    type: 'function',
    name: 'now',
    input: { type: 'object', properties: {} },
  });
});

test('a custom tool is read with its grammar, or as free text', () => {
  expect(
    toolOf({
      type: 'custom',
      custom: {
        name: 'shell',
        description: 'Runs a command',
        format: {
          type: 'grammar',
          grammar: { syntax: 'regex', definition: '^ls( -[al]+)?$' },
        },
      },
    }),
  ).toEqual({
    type: 'custom',
    name: 'shell',
    description: 'Runs a command',
    grammar: { syntax: 'regex', definition: '^ls( -[al]+)?$' },
  });
  expect(
    toolOf({
      type: 'custom',
      custom: { name: 'note', format: { type: 'text' } },
    }),
  ).toEqual({ type: 'custom', name: 'note' });
});

test('a tool of a kind not known is kept whole for its own family', () => {
  const tool = { type: 'web_search_preview', search_context_size: 'low' };

  expect(toolOf(tool)).toEqual({
    type: 'provider',
    provider: { 'openai.chat': tool },
  });
});

test('a tool that is not well formed is refused', () => {
  expect(() => toolOf('weather')).toThrow(InvalidRequest);
  expect(() => toolOf({ type: 'function', function: {} })).toThrow(
    'A function tool needs a name',
  );
  expect(() => toolOf({ type: 'custom' })).toThrow(
    'A custom tool needs a name',
  );
  expect(() =>
    toolOf({
      type: 'custom',
      custom: {
        name: 'shell',
        format: {
          type: 'grammar',
          grammar: { syntax: 'ebnf', definition: 'x' },
        },
      },
    }),
  ).toThrow('A grammar needs a syntax and a definition');
});

test('each plain tool choice is read as it is', () => {
  expect(choiceOf('auto')).toBe('auto');
  expect(choiceOf('none')).toBe('none');
  expect(choiceOf('required')).toBe('required');
});

test('a named function or custom tool is read as that tool', () => {
  expect(choiceOf({ type: 'function', function: { name: 'weather' } })).toEqual(
    { tool: 'weather' },
  );
  expect(choiceOf({ type: 'custom', custom: { name: 'shell' } })).toEqual({
    tool: 'shell',
  });
});

test('allowed tools are read with their mode', () => {
  expect(
    choiceOf({
      type: 'allowed_tools',
      allowed_tools: {
        mode: 'required',
        tools: [
          { type: 'function', function: { name: 'weather' } },
          { type: 'custom', custom: { name: 'shell' } },
        ],
      },
    }),
  ).toEqual({ allowed: ['weather', 'shell'], mode: 'required' });
});

test('a tool choice that is not well formed is refused', () => {
  expect(() => choiceOf('any')).toThrow('Unknown tool_choice: "any"');
  expect(() => choiceOf({ type: 'function' })).toThrow(
    'A tool choice names its tool',
  );
  expect(() =>
    choiceOf({
      type: 'allowed_tools',
      allowed_tools: { mode: 'auto', tools: [] },
    }),
  ).toThrow(InvalidRequest);
  expect(() =>
    choiceOf({
      type: 'allowed_tools',
      allowed_tools: {
        mode: 'any',
        tools: [{ type: 'function', function: { name: 'weather' } }],
      },
    }),
  ).toThrow('allowed_tools needs a mode and its tools');
});
