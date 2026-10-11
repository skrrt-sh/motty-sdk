import type { Chunk, Finish, Json, Progress } from '@mottyjs/core/host';
import type { Dict } from '../wire/json.ts';
import { joined } from './dialect.ts';
import { reasonWritten, replyFields } from './finish.ts';
import { pieces } from './reply-pieces.ts';
import { usageField } from './usage.ts';

// Sound arrives in fragments of one object: its data and its transcript
// grow, and what names it is said once.
function heard(whole: Dict, fragment: Dict): Dict {
  const merged = { ...whole };
  for (const [key, value] of Object.entries(fragment)) {
    const held = merged[key];
    merged[key] =
      typeof held === 'string' &&
      typeof value === 'string' &&
      (key === 'data' || key === 'transcript')
        ? held + value
        : value;
  }
  return merged;
}

export function collected(
  events: readonly (Chunk | Progress)[],
  finish: Finish,
  given: { id: string; model: string; muted: boolean },
): Json {
  const piece = pieces(given.muted);
  const said = { reasoning: '', content: '', refusal: '' };
  const tokens: { content: Json[]; refusal: Json[] } = {
    content: [],
    refusal: [],
  };
  const calls: { id: string; name: string; custom: boolean; input: string }[] =
    [];
  const annotations: Json[] = [];
  const details: Json[] = [];
  const images: Json[] = [];
  let audio: Dict | undefined;
  for (const event of events) {
    const added = piece(event);
    switch (added?.kind) {
      case undefined:
        break;
      case 'reasoning':
        said.reasoning += added.text;
        details.push(...(added.details ?? []));
        break;
      case 'content':
      case 'refusal':
        said[added.kind] += added.text;
        tokens[added.kind].push(...(added.logprobs ?? []));
        break;
      case 'call': {
        const { opened, custom, input, index } = added;
        if (opened !== undefined) calls.push({ ...opened, custom, input: '' });
        const call = calls[index];
        if (call !== undefined) call.input += input;
        break;
      }
      case 'annotation':
        annotations.push(added.annotation);
        break;
      case 'audio':
        audio = heard(audio ?? {}, added.audio);
        break;
      case 'image':
        images.push(added.image);
        break;
      default:
        added satisfies never;
    }
  }
  const probable = tokens.content.length + tokens.refusal.length > 0;
  const message = {
    role: 'assistant',
    // Null where nothing was said, as the API answers a turn of tool calls.
    content:
      said.content === '' && (calls.length > 0 || said.refusal !== '')
        ? null
        : said.content,
    refusal: said.refusal === '' ? null : said.refusal,
    ...(said.reasoning === ''
      ? {}
      : { reasoning: said.reasoning, reasoning_content: said.reasoning }),
    ...(details.length === 0 ? {} : { reasoning_details: joined(details) }),
    ...(calls.length === 0
      ? {}
      : {
          tool_calls: calls.map(({ id, name, custom, input }) =>
            custom
              ? { id, type: 'custom', custom: { name, input } }
              : { id, type: 'function', function: { name, arguments: input } },
          ),
        }),
    ...(annotations.length === 0 ? {} : { annotations }),
    ...(audio === undefined ? {} : { audio }),
    ...(images.length === 0 ? {} : { images }),
  };
  return {
    id: `chatcmpl-${given.id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: given.model,
    ...replyFields(finish),
    choices: [
      {
        index: 0,
        message,
        logprobs: probable
          ? {
              content: tokens.content.length === 0 ? null : tokens.content,
              refusal: tokens.refusal.length === 0 ? null : tokens.refusal,
            }
          : null,
        finish_reason: reasonWritten(finish.reason),
      },
    ],
    ...usageField(finish.usage),
  };
}
