import type { Chunk, Json, ProviderData } from '@mottyjs/core/host';
import { joined } from '../wire/details.ts';
import {
  copied,
  type Dict,
  dict,
  isDict,
  list,
  parsed,
  text,
} from '../wire/json.ts';
import { family } from './family.ts';
import { field } from './fields.ts';
import { ended, type Sent, thoughtItem, type Writing } from './output.ts';

// What a model of another family goes on from its reasoning with is held
// where this API's own is encrypted, as that family's data: the caller sends
// the item back whole, and only that family reads it. Beside it is the text
// it signs, where the caller muted reasoning and was shown none.
export function unsealed(
  value: Json | undefined,
): { data: Dict; said: string } | undefined {
  if (typeof value !== 'string' || !value.startsWith('{')) return undefined;
  const { text: said = '', ...data } = dict(parsed(value));
  const entries = Object.entries(data);
  return typeof said === 'string' &&
    entries.length > 0 &&
    entries.every(([key, fields]) => key !== family && isDict(fields))
    ? { data, said }
    : undefined;
}

function sealed(item: Dict, more: ProviderData, hidden: string): Dict {
  const { encrypted_content: before } = item;
  const { data: held = {}, said = '' } = unsealed(before) ?? {};
  for (const [key, fields] of Object.entries(more)) {
    const was = dict(held[key]);
    const now = dict(copied(fields));
    // Details stream as fragments of one list, joined as a reply joins them.
    const { reasoning_details: had } = was;
    const { reasoning_details: added } = now;
    const details = joined([...list(had), ...list(added)]);
    held[key] = {
      ...was,
      ...now,
      ...(details.length === 0 ? {} : { reasoning_details: details }),
    };
  }
  const text = said + hidden;
  return {
    ...item,
    encrypted_content: JSON.stringify(text === '' ? held : { ...held, text }),
  };
}

// A summary and the reasoning itself are two kinds of part of one item, each
// with its own events and its own count.
export function thought(
  writing: Writing,
  said: string,
  from: {
    part: 'summary' | 'content';
    block?: number;
    piece?: number;
    item?: Dict;
    carried?: ProviderData;
    hidden?: string;
  },
): Sent[] {
  const sent: Sent[] = [];
  const progress = from.piece !== undefined;
  let now = writing.open;
  if (
    now?.kind !== 'reasoning' ||
    now.progress !== progress ||
    now.block !== from.block
  ) {
    sent.push(...writing.settled());
    const index = writing.output.length;
    now = {
      kind: 'reasoning',
      index,
      id: text(field(from.item, 'id')) ?? `rs_${writing.id}_${index}`,
      block: from.block,
      progress,
      piece: undefined,
      summary: [],
      content: [],
      part: undefined,
      item: from.item ?? { content: [] },
    };
    writing.open = now;
    sent.push(writing.added(thoughtItem(now)));
  } else if (from.item !== undefined) now.item = from.item;
  if (from.carried !== undefined) {
    now.item = sealed(now.item, from.carried, from.hidden ?? '');
  }
  if (said === '') return sent;
  const { part } = from;
  const at = { item_id: now.id, output_index: now.index };
  if (now.part !== part || now.piece !== from.piece) {
    sent.push(...ended(now));
    now[part].push('');
    now.part = part;
    now.piece = from.piece;
    sent.push(
      part === 'content'
        ? {
            type: 'response.content_part.added',
            ...at,
            content_index: now.content.length - 1,
            part: { type: 'reasoning_text', text: '' },
          }
        : {
            type: 'response.reasoning_summary_part.added',
            ...at,
            summary_index: now.summary.length - 1,
            part: { type: 'summary_text', text: '' },
          },
    );
  }
  const last = now[part].length - 1;
  now[part][last] += said;
  sent.push(
    part === 'content'
      ? {
          type: 'response.reasoning_text.delta',
          ...at,
          content_index: last,
          delta: said,
        }
      : {
          type: 'response.reasoning_summary_text.delta',
          ...at,
          summary_index: last,
          delta: said,
        },
  );
  return sent;
}

// Read from an upstream, the two are told apart by the kind of part the text
// came in, which only this API reads.
export function reasoned(
  block: number,
  type: 'summary_text' | 'reasoning_text',
  said: string,
): Chunk {
  return {
    type: 'reasoning',
    text: said,
    block,
    provider: { [family]: { type } },
  };
}

// An item that came with no pieces before it: the parts of a kind are joined
// the way their pieces are.
export function reasonedWhole(block: number, item: Dict): Chunk[] {
  const { summary, content } = item;
  const joined = (parts: Json | undefined) =>
    list(parts)
      .flatMap((part) => text(field(part, 'text')) ?? [])
      .join('\n\n');
  return [
    reasoned(block, 'summary_text', joined(summary)),
    reasoned(block, 'reasoning_text', joined(content)),
  ].filter((chunk) => chunk.type === 'reasoning' && chunk.text !== '');
}
