import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';

// Together tells a prompt that does not fit the model's context as 403, in
// an error of its own. A 403 with none is the network's before it.
const failures: FailureReader = (status, _headers, { message }) =>
  status === 403 && typeof message === 'string'
    ? { code: 'context_too_long' }
    : undefined;

const shared: Parameters<typeof chatCompletionsIn>[0] = {
  name: 'together',
  efforts: ['low', 'medium', 'high'],
  topK: true,
  limit: 'max_tokens',
  // A natural stop is told apart from a stop sequence, and some models
  // count cached tokens with no details around them.
  endings: { eos: 'stop' },
  flat: true,
  failures,
};

// The models served here take reasoning back under the name they sent it
// by, and are told not to reason by a flag: one family has an effort and no
// flag, and one always reasons, between think tags.
const named = chatCompletionsIn({
  ...shared,
  thought: 'reasoning',
  asks: 'reasoning.enabled',
});
const contented = chatCompletionsIn({
  ...shared,
  thought: 'reasoning_content',
  asks: 'reasoning.enabled',
});
const leveled = chatCompletionsIn({ ...shared, thought: 'reasoning' });
const tagged = chatCompletionsIn({ ...shared, tagged: true, efforts: [] });

// A model the reference does not name is asked as most of them are.
function spoken(model: string) {
  if (/deepseek-r1/i.test(model)) return tagged;
  if (model.startsWith('openai/')) return leveled;
  return /^(?:moonshotai|zai-org|minimaxai)\//i.test(model) ? contented : named;
}

export function together(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.together.ai/v1',
    prefix = 'together',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // A reply is read the same whichever model wrote it: reasoning in a
    // field under either name, or between think tags.
    codec: {
      ...tagged,
      encode: (model, ...rest) => spoken(model).encode(model, ...rest),
    },
    prefix,
    address,
    key,
    ...connection,
  });
}
