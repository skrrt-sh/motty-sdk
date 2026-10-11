import type { JsonOutput, Prompt } from '@mottyjs/core/host';
import type { Codec } from '../codec.ts';
import { type Leaving, leaving } from '../wire/fieldless.ts';
import { copied, type Dict, dict, given } from '../wire/json.ts';
import { customNames } from '../wire/openai-tools.ts';
import { effortless, reasons, sampling, unsampled } from '../wire/taken.ts';
import { addressed } from './family.ts';
import { field, without } from './fields.ts';
import { inputOf } from './items.ts';
import { choiceBody, toolBody } from './tools.ts';

type Options = NonNullable<Prompt['options']>;

function formatOf(output: JsonOutput): Dict {
  if (output.schema === undefined) return { type: 'json_object' };
  return {
    type: 'json_schema',
    name: output.name ?? 'output',
    schema: copied(output.schema),
    // Said either way: left out, this API would hold the schema strictly.
    strict: output.strict ?? false,
    ...given({ description: output.description }),
  };
}

function asks(reasoning: Options['reasoning']): boolean {
  const { effort, budgetTokens, exclude } = reasoning ?? {};
  return effort !== undefined || budgetTokens !== undefined || exclude === true;
}

// A summary is the only reasoning this API gives back to read, so it is
// asked for whenever reasoning is asked for and not muted. What the author
// said in this API's own words stays, and a hint gives way to both.
function reasoningOf(
  left: Leaving,
  reasoning: Options['reasoning'],
  hint: Dict,
  said: Dict,
): Dict {
  const { effort, exclude } = reasoning ?? {};
  const { effort: level, summary: own, generate_summary: old } = said;
  const stated = own !== undefined || old !== undefined;
  left.without('reasoning.own', level === undefined ? undefined : effort);
  left.without('reasoning.own', stated && exclude);
  const carried = {
    ...(exclude === true
      ? without(hint, ['summary', 'generate_summary'])
      : hint),
    ...said,
  };
  const { summary, generate_summary: legacy } = carried;
  const sent: Dict = {
    ...carried,
    ...given({ effort: level === undefined ? effort : undefined }),
    ...(asks(reasoning) &&
    exclude !== true &&
    summary === undefined &&
    legacy === undefined
      ? { summary: 'auto' }
      : {}),
  };
  for (const [name, value] of Object.entries(hint)) {
    left.without('reasoning.hint', sent[name] !== value);
  }
  return sent;
}

function kept(name: string, fields: Dict): Dict {
  return Object.keys(fields).length === 0 ? {} : { [name]: fields };
}

export function encode(
  model: string,
  prompt: Prompt<JsonOutput>,
  defaults: Parameters<Codec['encode']>[2] = {},
  breakpoints?: Parameters<typeof leaving>[1],
  takes?: Parameters<Codec['encode']>[3],
): ReturnType<Codec['encode']> {
  const options = prompt.options ?? {};
  const left = leaving('responses', breakpoints);
  left.without('stop', options.stop);
  left.without('topK', options.topK);
  left.without('seed', options.seed);
  left.without('reasoning.budgetTokens', options.reasoning?.budgetTokens);
  const custom = customNames(prompt.tools);
  const { hints, provider, leftOut } = addressed(options);
  const { toolChoice } = options;
  const tools = (prompt.tools ?? []).map((tool) => toolBody(left, tool));
  const input = inputOf(left, prompt.messages, custom);
  const reasoning = reasoningOf(
    left,
    effortless(left, takes?.(model, true), options.reasoning),
    dict(field(hints, 'reasoning')),
    dict(field(provider, 'reasoning')),
  );
  // What a request asks of reasoning is sent the same with any connection.
  const preset = unsampled(
    asks(options.reasoning) ? without(defaults, ['reasoning']) : defaults,
    options,
  );
  // Whether the request reasons is read from what is sent, whoever said it.
  const { effort } = { ...dict(field(preset, 'reasoning')), ...reasoning };
  const sampled = sampling(
    left,
    takes?.(model, reasons(effort)),
    {
      temperature: options.temperature,
      topP: options.topP,
      presencePenalty: options.presencePenalty,
      frequencyPenalty: options.frequencyPenalty,
    },
    provider,
  );
  return {
    path: '/responses',
    leftOut: [...left.leftOut(), ...leftOut],
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: {
      ...preset,
      ...without(hints, ['reasoning', 'text']),
      ...without(provider, ['reasoning', 'text']),
      model,
      ...input,
      // The whole conversation is sent each time, so nothing is kept there.
      store: false,
      stream: true,
      ...(tools.length === 0 ? {} : { tools }),
      ...given({
        tool_choice:
          toolChoice === undefined ? undefined : choiceBody(toolChoice, custom),
        parallel_tool_calls: options.parallelToolCalls,
        max_output_tokens: options.maxTokens,
        user: options.user,
      }),
      ...sampled,
      ...kept('reasoning', reasoning),
      ...kept('text', {
        ...dict(field(hints, 'text')),
        ...dict(field(provider, 'text')),
        ...(prompt.output === undefined
          ? {}
          : { format: formatOf(prompt.output) }),
      }),
    },
  };
}
