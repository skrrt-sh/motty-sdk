import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';

// Fireworks tells a suspended account as 412.
const failures: FailureReader = (status) =>
  status === 412 ? { code: 'upstream_refused' } : undefined;

const shared: Parameters<typeof chatCompletionsIn>[0] = {
  name: 'fireworks',
  thought: 'reasoning_content',
  topK: true,
  failures,
};

// An effort is a level or the order not to reason, and a model that takes
// neither is promoted to the nearest by Fireworks itself. Two families
// always reason, at three levels, and refuse the rest.
const free = chatCompletionsIn({
  ...shared,
  efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
});
const bound = chatCompletionsIn({
  ...shared,
  efforts: ['low', 'medium', 'high'],
});

// Reasoning comes in a field of its own, and for some models inside the
// text, yet it goes back in the field alone.
const read = chatCompletionsIn({ ...shared, tagged: true });

export function fireworks(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.fireworks.ai/inference/v1',
    prefix = 'fireworks',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    codec: {
      ...free,
      encode: (model, ...rest) =>
        (/gpt-oss|minimax-m2/i.test(model) ? bound : free).encode(
          model,
          ...rest,
        ),
      events: read.events,
    },
    prefix,
    address,
    key,
    ...connection,
  });
}
