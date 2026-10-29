import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';

// Real calls that cost money: the file is not a `.test.ts`, so only
// `bun run test:live` runs it, and without a key nothing in it runs.
const { OPENROUTER_KEY: key } = Bun.env;

// The picture is 64 by 64, its left half red and its right half blue. The
// document is one page that says "The secret word is MANGO."
describe.skipIf(key === undefined || key === '')(
  'pictures and documents against OpenRouter',
  () => {
    test('a picture a Chat Completions caller sends inline is seen by the model', async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/google/gemini-2.5-flash-lite').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
          report: (report) => reports.push(report),
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 40,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Which two colours are in this picture? Two words.',
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nO3aSwoAMAxCQe9/aXMKF4GBrgOlnxh9aTJd4/Jdl7cBJ+AKecR+Id+oRqYTkxLEHDVKThtoTGRGSkM9V4KtwtjizLEWmbvcafa6gENCI2IS8kkpxayCbkk91ADsgVaB2wCeEFuQM9AfahF2CXxF7kKPwd/5T68fuOzw4mlC0SMAAAAASUVORK5CYII=',
                    },
                  },
                ],
              },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        choices: [
          {
            message: {
              content: expect.stringMatching(/red\W+(and\s+)?blue/i),
            },
          },
        ],
      });
      expect(reports).toMatchObject([{ outcome: 'completed' }]);
      expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
    });

    test("an Anthropic Messages caller's picture is seen through the Responses API", async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/google/gemini-2.5-flash-lite').complete(prompt),
        ),
        () => ({
          models: [
            openai({
              key,
              address: 'https://openrouter.ai/api/v1',
              prefix: 'openrouter',
            }),
          ],
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 40,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Which two colours are in this picture? Two words.',
                  },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nO3aSwoAMAxCQe9/aXMKF4GBrgOlnxh9aTJd4/Jdl7cBJ+AKecR+Id+oRqYTkxLEHDVKThtoTGRGSkM9V4KtwtjizLEWmbvcafa6gENCI2IS8kkpxayCbkk91ADsgVaB2wCeEFuQM9AfahF2CXxF7kKPwd/5T68fuOzw4mlC0SMAAAAASUVORK5CYII=',
                    },
                  },
                ],
              },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        content: [
          {
            type: 'text',
            text: expect.stringMatching(/red\W+(and\s+)?blue/i),
          },
        ],
      });
    });

    test("a Responses caller's PDF is read through Anthropic Messages", async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/google/gemini-2.5-flash-lite').complete(prompt),
        ),
        () => ({
          models: [
            anthropic({
              key,
              address: 'https://openrouter.ai/api/v1',
              prefix: 'openrouter',
            }),
          ],
          report: (report) => reports.push(report),
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            max_output_tokens: 40,
            input: [
              {
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: 'What is the secret word in this document? One word.',
                  },
                  {
                    type: 'input_file',
                    filename: 'secret.pdf',
                    file_data:
                      'data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NiA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoVGhlIHNlY3JldCB3b3JkIGlzIE1BTkdPLikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNDcgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MTcKJSVFT0YK',
                  },
                ],
              },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        output: [
          {
            type: 'message',
            content: [{ text: expect.stringMatching(/mango/i) }],
          },
        ],
      });
      // The page is counted, which a document left out would not be.
      expect(reports[0]?.calls[0]?.input).toBeGreaterThan(200);
      expect(reports).toMatchObject([{ outcome: 'completed' }]);
    });

    test("a PDF an Anthropic Messages caller gives by address is read over OpenRouter's Chat Completions", async () => {
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/google/gemini-2.5-flash-lite').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 40,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Quote the text of this document. Few words.',
                  },
                  {
                    type: 'document',
                    source: {
                      type: 'url',
                      url: 'https://raw.githubusercontent.com/py-pdf/sample-files/main/001-trivial/minimal-document.pdf',
                    },
                  },
                ],
              },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        content: [
          { type: 'text', text: expect.stringMatching(/lorem ipsum/i) },
        ],
      });
    });

    test("a picture in a tool's result is seen over OpenRouter's Chat Completions", async () => {
      const reports: Report[] = [];
      const served = mount(
        motty({ name: 'relay' }).handle(({ prompt }) =>
          model('openrouter/anthropic/claude-haiku-5.5').complete(prompt),
        ),
        () => ({
          models: [openrouter({ key })],
          report: (report) => reports.push(report),
        }),
      );

      const reply = await served.fetch(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'relay',
            max_tokens: 200,
            tools: [
              {
                name: 'get_picture',
                description: 'Returns a picture',
                input_schema: { type: 'object', properties: {} },
              },
            ],
            messages: [
              {
                role: 'user',
                content:
                  'Call get_picture, then say which two colours are in the picture it returns. Two words.',
              },
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'call_1',
                    name: 'get_picture',
                    input: {},
                  },
                ],
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'call_1',
                    content: [
                      { type: 'text', text: 'The picture:' },
                      {
                        type: 'image',
                        source: {
                          type: 'base64',
                          media_type: 'image/png',
                          data: 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nO3aSwoAMAxCQe9/aXMKF4GBrgOlnxh9aTJd4/Jdl7cBJ+AKecR+Id+oRqYTkxLEHDVKThtoTGRGSkM9V4KtwtjizLEWmbvcafa6gENCI2IS8kkpxayCbkk91ADsgVaB2wCeEFuQM9AfahF2CXxF7kKPwd/5T68fuOzw4mlC0SMAAAAASUVORK5CYII=',
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        }),
      );
      const answer = await reply.json();
      await served.close();

      expect(reply.status).toBe(200);
      expect(answer).toMatchObject({
        content: [
          {
            type: 'text',
            text: expect.stringMatching(/red\W+(and\s+)?blue/i),
          },
        ],
      });
      expect(reports).toMatchObject([{ outcome: 'completed' }]);
    });
  },
);
