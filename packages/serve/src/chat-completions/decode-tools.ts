import type { Json, Tool, ToolChoice } from '@mottyjs/core/host';
import { type Dict, dict, isDict, list } from '../wire/json.ts';
import { parameterless } from '../wire/openai-tools.ts';
import { invalid } from '../wire/refusals.ts';
import { family, noted } from './family.ts';
import { toolFields, unreadOf } from './unread.ts';

function described(description: Json | undefined): { description?: string } {
  return typeof description === 'string' ? { description } : {};
}

function grammarOf(format: Dict): Extract<Tool, { type: 'custom' }>['grammar'] {
  const { type, grammar } = format;
  const { syntax, definition } = dict(grammar);
  if (type !== 'grammar') return undefined;
  if (
    (syntax !== 'lark' && syntax !== 'regex') ||
    typeof definition !== 'string'
  ) {
    invalid('A grammar needs a syntax and a definition');
  }
  return { syntax, definition };
}

export function toolOf(raw: Json): Tool {
  if (!isDict(raw)) invalid('A tool is an object');
  const { type, function: fn, custom } = raw;
  if (type === 'function') {
    const { name, description, parameters, strict } = dict(fn);
    if (typeof name !== 'string') {
      invalid('A function tool needs a name');
    }
    return {
      type,
      name,
      ...described(description),
      input: isDict(parameters) ? parameters : parameterless(),
      ...(typeof strict === 'boolean' ? { strict } : {}),
      ...noted(unreadOf(raw, 'function', toolFields) ?? {}),
    };
  }
  if (type === 'custom') {
    const { name, description, format } = dict(custom);
    if (typeof name !== 'string') {
      invalid('A custom tool needs a name');
    }
    const grammar = grammarOf(dict(format));
    return {
      type,
      name,
      ...described(description),
      ...(grammar === undefined ? {} : { grammar }),
      ...noted(unreadOf(raw, 'custom', toolFields) ?? {}),
    };
  }
  return { type: 'provider', provider: { [family]: raw } };
}

function named(raw: Json): string {
  const { type, function: fn, custom } = dict(raw);
  const { name } = dict(type === 'custom' ? custom : fn);
  if (typeof name !== 'string') {
    invalid('A tool choice names its tool');
  }
  return name;
}

export function choiceOf(raw: Json): ToolChoice {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  const { type, allowed_tools: allowed } = dict(raw);
  if (type === 'function' || type === 'custom') return { tool: named(raw) };
  if (type !== 'allowed_tools') {
    invalid(`Unknown tool_choice: ${JSON.stringify(raw)}`);
  }
  const { mode, tools } = dict(allowed);
  const [first, ...more] = list(tools).map(named);
  if ((mode !== 'auto' && mode !== 'required') || first === undefined) {
    invalid('allowed_tools needs a mode and its tools');
  }
  return { allowed: [first, ...more], mode };
}
