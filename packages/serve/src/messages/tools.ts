import type { Json, Options, Tool, ToolChoice } from '@mottyjs/core/host';
import { cacheExtra, cacheOf, cacheTo } from '../wire/cache-control.ts';
import type { Leaving } from '../wire/fieldless.ts';
import { copied, type Dict, given, isDict } from '../wire/json.ts';
import { invalid, unsupported } from '../wire/refusals.ts';
import { family, hinted, marked, noted, own } from './family.ts';

export function toolOf(raw: Json): Tool {
  if (!isDict(raw)) invalid('A tool must be an object');
  const {
    type,
    name,
    description,
    input_schema: input,
    strict,
    cache_control: control,
    eager_input_streaming: eager,
    ...rest
  } = raw;
  if (type !== undefined && type !== 'custom') {
    if (typeof type !== 'string') invalid('A tool type must be a string');
    return {
      type: 'provider',
      ...(typeof name === 'string' ? { name } : {}),
      provider: { [family]: raw },
    };
  }
  if (typeof name !== 'string') invalid('A tool needs a name');
  if (!isDict(input)) invalid(`Tool ${name} needs an input_schema object`);
  return {
    type: 'function',
    name,
    ...(typeof description === 'string' ? { description } : {}),
    input,
    ...(typeof strict === 'boolean' ? { strict } : {}),
    ...cacheOf(control),
    ...marked(rest),
    // How the input streams changes no meaning, so another family drops it.
    ...noted(
      given({
        eager_input_streaming: eager,
        cache_control: cacheExtra(control),
      }),
    ),
  };
}

// This API takes a tool's input only as an object, so a free-form tool is
// one with its text in a single field, told the grammar the text follows.
// Its calls are read back to the text, and a call sent back is wrapped again.
function freeTo(left: Leaving, tool: Tool & { type: 'custom' }): Dict {
  left.without('tool.custom', tool);
  const { grammar } = tool;
  const told = [
    tool.description,
    grammar &&
      `The input follows this ${grammar.syntax} grammar:\n${grammar.definition}`,
  ].filter((said) => said !== undefined && said !== '');
  return {
    name: tool.name,
    ...(told.length === 0 ? {} : { description: told.join('\n\n') }),
    input_schema: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
    ...hinted(tool.hints),
    ...own(tool.provider, 'a tool'),
  };
}

export function toolTo(left: Leaving, tool: Tool): Dict | undefined {
  if (tool.type === 'custom') return freeTo(left, tool);
  const extra = own(tool.provider, 'a tool');
  if (tool.type === 'provider') {
    if (Object.keys(extra).length === 0) {
      unsupported('Anthropic Messages cannot carry an empty provider tool');
    }
    return { ...extra, ...cacheTo(tool.cache) };
  }
  const { cache_control: kept, ...hints } = hinted(tool.hints);
  return {
    name: tool.name,
    ...given({ description: tool.description, strict: tool.strict }),
    input_schema: copied(tool.input),
    ...hints,
    ...extra,
    ...cacheTo(tool.cache, kept),
  };
}

export function choiceOf(
  raw: Json | undefined,
): Pick<Options, 'toolChoice' | 'parallelToolCalls'> {
  if (raw === undefined || raw === null) return {};
  if (!isDict(raw)) invalid('tool_choice must be an object');
  const { type, name, disable_parallel_tool_use: single, ...rest } = raw;
  const parallel =
    typeof single === 'boolean' ? { parallelToolCalls: !single } : {};
  if (Object.keys(rest).length > 0) {
    return { toolChoice: { provider: { [family]: raw } } };
  }
  switch (type) {
    case 'auto':
    case 'none':
      return { toolChoice: type, ...parallel };
    case 'any':
      return { toolChoice: 'required', ...parallel };
    case 'tool':
      if (typeof name !== 'string') invalid('tool_choice needs a tool name');
      return { toolChoice: { tool: name }, ...parallel };
    default:
      if (typeof type !== 'string') invalid('tool_choice needs a type');
      return { toolChoice: { provider: { [family]: raw } } };
  }
}

function named(
  left: Leaving,
  choice: ToolChoice | undefined,
): Dict | undefined {
  switch (choice) {
    case undefined:
      return undefined;
    case 'auto':
    case 'none':
      return { type: choice };
    case 'required':
      return { type: 'any' };
  }
  if ('tool' in choice) return { type: 'tool', name: choice.tool };
  if ('provider' in choice) return own(choice.provider, 'a tool choice');
  left.without('toolChoice.allowed', choice.allowed);
  return undefined;
}

export function choiceTo(left: Leaving, options: Options): Dict | undefined {
  const { toolChoice } = options;
  const choice = named(left, toolChoice);
  const verbatim = typeof toolChoice === 'object' && 'provider' in toolChoice;
  if (options.parallelToolCalls !== false || verbatim) return choice;
  const { type = 'auto' } = choice ?? {};
  return type === 'none'
    ? choice
    : { ...choice, type, disable_parallel_tool_use: true };
}
