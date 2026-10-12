import type { Chunk, Finish, Progress } from '@mottyjs/core/host';
import { type Dict, dict } from '../wire/json.ts';
import { type Held, whole } from './deltas.ts';
import { besides } from './finish.ts';
import { opening, writer } from './reply.ts';

// What the ending says beside its delta is the message's own, as the delta is.
function ended(event: Dict): Dict {
  const { delta, usage } = event;
  return { ...besides(event), ...dict(delta), usage: usage ?? {} };
}

// The whole message is the stream folded, so both replies agree on which
// chunks make a block.
export function collected(
  events: readonly (Chunk | Progress)[],
  finish: Finish,
  id: string,
  model: string,
  shown: boolean,
): Dict {
  const content: Held[] = [];
  let ending: Dict = {};
  for (const event of [...events, finish].flatMap(writer(shown))) {
    const { type, content_block: block, delta } = event;
    if (type === 'content_block_start') {
      content.push({ block: dict(block), deltas: [] });
    } else if (type === 'content_block_delta') {
      content.at(-1)?.deltas.push(dict(delta));
    } else if (type === 'message_delta') ending = ended(event);
  }
  return { ...opening(id, model), content: content.map(whole), ...ending };
}
