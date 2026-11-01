import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';
import { localFields } from './fields.ts';

export { localFields };

type Dialect = Parameters<typeof chatCompletionsIn>[0];

/**
 * Connects to a server the host runs itself, over Chat Completions. How it
 * speaks depends on how it was started, so the host says it in the words of
 * the dialect, and reasoning comes in `thought`'s field or between `tagged`
 * think tags, never both.
 */
export function local(
  options: {
    /** The base address of the server, which this adapter requires. */
    address: string;
    /** An API key, for a server that asks for one. */
    key?: string | undefined;
    /**
     * The first word of a model name, as in `local/some-model`, taken off
     * before the call. The default is `local`.
     */
    prefix?: string;
    /**
     * The one switch for reasoning a server takes, which is its template's
     * argument.
     */
    asks?: Extract<Dialect['asks'], 'chat_template_kwargs'>;
    /**
     * Which of the options that only help the server takes, with `true` or the
     * name it goes by there, as `{ ...localFields, maxTokens: 'max_tokens' }`.
     * The list replaces the default, `localFields`, and one not on it is left
     * out and told. A list with no `streamOptions` asks for no usage, so a server
     * that sends none unasked leaves its calls uncounted.
     */
    fields?: Dialect['fields'];
  } & Pick<Dialect, 'efforts' | 'topK'> &
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
    forwardHeaders,
    fields = localFields,
    ...dialect
  } = options;
  return chat({
    codec: chatCompletionsIn({ name: 'local', fields, ...dialect }),
    prefix,
    address,
    key,
    ...(headers === undefined ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
    ...(takes === undefined ? {} : { takes }),
    ...(forwardHeaders === undefined ? {} : { forwardHeaders }),
  });
}
