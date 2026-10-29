import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { messagesOf } from '../../src/responses/messages.ts';

test('a message is read with or without its type, by its role', () => {
  expect(
    messagesOf([
      { role: 'developer', content: 'Be brief.' },
      { type: 'message', role: 'system', content: 'Answer in French.' },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is this?' },
          { type: 'input_image', file_id: 'file-1' },
        ],
      },
    ]),
  ).toEqual([
    { role: 'developer', text: 'Be brief.' },
    { role: 'system', text: 'Answer in French.' },
    {
      role: 'user',
      parts: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', id: 'file-1' },
      ],
    },
  ]);
});

test('one turn of the model, of several items, is one message', () => {
  expect(
    messagesOf([
      { role: 'user', content: 'Weather in Oslo?' },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [
          { type: 'summary_text', text: 'The user wants weather.' },
          { type: 'summary_text', text: 'Call the tool.' },
        ],
        encrypted_content: 'gAAAAABo',
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Checking.', annotations: [] }],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":"Oslo"}',
        status: 'completed',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '4C, rain' },
      { role: 'assistant', content: 'It is 4C and raining.' },
    ]),
  ).toEqual([
    { role: 'user', text: 'Weather in Oslo?' },
    {
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'The user wants weather.\n\nCall the tool.',
          provider: {
            'openai.responses': {
              type: 'reasoning',
              id: 'rs_1',
              summary: [
                { type: 'summary_text', text: 'The user wants weather.' },
                { type: 'summary_text', text: 'Call the tool.' },
              ],
              encrypted_content: 'gAAAAABo',
            },
          },
        },
        {
          type: 'text',
          text: 'Checking.',
          hints: {
            'openai.responses': {
              id: 'msg_1',
              status: 'completed',
              phase: 'commentary',
            },
          },
        },
        {
          type: 'tool_call',
          id: 'call_1',
          name: 'weather',
          input: { city: 'Oslo' },
          hints: { 'openai.responses': { id: 'fc_1', status: 'completed' } },
        },
      ],
    },
    {
      role: 'tool',
      parts: [{ type: 'tool_result', id: 'call_1', text: '4C, rain' }],
    },
    {
      role: 'assistant',
      parts: [{ type: 'text', text: 'It is 4C and raining.' }],
    },
  ]);
});

test('a reasoning item a caller returns is read alike, written as a summary or as content', () => {
  expect(
    messagesOf([
      {
        id: 'rs_r1_0',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Paris is north.' }],
        content: [],
      },
      {
        id: 'rs_r1_1',
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'Paris is north.' }],
      },
    ]),
  ).toEqual([
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
        {
          type: 'reasoning',
          text: 'Paris is north.',
          provider: {
            'openai.responses': {
              id: 'rs_r1_1',
              type: 'reasoning',
              summary: [],
              content: [{ type: 'reasoning_text', text: 'Paris is north.' }],
            },
          },
        },
      ],
    },
  ]);
});

test('arguments that are not JSON are kept as they were written', () => {
  expect(
    messagesOf([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'weather',
        arguments: '{"city":',
      },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      parts: [
        { type: 'tool_call', id: 'call_1', name: 'weather', raw: '{"city":' },
      ],
    },
  ]);
});

test('the results of calls made together are one message', () => {
  expect(
    messagesOf([
      { type: 'function_call_output', call_id: 'call_1', output: 'one' },
      {
        type: 'function_call_output',
        id: 'fco_2',
        call_id: 'call_2',
        output: [
          { type: 'input_text', text: 'two' },
          { type: 'input_image', image_url: 'https://x.test/a.png' },
        ],
      },
    ]),
  ).toEqual([
    {
      role: 'tool',
      parts: [
        { type: 'tool_result', id: 'call_1', text: 'one' },
        {
          type: 'tool_result',
          id: 'call_2',
          parts: [
            { type: 'text', text: 'two' },
            { type: 'image', url: 'https://x.test/a.png' },
          ],
          hints: { 'openai.responses': { id: 'fco_2' } },
        },
      ],
    },
  ]);
});

test('a custom tool call holds free text, and so does its result', () => {
  expect(
    messagesOf([
      {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'patch',
        input: '*** Begin Patch',
      },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      parts: [
        {
          type: 'tool_call',
          id: 'call_1',
          name: 'patch',
          input: '*** Begin Patch',
        },
      ],
    },
    {
      role: 'tool',
      parts: [{ type: 'tool_result', id: 'call_1', text: 'Done' }],
    },
  ]);
});

test('an item of no known kind keeps its place in the turn it came in', () => {
  expect(
    messagesOf([
      { type: 'web_search_call', id: 'ws_1', status: 'completed' },
      { type: 'function_call_output', call_id: 'call_1', output: 'one' },
      {
        type: 'mcp_approval_response',
        approval_request_id: 'a',
        approve: true,
      },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      parts: [
        {
          type: 'provider',
          provider: {
            'openai.responses': {
              type: 'web_search_call',
              id: 'ws_1',
              status: 'completed',
            },
          },
        },
      ],
    },
    {
      role: 'tool',
      parts: [
        { type: 'tool_result', id: 'call_1', text: 'one' },
        {
          type: 'provider',
          provider: {
            'openai.responses': {
              type: 'mcp_approval_response',
              approval_request_id: 'a',
              approve: true,
            },
          },
        },
      ],
    },
  ]);
});

test('input that cannot be read is refused by where it is', () => {
  expect(() => messagesOf(undefined)).toThrow(InvalidRequest);
  expect(() => messagesOf(['hi'])).toThrow('input[0] must be an object');
  expect(() => messagesOf([{ role: 'tool', content: 'x' }])).toThrow(
    'input[0] has a role that is not known',
  );
  expect(() => messagesOf([{ role: 'user' }])).toThrow(
    'input[0] needs content',
  );
  expect(() =>
    messagesOf([{ role: 'user', content: 'a' }, { type: 'function_call' }]),
  ).toThrow('input[1] needs a call_id and a name');
  expect(() => messagesOf([{ type: 'function_call_output' }])).toThrow(
    'input[0] needs a call_id',
  );
  expect(() =>
    messagesOf([{ type: 'function_call_output', call_id: 'call_1' }]),
  ).toThrow('input[0] needs an output');
});

test('function arguments that are a bare string stay as written, never a custom tool`s input', () => {
  expect(
    messagesOf([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: '"ls -la"',
      },
    ]),
  ).toEqual([
    {
      role: 'assistant',
      parts: [
        { type: 'tool_call', id: 'call_1', name: 'shell', raw: '"ls -la"' },
      ],
    },
  ]);
});
