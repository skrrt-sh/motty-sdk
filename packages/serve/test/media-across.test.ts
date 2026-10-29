import { expect, test } from 'bun:test';
import { model, motty, Unsupported } from '@mottyjs/core';
import type { Chunk, Json, Report } from '@mottyjs/core/host';
import { chatCompletions, messages, mount, responses } from '../src/index.ts';

const codecs = { chat: chatCompletions, responses, messages };

type Api = keyof typeof codecs;

function body(api: Api, content: Json) {
  if (api === 'responses') {
    return { model: 'coder', input: [{ role: 'user', content }] };
  }
  const said = [{ role: 'user', content }];
  return api === 'messages'
    ? { model: 'coder', max_tokens: 64, messages: said }
    : { model: 'coder', messages: said };
}

// What a caller of one API sent, as an upstream of another is sent it.
function crossed(from: Api, content: Json, to: Api) {
  const { request } = codecs[from].decode(body(from, content), new Headers());
  return codecs[to].encode('model-x', { messages: request.messages });
}

test.each<[string, Api, Json, Api, Json]>([
  [
    'image bytes from Chat Completions to Anthropic Messages',
    'chat',
    [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0=', detail: 'high' },
      },
    ],
    'messages',
    [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0=',
            },
          },
        ],
      },
    ],
  ],
  [
    'an uploaded image from the Responses API to Anthropic Messages',
    'responses',
    [{ type: 'input_image', file_id: 'file_011C' }],
    'messages',
    [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'file', file_id: 'file_011C' } },
        ],
      },
    ],
  ],
  [
    'a PDF with its title from Anthropic Messages to Chat Completions',
    'messages',
    [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0=',
        },
        title: 'a.pdf',
      },
    ],
    'chat',
    [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              file_data: 'data:application/pdf;base64,JVBERi0=',
              filename: 'a.pdf',
            },
          },
        ],
      },
    ],
  ],
  [
    'a file by address from the Responses API to Anthropic Messages',
    'responses',
    [{ type: 'input_file', file_url: 'https://x.test/a.pdf', filename: 'A' }],
    'messages',
    [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'url', url: 'https://x.test/a.pdf' },
            title: 'A',
          },
        ],
      },
    ],
  ],
  [
    'a document of plain text from Anthropic Messages to the Responses API',
    'messages',
    [
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'hi' },
        title: 'note.txt',
      },
    ],
    'responses',
    [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            filename: 'note.txt',
            file_data: 'data:text/plain;base64,aGk=',
          },
        ],
      },
    ],
  ],
  [
    'a text file from the Responses API to Anthropic Messages',
    'responses',
    [{ type: 'input_file', file_data: 'data:text/plain;base64,aGk=' }],
    'messages',
    [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'hi' },
          },
        ],
      },
    ],
  ],
  [
    'a PDF address in `file_data` from Chat Completions to Anthropic Messages',
    'chat',
    [
      {
        type: 'file',
        file: {
          filename: 'dummy.pdf',
          file_data:
            'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
        },
      },
    ],
    'messages',
    [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'url',
              url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf',
            },
            title: 'dummy.pdf',
          },
        ],
      },
    ],
  ],
  [
    'an image`s detail from Chat Completions to the Responses API',
    'chat',
    [
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw0=', detail: 'low' },
      },
    ],
    'responses',
    [
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,iVBORw0=',
            detail: 'low',
          },
        ],
      },
    ],
  ],
  [
    'a PDF with no title from Anthropic Messages to Chat Completions, under a name OpenAI asks for',
    'messages',
    [
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0=',
        },
      },
    ],
    'chat',
    [
      {
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              file_data: 'data:application/pdf;base64,JVBERi0=',
              filename: 'file.pdf',
            },
          },
        ],
      },
    ],
  ],
])(
  '%s is written in the form of the API it goes to',
  (_, from, content, to, sent) => {
    const { body: written, leftOut } = crossed(from, content, to);
    expect(written).toMatchObject(
      to === 'responses' ? { input: sent } : { messages: sent },
    );
    expect(leftOut).toEqual([]);
  },
);

