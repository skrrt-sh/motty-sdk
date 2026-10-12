import type { Chunk, Json } from '@mottyjs/core/host';
import { given } from '../wire/json.ts';
import { held } from './family.ts';
import { put } from './fields.ts';
import {
  contentPart,
  ended,
  type Message,
  messageItem,
  type Sent,
  type Spoken,
  type Writing,
} from './output.ts';

function opened(writing: Writing, from: Chunk, sent: Sent[]): Message {
  const now = writing.open;
  if (now?.kind === 'message' && now.block === from.block) return now;
  sent.push(...writing.settled());
  const index = writing.output.length;
  const { phase } = held(from.provider) ?? {};
  const next: Message = {
    kind: 'message',
    index,
    id: `msg_${writing.id}_${index}`,
    block: from.block,
    content: [],
    item: given({ phase }),
  };
  writing.open = next;
  sent.push(writing.added(messageItem(next, 'in_progress')));
  return next;
}

function spoken(now: Message, refusal: boolean, sent: Sent[]): Spoken {
  const last = now.content.at(-1);
  if (last !== undefined && last.refusal === refusal) return last;
  sent.push(...ended(now));
  const part = { refusal, text: '', annotations: [] };
  now.content.push(part);
  sent.push({
    type: 'response.content_part.added',
    item_id: now.id,
    output_index: now.index,
    content_index: now.content.length - 1,
    part: contentPart(part),
  });
  return part;
}

export function said(
  writing: Writing,
  event: Chunk & { type: 'text' | 'refusal' },
): Sent[] {
  const sent: Sent[] = [];
  const refusal = event.type === 'refusal';
  if (event.text === '') {
    // A phase may be told with no text to ride on, so text that is empty
    // says of its item alone, and with no phase it opens no item.
    const { phase } = held(event.provider) ?? {};
    if (phase !== undefined) put(opened(writing, event, sent).item, { phase });
    return sent;
  }
  const message = opened(writing, event, sent);
  const part = spoken(message, refusal, sent);
  part.text += event.text;
  sent.push({
    type: refusal ? 'response.refusal.delta' : 'response.output_text.delta',
    item_id: message.id,
    output_index: message.index,
    content_index: message.content.length - 1,
    delta: event.text,
    ...(refusal ? {} : { logprobs: [] }),
  });
  return sent;
}

export function cited(
  writing: Writing,
  event: Chunk & { type: 'citation' },
): Sent[] {
  const sent: Sent[] = [];
  const message = opened(writing, event, sent);
  const part = spoken(message, false, sent);
  // Which words a source backs is not known, so it is cited where the
  // text now ends. A source with no address has no form on this wire.
  const annotation: Json | undefined =
    held(event.provider) ??
    (event.url === undefined
      ? undefined
      : {
          type: 'url_citation',
          url: event.url,
          title: event.title ?? '',
          start_index: part.text.length,
          end_index: part.text.length,
        });
  if (annotation === undefined) return sent;
  part.annotations.push(annotation);
  sent.push({
    type: 'response.output_text.annotation.added',
    item_id: message.id,
    output_index: message.index,
    content_index: message.content.length - 1,
    annotation_index: part.annotations.length - 1,
    annotation,
  });
  return sent;
}
