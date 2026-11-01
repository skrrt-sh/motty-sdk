import type { ModelAdapter } from '@mottyjs/core/host';
import { messages } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';
import { anthropicTakes } from './takes.ts';

/** Connects to Anthropic's Messages API, sending the key in `x-api-key`. */
export function anthropic(
  options: {
    /** The API key. A missing or blank one throws when the adapter is made. */
    key: string | undefined;
    /**
     * The base address of the API. The default is
     * `https://api.anthropic.com/v1`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `anthropic/some-model`, taken off
     * before the call. The default is `anthropic`.
     */
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.anthropic.com/v1',
    prefix = 'anthropic',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    codec: messages,
    prefix,
    address,
    key,
    keyHeader: 'x-api-key',
    takes: anthropicTakes,
    ...connection,
  });
}
