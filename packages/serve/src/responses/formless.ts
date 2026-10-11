import type { Codec } from '../codec.ts';
import { formlessIn } from '../wire/formless.ts';
import { api, held } from './family.ts';
import { field } from './fields.ts';
import { imageItem } from './output.ts';

const { answer, note } = formlessIn(api);

// An output item of this API is a message, reasoning, a call for the caller
// to answer, a picture, or an item this API wrote itself.
export const formless: Codec['formless'] = (chunk) => {
  switch (chunk.type) {
    case 'file':
      return imageItem('', chunk) === undefined
        ? answer('file', 'a file the model made that is not an inline image')
        : undefined;
    case 'tool_result':
      return answer('tool_result', 'the result of a tool the upstream ran');
    case 'tool_call':
      return chunk.hosted === true
        ? answer('tool_call', 'a call to a tool the upstream ran')
        : undefined;
    case 'reasoning':
      return chunk.provider === undefined || held(chunk.provider) !== undefined
        ? undefined
        : note('reasoning', 'what a model goes on from its reasoning with');
    case 'provider':
      return typeof field(held(chunk.provider), 'type') === 'string'
        ? undefined
        : answer('provider', 'a part only another API can read');
    case 'citation':
      return held(chunk.provider) === undefined && chunk.url === undefined
        ? note('citation', 'a citation with no address')
        : undefined;
    default:
      return undefined;
  }
};
