import type { Json } from '@mottyjs/core/host';
import { type Dict, text } from '../wire/json.ts';

function joined(held: Json | undefined, more: Json | undefined): string {
  return `${text(held) ?? ''}${text(more) ?? ''}`;
}

// A delta of a kind not read here says fields of the block as they end,
// beside the input, which comes in pieces of JSON.
export function grown(block: Dict, delta: Dict): Dict {
  const { type, partial_json, ...fields } = delta;
  const { text: said, thinking, signature, citation } = fields;
  const { text: held, thinking: mind, citations } = block;
  switch (type) {
    case 'text_delta':
      return { ...block, text: joined(held, said) };
    case 'thinking_delta':
      return { ...block, thinking: joined(mind, thinking) };
    case 'signature_delta':
      return { ...block, signature: signature ?? '' };
    case 'citations_delta':
      return {
        ...block,
        citations: [
          ...(Array.isArray(citations) ? citations : []),
          citation ?? null,
        ],
      };
    default:
      return { ...block, ...fields };
  }
}
