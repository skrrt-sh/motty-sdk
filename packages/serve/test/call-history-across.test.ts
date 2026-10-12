import { expect, test } from 'bun:test';
import { chatCompletions, messages, responses } from '../src/index.ts';

test.each([
  ['the Responses API', responses],
  ['Chat Completions', chatCompletions],
  ['Anthropic Messages', messages],
])(
  'a tool call an Anthropic upstream answered, echoed by its caller, goes on to %s',
  (_, codec) => {
    const { request } = messages.decode(
      {
        model: 'coder',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'get_weather',
                input: { location: 'Paris' },
                caller: { type: 'direct' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_01', content: '15C' },
            ],
          },
        ],
      },
      new Headers(),
    );
    const { body } = codec.encode('model-x', { messages: request.messages });
    expect(JSON.stringify(body)).toContain('get_weather');
    expect(JSON.stringify(body).includes('"caller"')).toBe(codec === messages);
  },
);
