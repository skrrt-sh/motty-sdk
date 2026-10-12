import type { Json } from '@mottyjs/core/host';
import { type Dict, isDict, list, parsed, text } from '../wire/json.ts';

export type Held = { block: Dict; deltas: Dict[] };

function joined(held: Json | undefined, more: Json | undefined): string {
  return `${text(held) ?? ''}${text(more) ?? ''}`;
}

export function inputOf(json: string): Dict | undefined {
  const input = parsed(json);
  return isDict(input) ? input : undefined;
}

// The block is built once, after its last delta. Built again for each one, a
// block of many fields cost the square of its deltas. Input that is no object
// goes under the key this API's guide names, so a call cut short reads failed.
export function whole({ block, deltas }: Held): Dict {
  if (deltas.length === 0) return block;
  const fields = new Map(Object.entries(block));
  let json = '';
  for (const delta of deltas) {
    const { type, text: said, thinking, signature, citation } = delta;
    switch (type) {
      case 'text_delta':
        fields.set('text', joined(fields.get('text'), said));
        break;
      case 'thinking_delta':
        fields.set('thinking', joined(fields.get('thinking'), thinking));
        break;
      case 'signature_delta':
        fields.set('signature', signature ?? '');
        break;
      case 'citations_delta':
        fields.set('citations', [
          ...list(fields.get('citations')),
          citation ?? null,
        ]);
        break;
      default:
        for (const [name, value] of Object.entries(delta)) {
          if (name === 'partial_json') json += text(value) ?? '';
          else if (name !== 'type') fields.set(name, value);
        }
    }
  }
  if (json !== '') fields.set('input', inputOf(json) ?? { INVALID_JSON: json });
  return Object.fromEntries(fields);
}
