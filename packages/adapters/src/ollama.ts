import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';

export function ollama(
  options: {
    key?: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection = {},
): ModelAdapter {
  const {
    key,
    address = 'http://localhost:11434/v1',
    prefix = 'ollama',
    ...connection
  } = options;
  return chat({
    // An effort goes under OpenAI's name, the order not to reason among its
    // levels.
    codec: chatCompletionsIn({
      name: 'ollama',
      thought: 'reasoning',
      limit: 'max_tokens',
    }),
    prefix,
    address,
    // A server on the host's own machine asks for no key.
    key,
    ...connection,
  });
}
