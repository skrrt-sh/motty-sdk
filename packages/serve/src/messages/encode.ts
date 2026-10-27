import type { Json, Message } from '@mottyjs/core/host';
import type { Codec } from '../codec.ts';
import { type Leaving, leaving } from '../wire/fieldless.ts';
import { type Dict, dict, given } from '../wire/json.ts';
import { offered } from '../wire/offered.ts';
import { unsupported } from '../wire/refusals.ts';
import { unsampled } from '../wire/taken.ts';
import { blocksOf } from './blocks.ts';
import { family, hinted, own } from './family.ts';
import { optionsTo } from './options.ts';
import { unsaid } from './reasoning.ts';
import { toolTo } from './tools.ts';

function instructs({ role }: Message): boolean {
  return role === 'system' || role === 'developer';
}

function fieldsTo(message: Message): Dict {
  return { ...hinted(message.hints), ...own(message.provider, 'a message') };
}

// The top-level field has nowhere for a message's own fields, so an
// instruction that has any stays a turn.
function leads(message: Message): boolean {
  return instructs(message) && Object.keys(fieldsTo(message)).length === 0;
}

function blocks(left: Leaving, message: Message): Dict[] {
  return message.parts === undefined
    ? blocksOf(left, [{ type: 'text', text: message.text }], message.cache)
    : blocksOf(left, message.parts, message.cache);
}

// Plain text stays a string, unless a cache marker needs a block to sit on.
function contentTo(left: Leaving, message: Message): string | Dict[] {
  return message.cache === undefined &&
    message.text !== undefined &&
    message.text !== ''
    ? message.text
    : blocks(left, message);
}

function systemTo(
  left: Leaving,
  leading: readonly Message[],
): string | Dict[] | undefined {
  const [first, ...more] = leading;
  if (first === undefined) return undefined;
  const system =
    more.length === 0
      ? contentTo(left, first)
      : leading.flatMap((message) => blocks(left, message));
  // The field of its own takes text alone.
  for (const { type } of typeof system === 'string' ? [] : system) {
    if (type !== 'text') {
      unsupported(`Anthropic Messages takes no ${type} block as instructions`);
    }
  }
  return system.length === 0 ? undefined : system;
}

// A message left with no block, such as one that held only reasoning nobody
// signed, is not sent: the API takes no empty turn. An instruction is, when
// its own fields still steer the model.
function messageTo(left: Leaving, message: Message): Dict[] {
  const fields = fieldsTo(message);
  const content = contentTo(left, message);
  const role = instructs(message)
    ? 'system'
    : message.role === 'assistant'
      ? 'assistant'
      : 'user';
  if (content.length > 0) return [{ role, content, ...fields }];
  return role === 'system' && Object.keys(fields).length > 0
    ? [{ role, content: [], ...fields }]
    : [];
}

function resultsOf({ role, content, ...fields }: Dict): Json[] | undefined {
  if (role !== 'user' || !Array.isArray(content)) return undefined;
  if (Object.keys(fields).length > 0) return undefined;
  const results = content.every((block) => {
    const { type } = dict(block);
    return type === 'tool_result';
  });
  return results ? content : undefined;
}

// The API asks for every result of one assistant turn in a single user
// turn, where the two OpenAI APIs send a message or an item for each.
function gathered(turns: readonly Dict[]): Dict[] {
  const sent: Dict[] = [];
  // The results of the turn sent last, added to in place: read again and
  // copied for every turn, a long run cost the square of its length.
  let open: Json[] | undefined;
  for (const turn of turns) {
    const more = resultsOf(turn);
    if (open === undefined || more === undefined) {
      sent.push(turn);
      open = more;
    } else for (const result of more) open.push(result);
  }
  return sent;
}

function says({ content }: Dict): boolean {
  return typeof content === 'string' || Array.isArray(content)
    ? content.length > 0
    : false;
}

function hostedResult({ role, content }: Dict): boolean {
  const last = Array.isArray(content) ? content.at(-1) : undefined;
  const { type } = dict(last);
  return (
    role === 'assistant' &&
    typeof type === 'string' &&
    type.endsWith('_tool_result')
  );
}

function settled(sent: readonly Dict[], waiting: Dict[]): Dict[] {
  if (!waiting.some(says)) return waiting;
  const before = dict(sent.at(-1));
  const { role } = before;
  return role === 'user' || hostedResult(before)
    ? waiting
    : unsupported(
        'Anthropic Messages takes an instruction between turns only after a user turn',
      );
}

// The API takes an instruction only after a user turn and before an
// assistant turn or the end. One before user turns waits past them, as its
// guide tells a client to; that changes the caller's order, so it is told.
function placed(left: Leaving, turns: readonly Dict[]): Dict[] {
  const sent: Dict[] = [];
  let waiting: Dict[] = [];
  for (const turn of turns) {
    const { role } = turn;
    if (role === 'system') {
      waiting.push(turn);
      continue;
    }
    if (role !== 'user' || !waiting.some(says)) {
      sent.push(...settled(sent, waiting));
      waiting = [];
    } else left.without('message.moved', true);
    sent.push(turn);
  }
  return [...sent, ...settled(sent, waiting)];
}

export function encode(
  ...[model, prompt, defaults = {}, takes]: Parameters<Codec['encode']>
): ReturnType<Codec['encode']> {
  const turn = prompt.messages.findIndex((message) => !leads(message));
  const start = turn === -1 ? prompt.messages.length : turn;
  const left = leaving('messages');
  const { headers, fields } = optionsTo(
    left,
    prompt.options ?? {},
    prompt.output,
    defaults,
    takes && ((reasons) => takes(model, reasons)),
  );
  const tools = offered(
    left,
    family,
    prompt.tools,
    prompt.options?.toolChoice,
  ).flatMap((tool) => toolTo(left, tool) ?? []);
  for (const { name } of prompt.messages) left.without('message.name', name);
  const system = systemTo(left, prompt.messages.slice(0, start));
  const turns = prompt.messages
    .slice(start)
    .flatMap((message) => messageTo(left, message));
  return {
    path: '/messages',
    headers,
    body: {
      ...unsampled(
        unsaid(prompt.options?.reasoning, defaults),
        prompt.options ?? {},
      ),
      ...fields,
      model,
      ...given({ system }),
      messages: placed(left, gathered(turns)),
      ...(tools.length === 0 ? {} : { tools }),
      stream: true,
    },
    leftOut: left.leftOut(),
  };
}
