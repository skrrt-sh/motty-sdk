import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';

type Dialect = Parameters<typeof chatCompletionsIn>[0];

// How a server the host runs speaks depends on how it was started, so the
// host says it in the dialect's own words. Its one switch is its template's
// argument, and reasoning comes in a field or between tags, never both.
export function local(
  options: {
    address: string;
    key?: string | undefined;
    prefix?: string;
    asks?: Extract<Dialect['asks'], 'chat_template_kwargs'>;
  } & Pick<Dialect, 'efforts' | 'limit' | 'topK'> &
    (
      | (Pick<Dialect, 'thought'> & { tagged?: never })
      | (Pick<Dialect, 'tagged'> & { thought?: never })
    ) &
    Connection,
): ModelAdapter {
  const {
    address,
    key,
    prefix = 'local',
    headers,
    body,
    takes,
    ...dialect
  } = options;
  return chat({
    codec: chatCompletionsIn({ name: 'local', ...dialect }),
    prefix,
    address,
    key,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(takes === undefined ? {} : { takes }),
  });
}
