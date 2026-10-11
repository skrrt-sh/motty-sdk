import { createOpenAI } from '@ai-sdk/openai';
import {
  convertToModelMessages,
  generateText,
  Output,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import { question, upstream } from './upstream.ts';

const model = createOpenAI({ apiKey: 'sk-stub', fetch: upstream }).chat(
  'gpt-4o-mini',
);
const City = z.object({ city: z.string(), words: z.array(z.string()) });

async function served(request: Request) {
  const { messages }: { messages: UIMessage[] } = JSON.parse(
    await request.text(),
  );
  return streamText({
    model,
    messages: await convertToModelMessages(messages),
  }).toTextStreamResponse();
}

export const subjects = {
  text: async () => (await generateText({ model, prompt: question })).text,
  stream: async () => {
    let text = '';
    const { textStream } = streamText({ model, prompt: question });
    for await (const chunk of textStream) text += chunk;
    return text;
  },
  object: async () => {
    const answer = streamText({
      model,
      prompt: question,
      tools: {
        weather: tool({
          description: 'The weather in a city',
          inputSchema: z.object({ city: z.string() }),
        }),
      },
      output: Output.object({ schema: City }),
    });
    let text = '';
    for await (const chunk of answer.textStream) text += chunk;
    return JSON.stringify(await answer.output) === text ? text : '';
  },
  serve: async () => {
    const response = await served(
      new Request('http://ai-sdk/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              id: '1',
              role: 'user',
              parts: [{ type: 'text', text: question }],
            },
          ],
        }),
      }),
    );
    return response.text();
  },
};
