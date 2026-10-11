import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Chunk, ModelAdapter, Report } from '@mottyjs/core/host';
import { mount } from '../src/index.ts';

const gpt = model('openai/gpt');

const coder = motty({ name: 'coder' }).handle(({ prompt }) =>
  gpt.complete(prompt),
);

function saying(chunks: readonly Chunk[], stopped?: () => void): ModelAdapter {
  return {
    serves: () => true,
    call: async function* (_model, _prompt, signal) {
      if (stopped !== undefined) signal.addEventListener('abort', stopped);
      for (const chunk of chunks) {
        yield chunk;
        await Bun.sleep(1);
      }
      yield { type: 'finish', reason: 'stop' };
    },
  };
}

function ask(port: number | undefined, stream: boolean): Promise<Response> {
  return fetch(`http://localhost:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      stream,
      messages: [{ role: 'user', content: 'Draw the lock order' }],
    }),
  });
}

const refused = {
  code: 'unsupported',
  message:
    'Chat Completions has no form for a file the model made that is not a picture',
};

test('a file in a stream that has begun ends it with the error, stops the call and is in the record', async () => {
  const reports: Report[] = [];
  let stopped = false;
  const served = mount(coder, () => ({
    models: [
      saying(
        [
          { type: 'text', text: 'Here it is: ' },
          { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
          { type: 'text', text: 'never sent' },
        ],
        () => {
          stopped = true;
        },
      ),
    ],
    report: (report) => reports.push(report),
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);
  const text = await reply.text();
  await served.close();

  expect(reply.status).toBe(200);
  expect(text).toContain('Here it is: ');
  expect(text).not.toContain('never sent');
  expect(text).not.toContain('[DONE]');
  expect(JSON.parse(text.trim().split('\n\n').at(-1)?.slice(6) ?? '')).toEqual({
    error: { ...refused, type: 'invalid_request_error', param: null },
  });
  expect(stopped).toBe(true);
  expect(reports).toMatchObject([
    {
      outcome: 'aborted',
      error: { ...refused, status: 400 },
      warnings: [{ setting: 'file', detail: refused.message }],
    },
  ]);
});

test('a file as the first content of a stream is answered with the status of the error', async () => {
  const served = mount(coder, () => ({
    models: [
      saying([
        { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
      ]),
    ],
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, true);

  expect(reply.status).toBe(400);
  expect(await reply.json()).toMatchObject({ error: refused });
  await served.close();
});

test('a file in a whole reply is the error and never an empty answer', async () => {
  const reports: Report[] = [];
  const served = mount(coder, () => ({
    models: [
      saying([
        { type: 'text', text: 'Here it is: ' },
        { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
      ]),
    ],
    report: (report) => reports.push(report),
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, false);

  expect(reply.status).toBe(400);
  expect(await reply.json()).toMatchObject({ error: refused });
  await served.close();
  expect(reports).toMatchObject([
    { outcome: 'aborted', error: { ...refused, status: 400 } },
  ]);
});

test('a citation with no form is left out of the reply and named once on the report', async () => {
  const reports: Report[] = [];
  const served = mount(coder, () => ({
    models: [
      saying([
        { type: 'text', text: 'It rains.' },
        { type: 'citation', title: 'Almanac' },
        { type: 'citation', title: 'Gazette' },
      ]),
    ],
    report: (report) => reports.push(report),
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  const reply = await ask(server.port, false);

  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({
    choices: [{ message: { content: 'It rains.' }, finish_reason: 'stop' }],
  });
  await served.close();
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.warnings).toEqual([
    {
      setting: 'citation',
      detail: 'Chat Completions has no form for a citation with no address',
    },
  ]);
});

test('a reply with a form for everything reports no warnings', async () => {
  const reports: Report[] = [];
  const served = mount(coder, () => ({
    models: [saying([{ type: 'text', text: 'It rains.' }])],
    report: (report) => reports.push(report),
  }));
  using server = Bun.serve({ port: 0, fetch: served.fetch });

  await (await ask(server.port, false)).json();
  await served.close();

  expect(reports).toHaveLength(1);
  expect(reports[0]).not.toHaveProperty('warnings');
});
