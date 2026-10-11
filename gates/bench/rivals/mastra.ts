import { createOpenAI } from '@ai-sdk/openai';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { question, upstream } from './upstream.ts';

const model = createOpenAI({ apiKey: 'sk-stub', fetch: upstream }).chat(
  'gpt-4o-mini',
);
const City = z.object({ city: z.string(), words: z.array(z.string()) });

const plain = new Agent({
  id: 'plain',
  name: 'plain',
  instructions: '',
  model,
});
const filling = new Agent({
  id: 'filling',
  name: 'filling',
  instructions: '',
  model,
  tools: {
    weather: createTool({
      id: 'weather',
      description: 'The weather in a city',
      inputSchema: z.object({ city: z.string() }),
    }),
  },
});

async function served(request: Request) {
  const { messages }: { messages: { role: 'user'; content: string }[] } =
    JSON.parse(await request.text());
  const { textStream } = await plain.stream(messages);
  return new Response(textStream.pipeThrough(new TextEncoderStream()));
}

export const subjects = {
  text: async () => (await plain.generate(question)).text,
  stream: async () => {
    let text = '';
    const { textStream } = await plain.stream(question);
    for await (const chunk of textStream) text += chunk;
    return text;
  },
  object: async () => {
    const answer = await filling.stream(question, {
      structuredOutput: { schema: City },
    });
    let text = '';
    for await (const chunk of answer.textStream) text += chunk;
    return JSON.stringify(await answer.object) === text ? text : '';
  },
  serve: async () => {
    const response = await served(
      new Request('http://mastra/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: question }],
        }),
      }),
    );
    return response.text();
  },
};
