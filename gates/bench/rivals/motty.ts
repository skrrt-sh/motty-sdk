import { z } from 'zod';
import { openai } from '../../../packages/adapters/src/openai.ts';
import { hosting, mark } from '../../../packages/core/src/host.ts';
import { model, motty } from '../../../packages/core/src/index.ts';
import { mount } from '../../../packages/serve/src/index.ts';
import { question } from './upstream.ts';

const gpt = model('openai/gpt-4o-mini');
const City = z.object({ city: z.string(), words: z.array(z.string()) });

const plain = motty({ name: 'plain' }).handle(({ prompt }) =>
  gpt.complete(prompt),
);
const filling = motty({ name: 'filling' }).handle(async ({ prompt }) => {
  const reply = await gpt.complete({
    messages: prompt.messages,
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'The weather in a city',
        input: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
    output: City,
  });
  await reply.json();
  return reply;
});

function models() {
  return { models: [openai({ key: 'sk-stub', api: 'chat-completions' })] };
}

// A request of its own for every call, as a host makes, read to its end.
function asked(served: typeof plain) {
  const admit = hosting(served, models());
  return async () => {
    const { request, host } = await admit({
      request: {
        model: 'plain',
        messages: [{ role: 'user', text: question }],
        tools: [],
        options: {},
      },
      headers: new Headers(),
      credentials: [],
    });
    let text = '';
    for await (const event of served[mark].run(request, host)) {
      if (event.type === 'text') text += event.text;
    }
    return text;
  };
}

const { fetch: served } = mount(plain, models);

const read = asked(plain);

export const subjects = {
  text: read,
  stream: read,
  object: asked(filling),
  serve: async () => {
    const response = await served(
      new Request('http://motty/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'plain',
          messages: [{ role: 'user', content: question }],
          stream: true,
        }),
      }),
    );
    return response.text();
  },
};
