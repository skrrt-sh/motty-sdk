import type { Json, JsonOutput, Message, Options } from '@mottyjs/core/host';
import type { Decoded } from '../codec.ts';
import { formed, formedWhole } from '../wire/formless.ts';
import {
  type Dict,
  given as defined,
  dict,
  isDict,
  text,
} from '../wire/json.ts';
import { meant } from '../wire/provider-data.ts';
import { invalid, unsupported } from '../wire/refusals.ts';
import { family, marked, noted } from './family.ts';
import { field, without } from './fields.ts';
import { formless } from './formless.ts';
import { messagesOf } from './messages.ts';
import { collected, streamed } from './response.ts';
import { choiceOf, customNames, toolOf } from './tools.ts';

function given(body: Dict, key: string): Json | undefined {
  const { [key]: value } = body;
  return value === null ? undefined : value;
}

function numeric(body: Dict, key: string): number | undefined {
  const value = given(body, key);
  if (value === undefined || typeof value === 'number') return value;
  invalid(`${key} must be a number`);
}

// Each needs state the server would hold between requests, and none is held.
function refused(body: Dict): void {
  const held = {
    previous_response_id:
      'previous_response_id continues a stored response: send the whole conversation as input',
    conversation:
      'conversation names a stored conversation: send the whole conversation as input',
    prompt: 'prompt names a stored prompt template: send its text',
  };
  for (const [key, why] of Object.entries(held)) {
    if (given(body, key) !== undefined) {
      unsupported(`No response state is held here. ${why}`);
    }
  }
  if (given(body, 'store') === true) {
    unsupported(
      'No response state is held here. store must be false or left out',
    );
  }
  if (given(body, 'background') === true) {
    unsupported(
      'No response state is held here. background mode is not served',
    );
  }
}

function effortOf(effort: Json | undefined) {
  switch (effort) {
    case undefined:
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      invalid('reasoning.effort is not a known effort');
  }
}

function outputOf(format: Json | undefined): JsonOutput | undefined {
  const { type, schema, name, description, strict } = dict(format);
  if (type === 'json_object') return {};
  if (type !== 'json_schema') return undefined;
  if (!isDict(schema)) {
    invalid('text.format needs a schema');
  }
  return {
    schema,
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    // Left out, this API holds the answer to the schema.
    strict: strict !== false,
  };
}

function optionsOf(body: Dict): Options {
  const { tool_choice: choice, parallel_tool_calls: parallel } = body;
  const { effort, summary, generate_summary, ...thinking } = dict(
    given(body, 'reasoning'),
  );
  const { format: _, verbosity, ...writing } = dict(given(body, 'text'));
  const options: Options = {};
  if (choice !== undefined && choice !== null) {
    options.toolChoice = choiceOf(choice);
  }
  if (typeof parallel === 'boolean') options.parallelToolCalls = parallel;
  if (given(body, 'reasoning') !== undefined) {
    const level = effortOf(effort === null ? undefined : effort);
    options.reasoning = {
      ...(level === undefined ? {} : { effort: level }),
      // With no summary asked for, this API returns no reasoning to read.
      ...((summary ?? generate_summary ?? null) === null
        ? { exclude: true }
        : {}),
    };
  }
  const maxTokens = numeric(body, 'max_output_tokens');
  const temperature = numeric(body, 'temperature');
  const topP = numeric(body, 'top_p');
  const user = text(given(body, 'user'));
  const presencePenalty = numeric(body, 'presence_penalty');
  const frequencyPenalty = numeric(body, 'frequency_penalty');
  if (presencePenalty !== undefined) options.presencePenalty = presencePenalty;
  if (frequencyPenalty !== undefined) {
    options.frequencyPenalty = frequencyPenalty;
  }
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  if (temperature !== undefined) options.temperature = temperature;
  if (topP !== undefined) options.topP = topP;
  if (user !== undefined) options.user = user;
  // What may be left out when another family answers, then what may not.
  const dropped = [
    'include',
    'metadata',
    'prompt_cache_key',
    'prompt_cache_retention',
    'prompt_cache_options',
    'safety_identifier',
    'service_tier',
  ];
  const hints = {
    ...defined(Object.fromEntries(dropped.map((key) => [key, body[key]]))),
    reasoning: meant(defined({ summary, generate_summary })),
    text: meant(defined({ verbosity })),
  };
  const provider = {
    ...without(body, [
      ...dropped,
      'model',
      'input',
      'instructions',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'reasoning',
      'text',
      'max_output_tokens',
      'temperature',
      'top_p',
      'presence_penalty',
      'frequency_penalty',
      'user',
      'stream',
      'stream_options',
      'store',
      'background',
      'previous_response_id',
      'conversation',
      'prompt',
    ]),
    reasoning: meant(thinking),
    text: meant(writing),
  };
  return { ...options, ...noted(meant(hints)), ...marked(provider) };
}

// Instructions lead the conversation; the mark puts them back in their own
// field when this API is also the one that answers.
function led(instructions: Json | undefined): Message[] {
  if (instructions === undefined) return [];
  if (typeof instructions !== 'string') {
    invalid('instructions must be a string');
  }
  return [
    {
      role: 'system',
      text: instructions,
      hints: { [family]: { instructions: true } },
    },
  ];
}

export function decode(body: Json): Decoded {
  if (!isDict(body)) {
    invalid('The body must be a JSON object');
  }
  const { model, tools: listed, stream } = body;
  if (typeof model !== 'string') {
    invalid('The body needs a model');
  }
  if (stream !== undefined && stream !== null && typeof stream !== 'boolean') {
    invalid('stream must be true or false');
  }
  if (listed !== undefined && listed !== null && !Array.isArray(listed)) {
    invalid('tools must be a list');
  }
  refused(body);
  const tools = (listed ?? []).map((tool, index) =>
    toolOf(tool, `tools[${index}]`),
  );
  const options = optionsOf(body);
  const output = outputOf(field(given(body, 'text'), 'format'));
  const asked = {
    body,
    // A caller who gets no reasoning from a model gets no progress either.
    muted: options.reasoning?.exclude === true || !('reasoning' in options),
    custom: customNames(tools),
  };
  return {
    request: {
      model,
      messages: [
        ...led(given(body, 'instructions')),
        ...messagesOf(field(body, 'input')),
      ],
      tools,
      options,
      ...(output === undefined ? {} : { output }),
    },
    stream: stream === true,
    streamed: (events, id) => streamed(asked, formed(events, formless), id),
    collected: (events, finish, id) =>
      collected(asked, formedWhole(events, formless), finish, id),
  };
}
