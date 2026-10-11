import type { Codec } from '../codec.ts';
import { formlessIn } from '../wire/formless.ts';
import { isDict } from '../wire/json.ts';
import { api, hinted } from './family.ts';
import { pictured } from './reply-pieces.ts';

const { answer, note } = formlessIn(api);

// An assistant message of this API holds text, a refusal, calls for the
// caller to answer, annotations with an address, sound, and pictures.
export const formless: Codec['formless'] = (chunk) => {
  switch (chunk.type) {
    case 'file':
      return pictured(chunk) === undefined
        ? answer('file', 'a file the model made that is not a picture')
        : undefined;
    case 'tool_result':
      return answer('tool_result', 'the result of a tool the upstream ran');
    case 'tool_call':
      return chunk.hosted === true
        ? answer('tool_call', 'a call to a tool the upstream ran')
        : undefined;
    case 'reasoning': {
      // Details are this family's own, and a caller may send them back.
      const { reasoning_details: details } = hinted(chunk.provider);
      return chunk.provider === undefined || Array.isArray(details)
        ? undefined
        : note('reasoning', 'what a model goes on from its reasoning with');
    }
    case 'provider': {
      const { audio } = hinted(chunk.provider);
      return isDict(audio)
        ? undefined
        : answer('provider', 'a part only another API can read');
    }
    case 'citation':
      return chunk.url === undefined
        ? note('citation', 'a citation with no address')
        : undefined;
    default:
      return undefined;
  }
};
