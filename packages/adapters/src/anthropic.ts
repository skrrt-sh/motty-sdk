import type { ModelAdapter } from '@mottyjs/core/host';
import { messages } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';
import { anthropicTakes } from './takes.ts';

export function anthropic(
  options: {
    key: string | undefined;
    address?: string;
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
