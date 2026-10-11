import type { Json, JsonOutput, Options } from '@mottyjs/core/host';
import type { Decoded } from '../codec.ts';
import { isEffort } from '../wire/effort.ts';
import { formed, formedWhole } from '../wire/formless.ts';
import { type Dict, dict, given, isDict, list } from '../wire/json.ts';
import { numberOf } from '../wire/number.ts';
import { customNames } from '../wire/openai-tools.ts';
import { invalid, unsupported } from '../wire/refusals.ts';
import { messageOf } from './decode-messages.ts';
import { choiceOf, toolOf } from './decode-tools.ts';
import { marked, noted } from './family.ts';
import { formless } from './formless.ts';
import { streamed } from './reply-stream.ts';
import { collected } from './reply-whole.ts';

type Given = Json | undefined;

function absent(value: Given): value is null | undefined {
  return value === undefined || value === null;
}

function flagOf(value: Given, name: string): boolean | undefined {
  if (absent(value)) return undefined;
  if (typeof value === 'boolean') return value;
  invalid(`${name} must be true or false`);
}

function stopOf(value: Given): string[] | undefined {
  if (absent(value)) return undefined;
  const stops = typeof value === 'string' ? [value] : list(value);
  const words = stops.filter((stop) => typeof stop === 'string');
  if (words.length === 0 || words.length !== stops.length) {
    invalid('stop must be a string or a list of strings');
  }
  return words;
}

function effortOf(value: Given): NonNullable<Options['reasoning']>['effort'] {
  if (absent(value)) return undefined;
  if (isEffort(value)) return value;
  invalid(`Unknown reasoning effort: ${JSON.stringify(value)}`);
}

// Both spellings are read: the API's own field, and the object that routers
// of this family take, which is the only one that can mute reasoning.
function reasoningOf(effort: Given, object: Given): Options['reasoning'] {
  const { effort: inner, max_tokens: budget, exclude } = dict(object);
  const level = effortOf(effort ?? inner);
  const budgetTokens = numberOf(budget, 'reasoning.max_tokens');
  const muted = flagOf(exclude, 'reasoning.exclude');
  if (
    level === undefined &&
    budgetTokens === undefined &&
    muted === undefined
  ) {
    return undefined;
  }
  return {
    ...(level === undefined ? {} : { effort: level }),
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
    ...(muted === undefined ? {} : { exclude: muted }),
  };
}

function outputOf(format: Given): JsonOutput | undefined {
  if (absent(format)) return undefined;
  const { type, json_schema: wanted } = dict(format);
  if (type === 'text') return undefined;
  if (type === 'json_object') return {};
  if (type !== 'json_schema' || !isDict(wanted)) {
    invalid(`Unknown response_format: ${JSON.stringify(format)}`);
  }
  const { name, description, schema, strict } = wanted;
  return {
    ...(isDict(schema) ? { schema } : {}),
    ...(typeof name === 'string' ? { name } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    // Left out, this API takes the schema loosely.
    strict: strict === true,
  };
}

function optionsOf(body: Dict): Options {
  const {
    tool_choice: choice,
    parallel_tool_calls: parallel,
    reasoning_effort: effort,
    reasoning: reasoned,
    stop,
    max_tokens: legacyMax,
    max_completion_tokens: max,
    temperature,
    top_p,
    seed,
    presence_penalty,
    frequency_penalty,
    user,
    // Tuning and bookkeeping that another family may leave out.
    metadata,
    store,
    service_tier,
    safety_identifier,
    prompt_cache_key,
    prompt_cache_options,
    prompt_cache_retention,
    prediction,
    verbosity,
    // What is left changes the answer: it reaches this family or fails.
    ...others
  } = body;
  const hints = given({
    metadata,
    store,
    service_tier,
    safety_identifier,
    prompt_cache_key,
    prompt_cache_options,
    prompt_cache_retention,
    prediction,
    verbosity,
  });
  const reasoning = reasoningOf(effort, reasoned);
  const stops = stopOf(stop);
  const maxTokens =
    numberOf(max, 'max_completion_tokens') ?? numberOf(legacyMax, 'max_tokens');
  const parallelToolCalls = flagOf(parallel, 'parallel_tool_calls');
  const topP = numberOf(top_p, 'top_p');
  const heat = numberOf(temperature, 'temperature');
  const seeded = numberOf(seed, 'seed');
  const presencePenalty = numberOf(presence_penalty, 'presence_penalty');
  const frequencyPenalty = numberOf(frequency_penalty, 'frequency_penalty');
  return {
    ...(absent(choice) ? {} : { toolChoice: choiceOf(choice) }),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(stops === undefined ? {} : { stop: stops }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(heat === undefined ? {} : { temperature: heat }),
    ...(topP === undefined ? {} : { topP }),
    ...(seeded === undefined ? {} : { seed: seeded }),
    ...(presencePenalty === undefined ? {} : { presencePenalty }),
    ...(frequencyPenalty === undefined ? {} : { frequencyPenalty }),
    ...(typeof user === 'string' ? { user } : {}),
    ...marked(others),
    ...noted(hints),
  };
}

export function decode(body: Json): Decoded {
  if (!isDict(body)) invalid('The body must be a JSON object');
  const {
    model,
    messages,
    tools,
    n,
    stream,
    stream_options: streaming,
    response_format: format,
    functions,
    function_call: legacy,
    ...rest
  } = body;
  if (typeof model !== 'string') {
    invalid('The body needs a model');
  }
  if (!Array.isArray(messages)) {
    invalid('The body needs a list of messages');
  }
  if ((numberOf(n, 'n') ?? 1) !== 1) {
    unsupported('Only one choice is served: n must be 1');
  }
  if (!absent(functions) || !absent(legacy)) {
    unsupported('functions are not served: send tools');
  }
  const options = optionsOf(rest);
  const output = outputOf(format);
  const muted = options.reasoning?.exclude === true;
  const { include_usage: usage } = dict(streaming);
  const listed = list(tools).map(toolOf);
  const custom = customNames(listed);
  return {
    request: {
      model,
      messages: messages.map(messageOf),
      tools: listed,
      options,
      ...(output === undefined ? {} : { output }),
    },
    stream: flagOf(stream, 'stream') === true,
    streamed: (events, id) =>
      streamed(formed(events, formless), {
        id,
        model,
        muted,
        usage: usage === true,
        custom,
      }),
    collected: (events, finish, id) =>
      collected(formedWhole(events, formless), finish, {
        id,
        model,
        muted,
        custom,
      }),
  };
}
