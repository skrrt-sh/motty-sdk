import { BytesOutputParser } from '@langchain/core/output_parsers';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { question, upstream } from './upstream.ts';

const model = new ChatOpenAI({
  model: 'gpt-4o-mini',
  apiKey: 'sk-stub',
  configuration: { fetch: upstream },
});
const City = z.object({ city: z.string(), words: z.array(z.string()) });
const filling = model.withStructuredOutput(City, { method: 'jsonSchema' });
const bytes = model.pipe(new BytesOutputParser());

async function served(request: Request) {
  const { messages }: { messages: { role: 'user'; content: string }[] } =
    JSON.parse(await request.text());
  return new Response(await bytes.stream(messages));
}

export const subjects = {
  text: async () => (await model.invoke(question)).text,
  stream: async () => {
    let text = '';
    for await (const chunk of await model.stream(question)) text += chunk.text;
    return text;
  },
  object: async () => {
    let last = {};
    for await (const partial of await filling.stream(question)) last = partial;
    return JSON.stringify(last);
  },
  serve: async () => {
    const response = await served(
      new Request('http://langchain/api/chat', {
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
