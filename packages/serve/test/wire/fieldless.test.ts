import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { JsonOutput, Prompt } from '@mottyjs/core/host';
import type { Dialect } from '../../src/chat-completions/dialect.ts';
import type { Taken } from '../../src/codec.ts';
import {
  chatCompletions,
  chatCompletionsIn,
  messages,
  responses,
} from '../../src/index.ts';
import {
  type Api,
  apis,
  type Fieldless,
  fieldless,
  leaving,
} from '../../src/wire/fieldless.ts';

const codecs = { chat: chatCompletions, responses, messages };

const stated: { [Name in Api]: Prompt<JsonOutput> } = {
  chat: {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'high' },
      provider: { 'openai.chat': { reasoning_effort: 'low' } },
    },
  },
  responses: {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'high' },
      provider: { 'openai.responses': { reasoning: { effort: 'low' } } },
    },
  },
  messages: {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { budgetTokens: 2000 },
      provider: { anthropic: { thinking: { type: 'between_tools' } } },
    },
  },
};

const lenient: Taken = {
  temperature: [0, 2],
  topP: [0, 1],
  topK: true,
  presencePenalty: true,
  frequencyPenalty: true,
  together: true,
  effort: true,
};

// What the model of a row is said to take, where only a rule leaves it out.
const taking: { [Option in Fieldless]?: Taken } = {
  'temperature.model': { ...lenient, temperature: 1 },
  'temperature.range': { ...lenient, temperature: [0, 1] },
  'topP.model': { ...lenient, topP: 0.99 },
  'topP.range': { ...lenient, topP: [0.95, 1] },
  'topP.temperature': { ...lenient, together: false },
  'temperature.topP': { ...lenient, together: false },
  'topK.model': { ...lenient, topK: false },
  'presencePenalty.model': { ...lenient, presencePenalty: false },
  'frequencyPenalty.model': { ...lenient, frequencyPenalty: false },
  'reasoning.model': { ...lenient, effort: false },
  'reasoning.adaptive': { ...lenient, adaptive: false },
  'reasoning.level': { ...lenient, effort: ['low', 'high'] },
};

// The dialect of a row that only an upstream with words of its own leaves out.
const spoken: { [Option in Fieldless]?: Dialect } = {
  'topK.model': { name: 'sampled', topK: true },
  'reasoning.off': { name: 'worded', efforts: ['low', 'high'] },
  'reasoning.effort': { name: 'wordless', efforts: [] },
  'reasoning.level': { name: 'worded', efforts: ['low', 'high', 'max'] },
  'output.schema': { name: 'schemaless', output: 'json_object' },
};

