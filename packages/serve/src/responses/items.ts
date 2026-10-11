import type { Json, Message, Part } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, text } from '../wire/json.ts';
import { breakpoint } from '../wire/openai-cache.ts';
import { a, unsupported } from '../wire/refusals.ts';
import { inputContent } from './content.ts';
import { carried, held, hinted, own } from './family.ts';
import { field, without } from './fields.ts';

type Call = Part & { type: 'tool_call' };
type Result = Part & { type: 'tool_result' };

function callItem(left: Leaving, part: Call, custom: boolean): Dict {
  left.without('hosted', part.hosted);
  const written = part.raw ?? JSON.stringify(part.input);
  return {
    ...carried(part, 'a tool call'),
    call_id: part.id,
    name: part.name,
    ...(custom
      ? {
          type: 'custom_tool_call',
          input: typeof part.input === 'string' ? part.input : written,
        }
      : { type: 'function_call', arguments: written }),
  };
}

function resultItem(left: Leaving, part: Result, custom: boolean): Dict {
  left.without('hosted', part.hosted);
  left.without('tool_result.failed', part.failed);
  return {
    ...carried(part, 'a tool result'),
    type: custom ? 'custom_tool_call_output' : 'function_call_output',
    call_id: part.id,
    output: part.text ?? part.parts.map((inner) => inputContent(left, inner)),
  };
}

function annotation(part: Part & { type: 'citation' }): Json | undefined {
  const written = held(part.provider);
  if (written !== undefined) return written;
  if (part.url === undefined) return undefined;
  return {
    type: 'url_citation',
    url: part.url,
    title: part.title ?? '',
    start_index: 0,
    end_index: 0,
  };
}

// What the first part of an output message carries for the whole item.
const whole = ['id', 'status', 'phase'];

function items(
  left: Leaving,
  message: Message & { parts: readonly Part[] },
  customNames: ReadonlySet<string>,
  customCalls: Set<string>,
): Dict[] {
  const { role } = message;
  const out: Dict[] = [];
  let head = carried(message, 'a message option');
  let content: Dict[] = [];
  let cited: Json[] | undefined;
  // What the message carried waits for the first message item it becomes.
  const flushed = () => {
    if (content.length > 0) {
      out.push({ ...head, type: 'message', role, content });
      head = {};
    }
    content = [];
    cited = undefined;
  };
  const apart = ['tool_call', 'tool_result', 'reasoning', 'citation'];
  // A message's marker goes on the last content of it that can hold one.
  const closing =
    role === 'assistant' || role === 'tool'
      ? undefined
      : message.parts.findLast((part) => !apart.includes(part.type));
  if (closing === undefined) left.without('cache.outside', message.cache);
  const input = (part: Part) => ({
    ...inputContent(left, part),
    ...(part === closing ? breakpoint(left, message.cache) : {}),
  });
  for (const part of message.parts) {
    if (part.type === 'tool_call' || part.type === 'tool_result') {
      left.without('tool.cache', part.cache);
    } else if (part.type !== 'provider') {
      const outside = role === 'assistant' || apart.includes(part.type);
      if (outside) left.without('cache.outside', part.cache);
    }
    switch (part.type) {
      case 'tool_call': {
        flushed();
        const custom = customNames.has(part.name);
        if (custom) customCalls.add(part.id);
        out.push(callItem(left, part, custom));
        break;
      }
      case 'tool_result':
        flushed();
        out.push(resultItem(left, part, customCalls.has(part.id)));
        break;
      case 'reasoning': {
        // Reasoning this API did not sign, a motty's own progress or another
        // model's, is nothing this upstream can take back. A model of
        // another maker signs its item where this API's own encrypts it.
        const item = held(part.provider);
        const signed =
          text(field(item, 'encrypted_content')) ||
          text(field(item, 'signature'));
        if (
          item === undefined ||
          !signed ||
          field(item, 'type') !== 'reasoning'
        ) {
          left.without('reasoning', part);
          break;
        }
        flushed();
        out.push(item);
        break;
      }
      case 'provider':
        if (role === 'assistant' || role === 'tool') {
          flushed();
          out.push({ ...hinted(part.hints), ...own(part.provider, 'a part') });
        } else {
          content.push(input(part));
        }
        break;
      case 'citation': {
        const written = annotation(part);
        if (written === undefined || cited === undefined) {
          left.without('citation', part);
        } else cited.push(written);
        break;
      }
      default: {
        if (role === 'tool') {
          unsupported(
            `The Responses API cannot carry ${a(part.type)} part in a tool message`,
          );
        }
        if (role !== 'assistant') {
          content.push(input(part));
          break;
        }
        if (part.type !== 'text' && part.type !== 'refusal') {
          unsupported(
            `The Responses API cannot carry ${a(part.type)} part the model wrote`,
          );
        }
        const data = carried(part, 'a part');
        const item = Object.fromEntries(
          Object.entries(data).filter(([key]) => whole.includes(key)),
        );
        if (Object.keys(item).length > 0) {
          flushed();
          head = { ...head, ...item };
        }
        if (part.type === 'refusal') {
          content.push({
            ...without(data, whole),
            type: 'refusal',
            refusal: part.text,
          });
          cited = undefined;
          break;
        }
        cited = [];
        content.push({
          ...without(data, whole),
          type: 'output_text',
          text: part.text,
          annotations: cited,
        });
      }
    }
  }
  flushed();
  left.without('message.hints', Object.keys(head).length > 0);
  return out;
}

// One message may be several items: a call, a result and reasoning are
// each an item of their own beside the message they came in.
export function inputOf(
  left: Leaving,
  messages: readonly Message[],
  customNames: ReadonlySet<string>,
): { instructions?: string; input: Dict[] } {
  const customCalls = new Set<string>();
  const input: Dict[] = [];
  let instructions: string | undefined;
  for (const [index, message] of messages.entries()) {
    left.without('message.name', message.name);
    if (message.parts !== undefined) {
      for (const item of items(left, message, customNames, customCalls)) {
        input.push(item);
      }
      continue;
    }
    const { instructions: leads, ...more } = carried(
      message,
      'a message option',
    );
    if (message.role === 'tool') {
      unsupported(
        'The Responses API cannot carry a tool message with no tool result',
      );
    }
    const lead = index === 0 && leads === true && message.role !== 'assistant';
    // Instructions and what the model wrote are not input content.
    const outside = lead || message.role === 'assistant';
    if (outside) left.without('cache.outside', message.cache);
    if (lead) {
      left.without('message.hints', Object.keys(more).length > 0);
      instructions = message.text;
      continue;
    }
    const { text: said, cache } = message;
    input.push({
      ...more,
      type: 'message',
      role: message.role,
      content:
        outside || cache === undefined
          ? said
          : [{ type: 'input_text', text: said, ...breakpoint(left, cache) }],
    });
  }
  return { ...(instructions === undefined ? {} : { instructions }), input };
}
