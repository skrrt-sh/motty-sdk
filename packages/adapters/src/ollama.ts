import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';
import { ollamaFields } from './fields.ts';

/**
 * Connects to an Ollama server on the host's own machine, which asks for no
 * key, so every option may be left out.
 */
export function ollama(
  options: {
    /** An API key, for a server that asks for one. */
    key?: string | undefined;
    /**
     * The base address of the server. The default is
     * `http://localhost:11434/v1`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `ollama/some-model`, taken off
     * before the call. The default is `ollama`.
     */
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
      fields: ollamaFields,
    }),
    prefix,
    address,
    // A server on the host's own machine asks for no key.
    key,
    ...connection,
  });
}
