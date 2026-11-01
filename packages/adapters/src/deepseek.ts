import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { deepseekCuts } from './cuts.ts';
import { deepseekFields } from './fields.ts';

// Named by status whatever the error calls itself: a spent balance, and a
// parameter this API refuses.
const failures: FailureReader = (status) => {
  if (status === 402) return { code: 'quotaExceeded' };
  if (status === 422) return { code: 'invalidRequest' };
  return undefined;
};

/**
 * Connects to DeepSeek over Chat Completions. It asks for JSON with no schema,
 * since the API takes none.
 */
export function deepseek(
  options: {
    /** The API key. A missing or blank one throws when the adapter is made. */
    key: string | undefined;
    /**
     * The base address of the API. The default is `https://api.deepseek.com`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `deepseek/some-model`, taken off
     * before the call. The default is `deepseek`.
     */
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    // This API has no version segment.
    address = 'https://api.deepseek.com',
    prefix = 'deepseek',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // A tool loop is refused unless every assistant turn returns its
    // reasoning. Thinking is a switch, with three efforts and no budget, and
    // JSON comes by no schema. The one medium is a picture, from a user or
    // a tool, and an uploaded one is a file part.
    codec: chatCompletionsIn({
      name: 'deepseek',
      thought: 'reasoning_content',
      asks: 'thinking',
      efforts: ['low', 'high', 'max'],
      output: 'json_object',
      failures,
      cuts: deepseekCuts,
      fields: deepseekFields,
      files: 'pictures',
      sound: 'none',
      shown: true,
    }),
    prefix,
    address,
    key,
    ...connection,
  });
}
