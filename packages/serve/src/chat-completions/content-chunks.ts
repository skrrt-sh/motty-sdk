import type { Chunk, Json, Part } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, dict, given, list } from '../wire/json.ts';
import { family, hinted } from './family.ts';

function written(chunks: Json | undefined): string {
  let text = '';
  for (const chunk of list(chunks)) {
    const { type, text: said } = dict(chunk);
    if (type === 'text' && typeof said === 'string') text += said;
  }
  return text;
}

type Spoken = Extract<Chunk, { type: 'text' | 'reasoning' }>;

// Thinking holds text chunks of its own and may be signed. A chunk that is
// neither thinking nor text names a source and says nothing.
export function unchunked(content: readonly Json[]): Spoken[] {
  const out: Spoken[] = [];
  for (const chunk of content) {
    const { type, text, thinking, signature } = dict(chunk);
    if (type === 'text' && typeof text === 'string' && text !== '') {
      out.push({ type: 'text', text });
    }
    if (type !== 'thinking') continue;
    const said = written(thinking);
    const signed = typeof signature === 'string' && signature !== '';
    if (said === '' && !signed) continue;
    out.push({
      type: 'reasoning',
      text: said,
      ...(signed ? { provider: { [family]: { signature } } } : {}),
    });
  }
  return out;
}

// What an assistant turn's content opens with where reasoning goes back as
// a chunk. What another API or dialect signed has no place in it.
export function thinking(
  left: Leaving,
  thoughts: readonly Extract<Part, { type: 'reasoning' }>[],
): Dict[] {
  let signature: string | undefined;
  for (const part of thoughts) {
    const { signature: signed } = hinted(part.provider);
    if (typeof signed === 'string') signature = signed;
    else if (part.provider !== undefined) left.without('reasoning', part);
  }
  const text = thoughts.map((part) => part.text).join('');
  if (text === '') return [];
  return [
    {
      type: 'thinking',
      thinking: [{ type: 'text', text }],
      ...given({ signature }),
    },
  ];
}
