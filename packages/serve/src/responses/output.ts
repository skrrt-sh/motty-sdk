import type { Chunk, Json } from '@mottyjs/core/host';
import { type Dict, list } from '../wire/json.ts';
import { held } from './family.ts';
import { field } from './fields.ts';

export type Sent = { type: string; [field: string]: Json };

export type Thought = {
  kind: 'reasoning';
  index: number;
  id: string;
  block: number | undefined;
  progress: boolean;
  piece: number | undefined;
  summary: string[];
  content: string[];
  // Which of the two the part still being written is in.
  part: 'summary' | 'content' | undefined;
  item: Dict;
};

export type Spoken = { refusal: boolean; text: string; annotations: Json[] };

export type Message = {
  kind: 'message';
  index: number;
  id: string;
  block: number | undefined;
  content: Spoken[];
  item: Dict;
};

export type Call = {
  index: number;
  id: string;
  item: Dict;
  holds: 'input' | 'arguments';
  given: string;
};

export type Ended = 'completed' | 'incomplete';

// What the writers of one reply share: the items so far, and the one item
// that is still being written.
export type Writing = {
  id: string;
  output: Dict[];
  open: Thought | Message | undefined;
  added: (item: Dict) => Sent;
  settled: (status?: Ended) => Sent[];
};

// A reasoning item says its status only when it did not finish. The content
// an item came with is what the model signed, so it stays as it came.
export function thoughtItem(
  { item, id, summary, content }: Thought,
  status?: Ended,
): Dict {
  const { content: came } = item;
  const own = list(came).length > 0 || content.length === 0;
  return {
    ...item,
    id,
    type: 'reasoning',
    ...(status === 'incomplete' ? { status } : {}),
    summary: summary.map((said) => ({ type: 'summary_text', text: said })),
    ...(own
      ? {}
      : {
          content: content.map((said) => ({
            type: 'reasoning_text',
            text: said,
          })),
        }),
  };
}

export function contentPart({
  refusal,
  text: said,
  annotations,
}: Spoken): Dict {
  return refusal
    ? { type: 'refusal', refusal: said }
    : { type: 'output_text', text: said, annotations, logprobs: [] };
}

export function messageItem(message: Message, status: string): Dict {
  return {
    ...message.item,
    id: message.id,
    type: 'message',
    status,
    role: 'assistant',
    content: message.content.map(contentPart),
  };
}

// A custom tool call has no status on this API.
export function callItem({ item, holds, given }: Call, status: string): Dict {
  return {
    ...item,
    ...(holds === 'arguments' ? { status } : {}),
    [holds]: given,
  };
}

// A picture the model made has one form on this API, the item its own image
// tool answers with, and that item holds the bytes themselves. An upstream
// of this API sent that item, which is written as it came.
export function imageItem(
  id: string,
  { data, mediaType, provider }: Chunk & { type: 'file' },
): Dict | undefined {
  const own = held(provider);
  if (typeof field(own, 'type') === 'string') return own;
  if (data === undefined || !mediaType.startsWith('image/')) return undefined;
  return {
    id,
    type: 'image_generation_call',
    status: 'completed',
    result: data,
  };
}

export function ended(open: Thought | Message): Sent[] {
  const at = { item_id: open.id, output_index: open.index };
  if (open.kind === 'reasoning') {
    if (open.part === undefined) return [];
    const said = open[open.part].at(-1) ?? '';
    const index = open[open.part].length - 1;
    if (open.part === 'content') {
      const part = { ...at, content_index: index };
      return [
        { type: 'response.reasoning_text.done', ...part, text: said },
        {
          type: 'response.content_part.done',
          ...part,
          part: { type: 'reasoning_text', text: said },
        },
      ];
    }
    const part = { ...at, summary_index: index };
    return [
      { type: 'response.reasoning_summary_text.done', ...part, text: said },
      {
        type: 'response.reasoning_summary_part.done',
        ...part,
        part: { type: 'summary_text', text: said },
      },
    ];
  }
  const last = open.content.at(-1);
  if (last === undefined) return [];
  const part = { ...at, content_index: open.content.length - 1 };
  return [
    last.refusal
      ? { type: 'response.refusal.done', ...part, refusal: last.text }
      : {
          type: 'response.output_text.done',
          ...part,
          text: last.text,
          logprobs: [],
        },
    { type: 'response.content_part.done', ...part, part: contentPart(last) },
  ];
}
