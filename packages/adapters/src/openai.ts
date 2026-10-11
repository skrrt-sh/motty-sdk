import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn, responsesIn } from '@mottyjs/serve';
import { type Connection, chat } from './chat.ts';
import { openaiCuts } from './cuts.ts';
import { openaiTakes } from './takes.ts';

export function openai(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
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
    ...(address === undefined ? { takes: openaiTakes } : {}),
    ...connection,
  });
}
