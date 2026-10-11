import type { Chunk, Finish, Json, Progress } from '@mottyjs/core/host';
import { type Dict, dict, isDict, parsed, text } from '../wire/json.ts';
import { opening, writer } from './reply.ts';

function joined(held: Json | undefined, more: Json | undefined): string {
  return `${text(held) ?? ''}${text(more) ?? ''}`;
}

function grown(block: Dict, delta: Dict): Dict {
  const { type, text: said, thinking, signature, citation } = delta;
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
      return block;
  }
}

// The whole message is the stream folded, so both replies agree on which
// chunks make a block. Input here must be an object, so arguments that are
// not one go under the key this API's guide gives input that did not parse.
export function collected(
  events: readonly (Chunk | Progress)[],
  finish: Finish,
  id: string,
  model: string,
  shown: boolean,
): Dict {
  const content: Dict[] = [];
  let json = '';
  let ending: Dict = {};
  for (const event of [...events, finish].flatMap(writer(shown))) {
    const { type, content_block: block, delta, usage } = event;
    if (type === 'content_block_start') {
      content.push(dict(block));
      continue;
    }
    if (type === 'message_delta') {
      ending = { ...dict(delta), usage: usage ?? {} };
      continue;
    }
    const last = content.pop();
    if (last === undefined) continue;
    if (type === 'content_block_delta') {
      const fields = dict(delta);
      const { partial_json: partial } = fields;
      json += text(partial) ?? '';
      content.push(grown(last, fields));
      continue;
    }
    const input = parsed(json);
    content.push(
      json === ''
        ? last
        : { ...last, input: isDict(input) ? input : { INVALID_JSON: json } },
    );
    json = '';
  }
  return { ...opening(id, model), content, ...ending };
}