test.each<[string, Api, Json, Api, string]>([
  [
    'a file by address from the Responses API to Chat Completions',
    'responses',
    [{ type: 'input_file', file_url: 'https://x.test/a.pdf' }],
    'chat',
    'Chat Completions cannot carry a file given by address',
  ],
  [
    'an uploaded image from Anthropic Messages to Chat Completions',
    'messages',
    [{ type: 'image', source: { type: 'file', file_id: 'file_011C' } }],
    'chat',
    'Chat Completions cannot carry an image given by id',
  ],
  [
    'a document of plain text from Anthropic Messages to Chat Completions',
    'messages',
    [
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'hi' },
      },
    ],
    'chat',
    'Chat Completions takes no text/plain file',
  ],
  [
    'a spreadsheet from the Responses API to Anthropic Messages',
    'responses',
    [{ type: 'input_file', file_data: 'data:text/csv;base64,YSxiCg==' }],
    'messages',
    'Anthropic Messages takes no text/csv file',
  ],
  [
    'a document with its citations asked for, from Anthropic Messages to the Responses API',
    'messages',
    [
      {
        type: 'document',
        source: { type: 'file', file_id: 'file_011C' },
        citations: { enabled: true },
      },
    ],
    'responses',
    'The Responses API cannot carry a file part of anthropic',
  ],
  [
    'a picture in a tool result from Anthropic Messages to Chat Completions',
    'messages',
    [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://x.test/a.png' },
          },
        ],
      },
    ],
    'chat',
    'Chat Completions cannot carry an image part in a tool result',
  ],
])('%s has no form and fails the call', (_, from, content, to, message) => {
  expect(() => crossed(from, content, to)).toThrow(Unsupported);
  expect(() => crossed(from, content, to)).toThrow(message);
});

test('a picture in a tool result goes from Anthropic Messages to the Responses API', () => {
  expect(
    crossed(
      'messages',
      [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [
            { type: 'text', text: 'The chart:' },
            {
              type: 'image',
              source: { type: 'url', url: 'https://x.test/a.png' },
            },
          ],
        },
      ],
      'responses',
    ).body,
  ).toMatchObject({
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'The chart:' },
          { type: 'input_image', image_url: 'https://x.test/a.png' },
        ],
      },
    ],
  });
});

test('a Chat Completions caller`s cache_control crosses to Anthropic Messages', () => {
  const content = [
    {
      type: 'text',
      text: 'You are terse.',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    },
  ];
  expect(crossed('chat', content, 'messages')).toMatchObject({
    body: { messages: [{ role: 'user', content }] },
    leftOut: [],
  });
});

test('an image`s detail has no field in Anthropic Messages, and is a hint left out', () => {
  const sent = crossed(
    'responses',
    [{ type: 'input_image', image_url: 'https://x.test/a.png', detail: 'low' }],
    'messages',
  );
  expect(sent.body).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://x.test/a.png' },
          },
        ],
      },
    ],
  });
  expect(JSON.stringify(sent.body)).not.toContain('detail');
  expect(sent.leftOut).toEqual([]);
});

const gpt = model('openai/gpt');

const coder = motty({ name: 'coder' }).handle(({ prompt }) =>
  gpt.complete(prompt),
);

