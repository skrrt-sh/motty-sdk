import { expect, test } from 'bun:test';
import type { Chunk } from '@mottyjs/core/host';
import { messages, responses } from '../src/index.ts';
import { events } from '../src/messages/events.ts';
import { dict, list } from '../src/wire/json.ts';

async function* sse(...sent: { type: string; [field: string]: unknown }[]) {
  for (const event of sent) {
    yield { event: event.type, data: JSON.stringify(event) };
  }
}

async function thought(): Promise<Chunk[]> {
  const read: Chunk[] = [];
  for await (const event of events(
    sse(
      {
        type: 'message_start',
        message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 9 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'The user wants ' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'a listing.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'EmwKAhgB' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: 'Done.' },
      },
      { type: 'content_block_stop', index: 2 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 7 },
      },
      { type: 'message_stop' },
    ),
  )) {
    if (event.type !== 'finish' && event.type !== 'error') read.push(event);
  }
  return read;
}

const asked = {
  model: 'relay',
  input: 'List the files.',
  reasoning: { effort: 'medium', summary: 'auto' },
  include: ['reasoning.encrypted_content'],
  store: false,
};

test('what a Claude model goes on from its reasoning with reaches a Responses caller who includes it, and goes back to Claude signed', async () => {
  const decoded = responses.decode(asked, new Headers());
  const chunks = await thought();
  expect(chunks.flatMap((chunk) => decoded.formless(chunk) ?? [])).toEqual([]);

  const reply = decoded.collected(
    chunks,
    { type: 'finish', reason: 'stop' },
    'r1',
  );
  const { output: written } = dict(reply);
  const output = list(written);
  const items = output.filter((item) => {
    const { type } = dict(item);
    return type === 'reasoning';
  });
  expect(
    items.map((item) => {
      const { summary, encrypted_content: sealed } = dict(item);
      return { summary, sealed: typeof sealed };
    }),
  ).toEqual([
    {
      summary: [{ type: 'summary_text', text: 'The user wants a listing.' }],
      sealed: 'string',
    },
    { summary: [], sealed: 'string' },
  ]);

  const { request } = responses.decode(
    {
      ...asked,
      input: [
        { type: 'message', role: 'user', content: 'List the files.' },
        ...output,
        { type: 'message', role: 'user', content: 'Go on.' },
      ],
    },
    new Headers(),
  );
  const { body, leftOut } = messages.encode('claude-x', request);
  expect(body).toMatchObject({
    messages: [
      { role: 'user' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'The user wants a listing.',
            signature: 'EqQBCgIYAhIM',
          },
          { type: 'redacted_thinking', data: 'EmwKAhgB' },
          { type: 'text', text: 'Done.' },
        ],
      },
      { role: 'user' },
    ],
  });
  expect(leftOut).toEqual([]);

  const sent = responses.encode('gpt-x', request);
  expect(JSON.stringify(sent.body)).not.toContain('EqQBCgIYAhIM');
  expect(sent.leftOut.map(({ setting }) => setting)).toEqual(['reasoning']);
});

test('a Responses caller who does not include it is told it was left out', async () => {
  const { include: _, ...unasked } = asked;
  const decoded = responses.decode(unasked, new Headers());

  expect(
    (await thought()).flatMap((chunk) => decoded.formless(chunk) ?? []),
  ).toEqual([
    {
      warning: {
        setting: 'reasoning',
        detail:
          'The Responses API has no form for what a model goes on from its reasoning with, which the request did not include',
      },
      ends: false,
    },
    {
      warning: {
        setting: 'reasoning',
        detail:
          'The Responses API has no form for what a model goes on from its reasoning with, which the request did not include',
      },
      ends: false,
    },
  ]);
});
