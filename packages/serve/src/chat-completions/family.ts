import { apis } from '../wire/fieldless.ts';
import { providerData } from '../wire/provider-data.ts';

export const family = 'openai.chat';

export const api = apis.chat;

// What only the Responses API has, by OpenAI's reference. Its `reasoning`
// object is not here: a router's Chat Completions takes one of that name.
export const elsewhere: ReadonlySet<string> = new Set([
  'access_programs',
  'background',
  'context_management',
  'conversation',
  'include',
  'input',
  'instructions',
  'max_output_tokens',
  'max_tool_calls',
  'previous_response_id',
  'prompt',
  'text',
  'truncation',
]);

export const { hinted, own, mine, addressed, marked, noted } = providerData(
  family,
  api,
  'openai',
  elsewhere,
);
