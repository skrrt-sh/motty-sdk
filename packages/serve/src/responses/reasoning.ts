import type { Chunk, Json } from '@mottyjs/core/host';
import { type Dict, list, text } from '../wire/json.ts';
import { family } from './family.ts';
import { field } from './fields.ts';
import { ended, type Sent, thoughtItem, type Writing } from './output.ts';

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