const carrying: { [Option in Fieldless]: Prompt<JsonOutput> } = {
  seed: { messages: [{ role: 'user', text: 'Hi' }], options: { seed: 7 } },
  topK: { messages: [{ role: 'user', text: 'Hi' }], options: { topK: 40 } },
  stop: {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { stop: ['END'] },
  },
  presencePenalty: {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { presencePenalty: 0.5 },
  },
  frequencyPenalty: {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { frequencyPenalty: 0.5 },
  },
  'temperature.model': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { temperature: 0.5 },
  },
  'temperature.range': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { temperature: 1.5 },
  },
  'topP.model': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { topP: 0.5 },
  },
  'topP.range': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { topP: 0.5 },
  },
  'topP.temperature': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { temperature: 0.5, topP: 0.9 },
  },
  'temperature.topP': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      temperature: 0.5,
      provider: {
        'openai.chat': { top_p: 0.9 },
        'openai.responses': { top_p: 0.9 },
        anthropic: { top_p: 0.9 },
      },
    },
  },
  'topK.model': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { topK: 40 },
  },
  'presencePenalty.model': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { presencePenalty: 0.5 },
  },
  'frequencyPenalty.model': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { frequencyPenalty: 0.5 },
  },
  'sampling.own': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      temperature: 0.7,
      provider: {
        'openai.chat': { temperature: 0.2 },
        'openai.responses': { temperature: 0.2 },
        anthropic: { temperature: 0.2 },
      },
    },
  },
  'reasoning.model': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'high' } },
  },
  'reasoning.adaptive': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'high' } },
  },
  'reasoning.budgetTokens': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { budgetTokens: 2000 } },
  },
  'reasoning.minimal': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'minimal' } },
  },
  'reasoning.none': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'none' } },
  },
  'reasoning.off': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'none' } },
  },
  'reasoning.effort': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'high' } },
  },
  'reasoning.level': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'medium' } },
  },
  'reasoning.own': stated.messages,
  'reasoning.hint': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'high' },
      hints: {
        'openai.chat': { reasoning_effort: 'low' },
        'openai.responses': { reasoning: { effort: 'low' } },
        anthropic: { thinking: { type: 'enabled' } },
      },
    },
  },
  'message.moved': {
    messages: [
      { role: 'user', text: 'Hi' },
      { role: 'system', text: 'Be terse.' },
      { role: 'user', text: 'Go' },
    ],
  },
  'output.name': {
    messages: [{ role: 'user', text: 'Hi' }],
    output: { schema: { type: 'object' }, name: 'verdict' },
  },
  'output.schema': {
    messages: [{ role: 'user', text: 'Hi' }],
    output: { schema: { type: 'object' } },
  },
  'toolChoice.allowed': {
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [{ type: 'function', name: 'look', input: { type: 'object' } }],
    options: { toolChoice: { allowed: ['look'], mode: 'auto' } },
  },
  'tool.custom': {
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [{ type: 'custom', name: 'shell' }],
  },
  'tool.offered': {
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [{ type: 'provider', provider: { gemini: { google_search: {} } } }],
  },
  'tool.chosen': {
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [
      {
        type: 'provider',
        name: 'search',
        provider: { gemini: { google_search: {} } },
      },
    ],
    options: { toolChoice: { tool: 'search' } },
  },
  'tool.cache': {
    messages: [{ role: 'user', text: 'Hi' }],
    tools: [
      { type: 'function', name: 'look', input: { type: 'object' }, cache: {} },
    ],
  },
  'message.name': { messages: [{ role: 'user', name: 'ann', text: 'Hi' }] },
  'message.name.tool': {
    messages: [
      {
        role: 'tool',
        name: 'look',
        parts: [{ type: 'tool_result', id: 'call_1', text: 'Sunny' }],
      },
    ],
  },
  'message.hints': {
    messages: [
      {
        role: 'tool',
        hints: { 'openai.responses': { status: 'completed' } },
        parts: [{ type: 'tool_result', id: 'call_1', text: 'Sunny' }],
      },
    ],
  },
  'cache.outside': {
    messages: [{ role: 'assistant', text: 'Hello', cache: {} }],
  },
  cache: { messages: [{ role: 'user', text: 'Hi', cache: {} }] },
  'cache.ttl': {
    messages: [{ role: 'user', text: 'Hi', cache: { ttl: '1h' } }],
  },
  'reasoning.exclude': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { reasoning: { effort: 'low', exclude: true } },
  },
  'user.long': {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { user: 'u'.repeat(65) },
  },
  hosted: {
    messages: [
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: {},
            hosted: true,
          },
        ],
      },
    ],
  },
  audio: {
    messages: [
      {
        role: 'user',
        parts: [{ type: 'audio', data: 'AAAA', mediaType: 'audio/wav' }],
      },
    ],
  },
  'image.untyped': {
    messages: [{ role: 'user', parts: [{ type: 'image', data: 'iVBORw0=' }] }],
  },
  'tool_result.failed': {
    messages: [
      {
        role: 'assistant',
        parts: [{ type: 'tool_call', id: 'call_1', name: 'look', input: {} }],
      },
      {
        role: 'tool',
        parts: [
          { type: 'tool_result', id: 'call_1', text: 'boom', failed: true },
        ],
      },
    ],
  },
  reasoning: {
    messages: [
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Weighing it' },
          { type: 'text', text: 'Yes' },
        ],
      },
    ],
  },
  citation: {
    messages: [
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'It rains' },
          { type: 'citation', title: 'Almanac' },
        ],
      },
    ],
  },
};

function isOption(name: string): name is Fieldless {
  return name in fieldless;
}

function isApi(name: string): name is Api {
  return name in apis;
}

const cases = Object.keys(carrying)
  .filter(isOption)
  .flatMap((option) =>
    Object.keys(apis)
      .filter(isApi)
      .map((api): [Fieldless, Api] => [option, api]),
  );

test('every row of the table is sent to every API', () => {
  expect(cases).toHaveLength(
    Object.keys(fieldless).length * Object.keys(apis).length,
  );
});

test.each(cases)('%s sent to the %s API', (option, api) => {
  const row: { said: string } & { [Name in Api]?: 'meaning' | 'hint' } =
    fieldless[option];
  // Own words are one family's, so each API is sent its own.
  const prompt = option === 'reasoning.own' ? stated[api] : carrying[option];
  const dialect = spoken[option];
  const codec =
    api === 'chat' && dialect !== undefined
      ? chatCompletionsIn(dialect)
      : codecs[api];
  const sent = () => codec.encode('model-x', prompt, {}, () => taking[option]);
  if (row[api] === 'meaning') {
    expect(sent).toThrow(Unsupported);
    expect(sent).toThrow(`${apis[api]} cannot carry ${row.said}`);
    return;
  }
  expect(sent().leftOut.filter(({ setting }) => setting === option)).toEqual(
    row[api] === 'hint'
      ? [
          {
            setting: option,
            detail: `${apis[api]} has no field for ${row.said}`,
          },
        ]
      : [],
  );
});

test('an option that is not given, is turned off or is empty asks for nothing', () => {
  const left = leaving('responses');
  left.without('topK', undefined);
  left.without('stop', []);
  left.without('tool_result.failed', false);
  left.without('seed', undefined);
  expect(left.leftOut()).toEqual([]);
});

test('a penalty of zero asks for nothing, on every API', () => {
  for (const api of Object.keys(apis).filter(isApi)) {
    const left = leaving(api);
    left.without('presencePenalty', 0);
    left.without('frequencyPenalty', 0);
    expect(left.leftOut()).toEqual([]);
  }
});

test('a seed of zero is still a seed', () => {
  const left = leaving('messages');
  left.without('seed', 0);
  expect(left.leftOut()).toEqual([
    { setting: 'seed', detail: 'Anthropic Messages has no field for a seed' },
  ]);
});

test('an option many parts carried is reported once', () => {
  const left = leaving('chat');
  left.without('tool_result.failed', true);
  left.without('tool_result.failed', true);
  expect(left.leftOut()).toHaveLength(1);
});