// What a caller of each API is answered when the model made the chunk.
async function answered(api: Api, stream: boolean, chunk: Chunk) {
  const reports: Report[] = [];
  const served = mount(coder, () => ({
    models: [
      {
        serves: () => true,
        call: async function* () {
          yield { type: 'text', text: 'Here it is.' };
          yield chunk;
          yield { type: 'finish', reason: 'stop' };
        },
      },
    ],
    report: (report) => reports.push(report),
  }));
  const path = {
    chat: 'chat/completions',
    responses: 'responses',
    messages: 'messages',
  };
  const reply = await served.fetch(
    new Request(`http://motty.test/v1/${path[api]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body(api, 'Draw the lock order'), stream }),
    }),
  );
  const text = await reply.text();
  await served.close();
  return { status: reply.status, text, error: reports[0]?.error?.code };
}

test.each([false, true])(
  'a picture a model made reaches a Chat Completions caller in its own field, streamed %p',
  async (stream) => {
    const { status, text, error } = await answered('chat', stream, {
      type: 'file',
      data: 'iVBORw0=',
      mediaType: 'image/png',
    });
    expect(status).toBe(200);
    expect(text).toContain(
      '"images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0="}}]',
    );
    expect(error).toBeUndefined();
  },
);

test.each([false, true])(
  'a picture a model made reaches a Responses caller as an image generation item, streamed %p',
  async (stream) => {
    const { status, text, error } = await answered('responses', stream, {
      type: 'file',
      data: 'iVBORw0=',
      mediaType: 'image/png',
    });
    expect(status).toBe(200);
    expect(text).toContain('"type":"image_generation_call"');
    expect(text).toContain('"result":"iVBORw0="');
    expect(error).toBeUndefined();
  },
);

test.each([false])(
  'a picture a Responses upstream made reaches a Chat Completions caller in `images`, streamed %p',
  async (stream) => {
    const made = await Array.fromAsync(
      responses.events(
        (async function* () {
          yield {
            data: '{"type":"response.output_item.done","output_index":1,"item":{"id":"ig_tmp_n8qr5jchufl","type":"image_generation_call","status":"completed","result":"data:image/png;base64,iVBORw0="},"sequence_number":11}',
          };
        })(),
      ),
    );
    const [chunk] = made;
    if (chunk?.type !== 'file') throw new Error('The item was read as no file');

    const { status, text, error } = await answered('chat', stream, chunk);
    expect(status).toBe(200);
    expect(text).toContain(
      '"images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0="}}]',
    );
    expect(error).toBeUndefined();

    const same = await answered('responses', stream, chunk);
    expect(same.text).toContain(
      '{"id":"ig_tmp_n8qr5jchufl","type":"image_generation_call","status":"completed","result":"data:image/png;base64,iVBORw0="}',
    );
    expect((await answered('messages', stream, chunk)).error).toBe(
      'unsupported',
    );
  },
);

test.each<[Api, boolean, Chunk]>([
  [
    'messages',
    false,
    { type: 'file', data: 'iVBORw0=', mediaType: 'image/png' },
  ],
  [
    'messages',
    true,
    { type: 'file', data: 'iVBORw0=', mediaType: 'image/png' },
  ],
  [
    'responses',
    false,
    { type: 'file', url: 'https://x.test/made.png', mediaType: 'image/png' },
  ],
  [
    'chat',
    false,
    { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
  ],
  ['chat', true, { type: 'file', id: 'file-1', mediaType: 'image/png' }],
  [
    'responses',
    true,
    { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
  ],
  [
    'responses',
    false,
    {
      type: 'provider',
      provider: { 'openai.chat': { audio: { id: 'audio_1' } } },
    },
  ],
  [
    'messages',
    true,
    {
      type: 'provider',
      provider: { 'openai.chat': { audio: { id: 'audio_1' } } },
    },
  ],
])(
  'what a %s caller`s API has no form for ends the reply as unsupported, streamed %p',
  async (api, stream, chunk) => {
    const { status, text, error } = await answered(api, stream, chunk);
    expect(error).toBe('unsupported');
    // A stream that has begun keeps its status and ends on the error.
    expect(status).toBe(stream ? 200 : 400);
    expect(text).toMatch(/unsupported|invalid_request_error/);
  },
);

test.each([false, true])(
  'sound a model made reaches a Chat Completions caller whole, streamed %p',
  async (stream) => {
    const { status, text, error } = await answered('chat', stream, {
      type: 'provider',
      provider: {
        'openai.chat': {
          audio: { id: 'audio_1', data: 'UklGRg==', transcript: 'Hi' },
        },
      },
    });
    expect(status).toBe(200);
    expect(text).toContain(
      '"audio":{"id":"audio_1","data":"UklGRg==","transcript":"Hi"}',
    );
    expect(error).toBeUndefined();
  },
);
