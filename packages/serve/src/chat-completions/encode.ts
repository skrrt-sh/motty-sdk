import type {
  Json,
  JsonOutput,
  Options,
  Prompt,
  Tool,
  ToolChoice,
} from '@mottyjs/core/host';
import type { Codec } from '../codec.ts';
import { carrying } from '../wire/carried.ts';
import { type Leaving, leaving } from '../wire/fieldless.ts';
import { copied, type Dict, dict, given } from '../wire/json.ts';
import { offered } from '../wire/offered.ts';
import { effortless, reasons, sampling, unsampled } from '../wire/taken.ts';
import {
  asked,
  type Dialect,
  plain,
  reasoningWords,
  switched,
} from './dialect.ts';
import { wireMessages } from './encode-messages.ts';
import { addressed, family, hinted, own } from './family.ts';
import { toolFields, withUnread } from './unread.ts';

function tool(left: Leaving, wanted: Tool): Dict {
  if (wanted.type !== 'custom') left.without('tool.cache', wanted.cache);
  switch (wanted.type) {
    case 'function': {
      const { name, description, input, strict } = wanted;
      const carried = {
        ...hinted(wanted.hints),
        ...own(wanted.provider, 'a tool option'),
      };
      const inside = { name, description, parameters: copied(input), strict };
      return withUnread(
        carried,
        'function',
        toolFields,
        { type: 'function' },
        given(inside),
      );
    }
    case 'custom': {
      const { name, description, grammar } = wanted;
      const carried = {
        ...hinted(wanted.hints),
        ...own(wanted.provider, 'a tool option'),
      };
      const format =
        grammar === undefined
          ? undefined
          : { type: 'grammar', grammar: { ...grammar } };
      return withUnread(
        carried,
        'custom',
        toolFields,
        { type: 'custom' },
        given({ name, description, format }),
      );
    }
    case 'provider':
      return own(wanted.provider, 'a provider tool');
    default:
      return wanted satisfies never;
  }
}

function choice(wanted: ToolChoice, custom: ReadonlySet<string>): Json {
  if (typeof wanted === 'string') return wanted;
  const named = (name: string) =>
    custom.has(name)
      ? { type: 'custom', custom: { name } }
      : { type: 'function', function: { name } };
  if ('tool' in wanted) return named(wanted.tool);
  if ('allowed' in wanted) {
    return {
      type: 'allowed_tools',
      allowed_tools: { mode: wanted.mode, tools: wanted.allowed.map(named) },
    };
  }
  return own(wanted.provider, 'a tool choice');
}

function format(left: Leaving, dialect: Dialect, output: JsonOutput): Dict {
  // Said either way: the two OpenAI APIs differ in what leaving it out means.
  const { schema, name = 'output', description, strict = false } = output;
  if (dialect.output === 'json_object') left.without('output.schema', schema);
  if (schema === undefined || dialect.output === 'json_object') {
    return { type: 'json_object' };
  }
  return {
    type: 'json_schema',
    json_schema: given({ name, description, schema: copied(schema), strict }),
  };
}

// A default is replaced by the request's field of the same meaning, under
// whichever name a dialect gives it.
function unsaid(defaults: Dict, { reasoning, maxTokens }: Options): Dict {
  const { effort, budgetTokens, exclude } = reasoning ?? {};
  const said = [
    ...(maxTokens === undefined ? [] : ['max_tokens', 'max_completion_tokens']),
    ...(effort === undefined && budgetTokens === undefined && exclude !== true
      ? []
      : reasoningWords),
  ];
  return Object.fromEntries(
    Object.entries(defaults).filter(([name]) => !said.includes(name)),
  );
}

export function encode(
  model: string,
  prompt: Prompt<JsonOutput>,
  dialect: Dialect = plain,
  defaults: Parameters<Codec['encode']>[2] = {},
  takes?: Parameters<Codec['encode']>[3],
): ReturnType<Codec['encode']> {
  const { messages, tools = [], options = {}, output } = prompt;
  const { toolChoice } = options;
  const left = leaving('chat', dialect.breakpoints);
  if (dialect.topK !== true) left.without('topK', options.topK);
  const said = addressed(options);
  const { parted } = carrying(
    (name) => dialect.carried?.includes(name) === true,
  );
  const hint = parted(said.hints);
  const option = parted(said.provider);
  const { rest: hints } = hint;
  const { rest: provider } = option;
  const { leftOut } = said;
  const reasoning = asked(
    left,
    dialect,
    effortless(left, takes?.(model, true), options.reasoning),
    provider,
  );
  const preset = unsampled(unsaid(defaults, options), options);
  // Whether the request reasons is read from what is sent, whoever said it.
  const stated = { ...preset, ...hints, ...provider, ...reasoning };
  const { reasoning_effort: level, reasoning: object } = stated;
  const { effort = level, max_tokens: budget } = dict(object);
  for (const name of reasoningWords) {
    const sent = provider[name] ?? reasoning[name];
    left.without(
      'reasoning.hint',
      sent === undefined ? undefined : hints[name],
    );
  }
  const custom = new Set(
    tools.flatMap((each) => (each.type === 'custom' ? [each.name] : [])),
  );
  const shown = offered(left, family, tools, toolChoice).map((each) =>
    tool(left, each),
  );
  // Every tool left out as only offered leaves nothing to choose among.
  const choosing = shown.length > 0 || tools.length === 0;
  const body = {
    ...preset,
    // A hint first and an option after, so neither outranks a typed field.
    ...hints,
    ...provider,
    ...given({
      tools: shown.length === 0 ? undefined : shown,
      tool_choice:
        toolChoice === undefined || !choosing
          ? undefined
          : choice(toolChoice, custom),
      parallel_tool_calls: choosing ? options.parallelToolCalls : undefined,
    }),
    ...reasoning,
    ...given({
      stop: options.stop === undefined ? undefined : [...options.stop],
      [dialect.limit ?? 'max_completion_tokens']: options.maxTokens,
      seed: options.seed,
      user: options.user,
      response_format:
        output === undefined ? undefined : format(left, dialect, output),
    }),
    ...sampling(
      left,
      // A switch outranks an effort: thinking that is off does not reason.
      takes?.(model, switched(stated) ?? reasons(effort, budget)),
      {
        temperature: options.temperature,
        topP: options.topP,
        topK: dialect.topK === true ? options.topK : undefined,
        presencePenalty: options.presencePenalty,
        frequencyPenalty: options.frequencyPenalty,
      },
      provider,
    ),
    model,
    messages: wireMessages(left, messages, dialect),
    // Always a stream, and usage in it: the core counts what each call used.
    stream: true,
    stream_options: { include_usage: true },
  };
  return {
    path: '/chat/completions',
    headers: {
      // An option outranks a hint, as with a body field.
      ...hint.headers,
      ...option.headers,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body,
    leftOut: [...left.leftOut(), ...leftOut],
  };
}
