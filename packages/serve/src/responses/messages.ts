import type { Json, Message, Part } from '@mottyjs/core/host';
import { type Dict, isDict, list, parsed, text } from '../wire/json.ts';
import { invalid, unsupported } from '../wire/refusals.ts';
import { partsOf } from './content.ts';
import { family, hinted, noted } from './family.ts';
import { field, without } from './fields.ts';

// An item's id and state matter to this API alone; any other field this
// codec does not read still reaches the model.
function extra(item: Dict, read: readonly string[]) {
  return noted(without(item, ['type', ...read]));
}

function contentOf(content: Json | undefined, at: string): Part[] {
  if (!Array.isArray(content)) {
    invalid(`${at} needs content`);
  }
  return content.flatMap((part, index) =>
    partsOf(part, `${at}.content[${index}]`),
  );
}

// Where the model's turn is told apart from the caller's: the first part of
// an output message carries what the item held.
function spoken(item: Dict, at: string): Part[] {
  const { content } = item;
  const parts: Part[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : contentOf(content, at);
  const [first, ...rest] = parts;
  const whole = without(item, ['type', 'role', 'content']);
  if (first === undefined || Object.keys(whole).length === 0) return parts;
  const hints = { [family]: { ...hinted(first.hints), ...whole } };
  return [{ ...first, hints }, ...rest];
}

function callOf(item: Dict, at: string): Part {
  const { call_id: id, name, arguments: source, input } = item;
  if (typeof id !== 'string' || typeof name !== 'string') {
    invalid(`${at} needs a call_id and a name`);
  }
  const more = extra(item, ['call_id', 'name', 'arguments', 'input']);
  if (field(item, 'type') === 'custom_tool_call') {
    return { type: 'tool_call', id, name, input: text(input) ?? '', ...more };
  }
  const given = text(source) ?? '';
  const value = parsed(given);
  // A bare string is a custom tool's input, never a function's arguments.
  return value === undefined || typeof value === 'string'
    ? { type: 'tool_call', id, name, raw: given, ...more }
    : { type: 'tool_call', id, name, input: value, ...more };
}

function resultOf(item: Dict, at: string): Part {
  const { call_id: id, output } = item;
  if (typeof id !== 'string') {
    invalid(`${at} needs a call_id`);
  }
  const more = extra(item, ['call_id', 'output']);
  if (typeof output === 'string') {
    return { type: 'tool_result', id, text: output, ...more };
  }
  if (!Array.isArray(output)) {
    invalid(`${at} needs an output`);
  }
  const parts = output.flatMap((part, index) =>
    partsOf(part, `${at}.output[${index}]`),
  );
  return { type: 'tool_result', id, parts, ...more };
}

// The item goes back whole: what it was signed with is the model's own, and
// only its text is what another reader can use.
function reasoningOf(item: Dict): Part {
  const { summary, content } = item;
  const said = [...list(summary), ...list(content)].flatMap((part) =>
    isDict(part) && typeof field(part, 'text') === 'string'
      ? [field(part, 'text')]
      : [],
  );
  return {
    type: 'reasoning',
    text: said.join('\n\n'),
    provider: { [family]: item },
  };
}

function roleOf(role: Json | undefined, at: string) {
  switch (role) {
    case 'user':
    case 'system':
    case 'developer':
    case 'assistant':
      return role;
    default:
      invalid(`${at} has a role that is not known`);
  }
}

type Turn = { role: 'assistant' | 'tool'; parts: Part[] };

function joined(
  messages: Message[],
  open: Turn | undefined,
  role: Turn['role'],
): Turn {
  if (open?.role === role) return open;
  const turn = { role, parts: [] };
  messages.push(turn);
  return turn;
}

// One turn of the model is several items here and one message there, and
// so are the results of its calls. An item of no known kind keeps its place.
export function messagesOf(input: Json | undefined): Message[] {
  if (typeof input === 'string') return [{ role: 'user', text: input }];
  if (!Array.isArray(input)) {
    invalid('input must be a string or a list of items');
  }
  const messages: Message[] = [];
  let turn: Turn | undefined;
  for (const [index, item] of input.entries()) {
    const at = `input[${index}]`;
    if (!isDict(item)) invalid(`${at} must be an object`);
    const { type = 'message' } = item;
    switch (type) {
      case 'message': {
        const role = roleOf(field(item, 'role'), at);
        if (role === 'assistant') {
          turn = joined(messages, turn, role);
          for (const part of spoken(item, at)) turn.parts.push(part);
          break;
        }
        const { content } = item;
        const more = extra(item, ['role', 'content']);
        turn = undefined;
        messages.push(
          typeof content === 'string'
            ? { role, text: content, ...more }
            : { role, parts: contentOf(content, at), ...more },
        );
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
        turn = joined(messages, turn, 'assistant');
        turn.parts.push(callOf(item, at));
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        turn = joined(messages, turn, 'tool');
        turn.parts.push(resultOf(item, at));
        break;
      case 'reasoning':
        turn = joined(messages, turn, 'assistant');
        turn.parts.push(reasoningOf(item));
        break;
      case 'item_reference':
        return unsupported(
          `${at} refers to an item the server would hold, and none is held: send the item itself`,
        );
      default:
        turn = joined(messages, turn, turn?.role ?? 'assistant');
        turn.parts.push({ type: 'provider', provider: { [family]: item } });
    }
  }
  return messages;
}
