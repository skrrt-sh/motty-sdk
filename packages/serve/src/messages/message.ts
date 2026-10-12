import type { Chunk, Finish, Progress } from '@mottyjs/core/host';
import { type Dict, dict, isDict, parsed, text } from '../wire/json.ts';
import { grown } from './deltas.ts';
import { besides } from './finish.ts';
import { opening, writer } from './reply.ts';

// What the ending says beside its delta is the message's own, as the delta is.
function ended(event: Dict): Dict {
  const { delta, usage } = event;
  return { ...besides(event), ...dict(delta), usage: usage ?? {} };
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
    const { type, content_block: block, delta } = event;
    if (type === 'content_block_start') {
      content.push(dict(block));
      continue;
    }
    if (type === 'message_delta') {
      ending = ended(event);
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
