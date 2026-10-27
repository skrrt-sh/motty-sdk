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
import { carried, family, hinted, marked, mine, own } from './family.ts';
import { clientRun, field } from './fields.ts';

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
  // To another family it is a function, named for its type.
  const run = clientRun(raw);
  if (run !== undefined && isDict(parameters)) {
    return {
      type: 'function',
      name: run,
      ...described,
      input: parameters,
      hints: { [family]: without(raw, ['description', 'parameters']) },
    };
  }
  return {
    type: 'provider',
    ...(typeof name === 'string' ? { name } : {}),
    provider: { [family]: raw },
  };
}

export function clientNames(tools: readonly Tool[]): Set<string> {
  return new Set(
    tools.flatMap((tool) =>
      tool.type === 'function' && clientRun(mine(tool.hints)) !== undefined
        ? [tool.name]
        : [],
    ),
  );
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
      if (clientRun(hinted(tool.hints)) !== undefined) {
        return {
          ...carried(tool, 'a tool option'),
          ...given({ description: tool.description }),
          parameters: copied(tool.input),
        };
      }
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

// Tools declared in one namespace go back in it, where the first of them
// was declared.
export function toolsBody(left: Leaving, tools: readonly Tools[number][]) {
  const sent: Dict[] = [];
  const spaces = new Map<string, Dict[]>();
  for (const tool of tools) {
    const { namespace, name, found, ...hints } = hinted(tool.hints);
    // This API holds what a search found in the search's own output.
    if (found === true) continue;
    const { name: space } = dict(namespace);
    if (
      tool.type === 'provider' ||
      typeof space !== 'string' ||
      typeof name !== 'string'
    ) {
      sent.push(toolBody(left, tool));
      continue;
    }
    const member = toolBody(left, {
      ...tool,
      name,
      hints: { [family]: hints },
    });
    const members = spaces.get(space);
    if (members !== undefined) members.push(member);
    else {
      spaces.set(space, [member]);
      sent.push({ ...dict(namespace), tools: spaces.get(space) ?? [] });
    }
  }
  return sent;
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
