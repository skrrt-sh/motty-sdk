import type { Json, Prompt, Tool, ToolChoice } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import {
  copied,
  type Dict,
  dict,
  given,
  isDict,
  list,
  text,
  without,
} from '../wire/json.ts';
import { parameterless } from '../wire/openai-tools.ts';
import { invalid } from '../wire/refusals.ts';
import { carried, family, marked, own } from './family.ts';
import { field } from './fields.ts';

type Tools = NonNullable<Prompt['tools']>;

// A field of a tool this codec does not read still reaches the model.
function extra(fields: Dict, read: readonly string[]) {
  return marked(without(fields, ['type', 'name', 'description', ...read]));
}

function grammarOf(
  format: Json | undefined,
): (Tool & { type: 'custom' })['grammar'] {
  const { type, syntax, definition } = dict(format);
  if (type !== 'grammar' || typeof definition !== 'string') return undefined;
  if (syntax !== 'lark' && syntax !== 'regex') return undefined;
  return { syntax, definition };
}

export function toolOf(raw: Json, at: string): Tool {
  if (!isDict(raw)) invalid(`${at} must be an object`);
  const { type, name, description, parameters, strict, format } = raw;
  const described = typeof description === 'string' ? { description } : {};
  if (type === 'function') {
    if (typeof name !== 'string') {
      invalid(`${at} needs a name`);
    }
    return {
      type: 'function',
      name,
      ...described,
      input: isDict(parameters) ? parameters : parameterless(),
      // Left out, the API picks strictness by the schema; saying either
      // for the caller could have a schema it accepts turned down.
      ...(typeof strict === 'boolean' ? { strict } : {}),
      ...extra(raw, ['parameters', 'strict']),
    };
  }
  if (type === 'custom' && typeof name === 'string') {
    const grammar = grammarOf(format);
    const plain = format === undefined || field(format, 'type') === 'text';
    if (grammar !== undefined || plain) {
      return {
        type: 'custom',
        name,
        ...described,
        ...(grammar === undefined ? {} : { grammar }),
        ...extra(raw, ['format']),
      };
    }
  }
  return {
    type: 'provider',
    ...(typeof name === 'string' ? { name } : {}),
    provider: { [family]: raw },
  };
}

function named(tool: Json): string | undefined {
  const { type, name } = dict(tool);
  return type === 'function' || type === 'custom' ? text(name) : undefined;
}

export function choiceOf(raw: Json): ToolChoice {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (!isDict(raw)) {
    invalid('tool_choice must be a mode or an object');
  }
  const { type, mode, tools } = raw;
  const tool = named(raw);
  if (tool !== undefined) return { tool };
  if (type === 'allowed_tools' && (mode === 'auto' || mode === 'required')) {
    const [first, ...others] = list(tools).map(named);
    if (first !== undefined && others.every((name) => name !== undefined)) {
      return {
        allowed: [first, ...others.filter((name) => name !== undefined)],
        mode,
      };
    }
  }
  return { provider: { [family]: raw } };
}

export function toolBody(left: Leaving, tool: Tools[number]): Dict {
  if (tool.type !== 'custom') left.without('tool.cache', tool.cache);
  switch (tool.type) {
    case 'function':
      return {
        ...carried(tool, 'a tool option'),
        type: 'function',
        name: tool.name,
        ...given({ description: tool.description, strict: tool.strict }),
        parameters: copied(tool.input),
      };
    case 'custom':
      return {
        ...carried(tool, 'a tool option'),
        type: 'custom',
        name: tool.name,
        ...given({ description: tool.description }),
        ...(tool.grammar === undefined
          ? {}
          : { format: { type: 'grammar', ...tool.grammar } }),
      };
    case 'provider':
      return carried(tool, 'a tool');
    default:
      return tool satisfies never;
  }
}

export function choiceBody(
  choice: ToolChoice,
  custom: ReadonlySet<string>,
): Json {
  const one = (name: string) => ({
    type: custom.has(name) ? 'custom' : 'function',
    name,
  });
  if (typeof choice === 'string') return choice;
  if ('tool' in choice) return one(choice.tool);
  if ('allowed' in choice) {
    return {
      type: 'allowed_tools',
      mode: choice.mode,
      tools: choice.allowed.map(one),
    };
  }
  return own(choice.provider, 'a tool choice');
}
