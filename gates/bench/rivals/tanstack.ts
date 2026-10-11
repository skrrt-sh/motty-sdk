import {
  chat,
  chatParamsFromRequest,
  toolDefinition,
  toServerSentEventsResponse,
} from '@tanstack/ai';
import { openaiCompatibleText } from '@tanstack/ai-openai/compatible';
import { z } from 'zod';
import { question, upstream } from './upstream.ts';

const adapter = openaiCompatibleText('gpt-4o-mini', {
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'sk-stub',
  fetch: upstream,
});
const City = z.object({ city: z.string(), words: z.array(z.string()) });

async function served(request: Request) {
  const { messages } = await chatParamsFromRequest(request);
  return toServerSentEventsResponse(chat({ adapter, messages }));
}

export const subjects = {
  text: async () => {
    const { text } = await chat({
      adapter,
      messages: [{ role: 'user', content: question }],
      stream: false,
    });
    return text;
  },
  stream: async () => {
    let text = '';
    for await (const chunk of chat({
      adapter,
      messages: [{ role: 'user', content: question }],
    })) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta;
    }
    return text;
  },
  object: async () => {
    let text = '';
    let filled = '';
    for await (const chunk of chat({
      adapter,
      messages: [{ role: 'user', content: question }],
      tools: [
        toolDefinition({
          name: 'weather',
          description: 'The weather in a city',
          inputSchema: z.object({ city: z.string() }),
        }),
      ],
      outputSchema: City,
      stream: true,
    })) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta;
      if (
        chunk.type === 'CUSTOM' &&
        chunk.name === 'structured-output.complete'
      ) {
        filled = JSON.stringify(chunk.value.object);
      }
    }
    return filled === text ? text : '';
  },
  serve: async () => {
    const response = await served(
      new Request('http://tanstack/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: 'thread-1',
          runId: 'run-1',
          messages: [{ id: '1', role: 'user', content: question }],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        }),
      }),
    );
    return response.text();
  },
};
