import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn, responsesIn } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';
import { openaiCuts } from './cuts.ts';
import { openaiChatTakes, openaiTakes } from './takes.ts';

/**
 * Connects to OpenAI, or with `address` to any server that speaks its API,
 * which is then sent the key. It speaks the Responses API unless `api` says
 * otherwise, and what it knows of OpenAI's models does not apply at another
 * address, so an option is sent as stated. It writes a cache marker on input
 * content only when `breakpoints` states how.
 */
export function openai(
  options: {
    /** The API key. A missing or blank one throws when the adapter is made. */
    key: string | undefined;
    /**
     * The base address of the API. The default is `https://api.openai.com/v1`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `openai/some-model`, taken off
     * before the call. The default is `openai`.
     */
    prefix?: string;
    /** The wire API to speak. The default is `responses`. */
    api?: 'responses' | 'chat-completions';
  } & Pick<Parameters<typeof responsesIn>[0], 'breakpoints'> &
    Connection,
): ModelAdapter {
  const {
    key,
    address,
    prefix = 'openai',
    api = 'responses',
    breakpoints,
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  // Past the types, any other word would mean Chat Completions unsaid.
  if (api !== 'responses' && api !== 'chat-completions') {
    throw new Error(
      `The ${prefix} adapter was given an api that is none: it takes 'responses' or 'chat-completions'`,
    );
  }
  // Most of OpenAI's own models refuse a cache marker, so one is written
  // only where the host says the upstream at this address takes it.
  const marks = breakpoints === undefined ? {} : { breakpoints };
  return chat({
    codec:
      api === 'responses'
        ? responsesIn({ ...marks, cuts: openaiCuts })
        : chatCompletionsIn({
            name: 'openai.chat',
            ...marks,
            cuts: openaiCuts,
          }),
    prefix,
    address: address ?? 'https://api.openai.com/v1',
    key,
    // Another address is another provider's models, which this rule does
    // not know.
    ...(address === undefined
      ? { takes: api === 'responses' ? openaiTakes : openaiChatTakes }
      : {}),
    ...connection,
  });
}
