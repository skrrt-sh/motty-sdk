import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import type { RunStream } from '@mottyjs/core/host';
import type { Codec } from '../../src/codec.ts';
import {
  formed,
  formedWhole,
  formlessIn,
  refusal,
} from '../../src/wire/formless.ts';

const { answer, note } = formlessIn('This API');

const formless: Codec['formless'] = (chunk) => {
  if (chunk.type === 'file') return answer('file', 'a file the model made');
  if (chunk.type === 'citation') return note('citation', 'a citation');
  if (chunk.type === 'reasoning' && chunk.provider !== undefined) {
    return note('reasoning', 'what its reasoning goes on with');
  }
  return undefined;
};

async function* run(): RunStream {
  yield { type: 'progress', piece: 0, text: 'Looking' };
  yield { type: 'text', text: 'It rains' };
  yield { type: 'citation', title: 'Almanac' };
  yield { type: 'text', text: ' often.' };
  yield { type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' };
  yield { type: 'text', text: 'never written' };
  yield { type: 'finish', reason: 'stop' };
}

test('one wording says which API has no form for what', () => {
  expect(answer('file', 'a file the model made')).toEqual({
    warning: {
      setting: 'file',
      detail: 'This API has no form for a file the model made',
    },
    ends: true,
  });
  expect(note('citation', 'a citation')?.ends).toBe(false);
});

test('a stream leaves an annotation out and ends as failed on content that is the answer', async () => {
  expect(await Array.fromAsync(formed(run(), formless))).toEqual([
    { type: 'progress', piece: 0, text: 'Looking' },
    { type: 'text', text: 'It rains' },
    { type: 'text', text: ' often.' },
    {
      type: 'error',
      error: {
        code: 'unsupported',
        status: 400,
        message: 'This API has no form for a file the model made',
        retryable: false,
      },
    },
  ]);
});

test('a stream with a form for everything passes as it is', async () => {
  const events = [
    { type: 'text', text: 'Hi' },
    { type: 'finish', reason: 'stop' },
  ] as const;
  async function* plain(): RunStream {
    yield* events;
  }
  expect(await Array.fromAsync(formed(plain(), formless))).toEqual([...events]);
});

test('a collected reply leaves an annotation out', () => {
  expect(
    formedWhole(
      [
        { type: 'text', text: 'It rains' },
        { type: 'citation', title: 'Almanac' },
      ],
      formless,
    ),
  ).toEqual([{ type: 'text', text: 'It rains' }]);
});

test('reasoning text outlives the data beside it that has no form, streamed and collected', async () => {
  async function* thought(): RunStream {
    yield { type: 'reasoning', text: 'Hm', block: 0, provider: { a: 'sig' } };
    yield { type: 'reasoning', text: '', block: 0, provider: { a: 'sig' } };
    yield { type: 'finish', reason: 'stop' };
  }
  expect(await Array.fromAsync(formed(thought(), formless))).toEqual([
    { type: 'reasoning', text: 'Hm', block: 0 },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(
    formedWhole(
      [
        { type: 'reasoning', text: 'Hm', block: 0, provider: { a: 'sig' } },
        { type: 'reasoning', text: '', block: 0, provider: { a: 'sig' } },
      ],
      formless,
    ),
  ).toEqual([{ type: 'reasoning', text: 'Hm', block: 0 }]);
});

test('a collected reply fails on content that is the answer', () => {
  const collected = () =>
    formedWhole(
      [{ type: 'file', data: 'iVBORw0KGgo=', mediaType: 'image/png' }],
      formless,
    );
  expect(collected).toThrow(Unsupported);
  expect(collected).toThrow('This API has no form for a file the model made');
});

test('a warning with no detail is refused by its setting', () => {
  expect(refusal({ setting: 'file' }).message).toBe('file');
});
