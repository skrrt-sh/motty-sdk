import { openai } from '../../../packages/adapters/src/openai.ts';
import { model, motty } from '../../../packages/core/src/index.ts';
import { mount } from '../../../packages/serve/src/index.ts';

const gpt = model('openai/gpt-4o-mini');

const { fetch: served } = mount(
  motty({ name: 'plain' }).handle(({ prompt }) => gpt.complete(prompt)),
  () => ({ models: [openai({ key: 'sk-stub', api: 'chat-completions' })] }),
);

// A request of its own for every call, as a caller sends one, and the
// reply read to its end.
function asked(path: string, body: object) {
  const sent = JSON.stringify({ model: 'plain', ...body });
  return async () => {
    const response = await served(
      new Request(`http://motty${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: sent,
      }),
    );
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} answered ${text}`);
    return text;
  };
}

const messages = [{ role: 'user', content: 'Why does this deadlock?' }];

export const subjects: Record<string, () => Promise<string>> = {
  'Messages, streamed': asked('/v1/messages', {
    max_tokens: 1024,
    messages,
    stream: true,
  }),
  'Chat Completions, streamed': asked('/v1/chat/completions', {
    messages,
    stream: true,
  }),
  'Responses, streamed': asked('/v1/responses', {
    input: 'Why does this deadlock?',
    stream: true,
  }),
  'Chat Completions, whole': asked('/v1/chat/completions', { messages }),
};
