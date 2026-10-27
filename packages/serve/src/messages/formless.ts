import type { Formless } from '../codec.ts';
import { apis } from '../wire/fieldless.ts';
import { formlessIn } from '../wire/formless.ts';
import { hinted } from './family.ts';

const { answer, note } = formlessIn(apis.messages);

function own(chunk: Parameters<Formless>[0]): boolean {
  return Object.keys(hinted(chunk.provider)).length > 0;
}

// An assistant message of this API holds text, thinking, calls, and blocks
// this API wrote itself: a tool's result and a citation are among those.
export const formless: Formless = (chunk) => {
  switch (chunk.type) {
    case 'file':
      return answer('file', 'a file the model made');
    case 'tool_result':
      return answer('tool_result', 'the result of a tool the upstream ran');
    case 'tool_call':
      return chunk.hosted === true && !own(chunk)
        ? answer('tool_call', 'a call to a tool another upstream ran')
        : undefined;
    case 'reasoning':
      return chunk.provider === undefined || own(chunk)
        ? undefined
        : note('reasoning', 'what a model goes on from its reasoning with');
    case 'provider':
      return own(chunk)
        ? undefined
        : answer('provider', 'a part only another API can read');
    case 'citation':
      return own(chunk)
        ? undefined
        : note('citation', 'a citation another API wrote');
    default:
      return undefined;
  }
};
