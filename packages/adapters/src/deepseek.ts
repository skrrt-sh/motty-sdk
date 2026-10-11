import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { deepseekCuts } from './cuts.ts';

// Named by status whatever the error calls itself: a spent balance, and a
// parameter this API refuses.
const failures: FailureReader = (status) => {
  if (status === 402) return { code: 'quota_exceeded' };
  if (status === 422) return { code: 'invalid_request' };
  return undefined;
};

export function deepseek(
  options: {
    key: string | undefined;
    address?: string;
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
      limit: 'max_tokens',
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
