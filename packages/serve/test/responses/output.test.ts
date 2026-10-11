import { expect, test } from 'bun:test';
import {
  contentPart,
  ended,
  messageItem,
  thoughtItem,
} from '../../src/responses/output.ts';

test('a reasoning item holds each summary as its own part', () => {
  expect(
    thoughtItem({
      kind: 'reasoning',
      index: 0,
      id: 'rs_1',
      block: undefined,
      progress: false,
      piece: undefined,
      summary: ['First.', 'Second.'],
      content: [],
      part: 'summary',
      item: { encrypted_content: 'gAAAAABo', id: 'other', summary: [] },
    }),
  ).toEqual({
    id: 'rs_1',
    type: 'reasoning',
    encrypted_content: 'gAAAAABo',
    summary: [
      { type: 'summary_text', text: 'First.' },
      { type: 'summary_text', text: 'Second.' },
    ],
  });
});

test('a reasoning item keeps the content it came with, as it came', () => {
  const item = {
    id: 'rs_tmp_z582ajgark',
    type: 'reasoning',
    status: 'completed',
    content: [{ type: 'reasoning_text', text: 'Paris sits further north.' }],
    summary: [],
    signature:
      'CAQSpwUKEAgSGAI4AUIIdGhpbmtpbmcSDEesZn+NpEQfyIqQgRoMR9s1G5EATm7C7uzIIj',
    format: 'anthropic-claude-v1',
  };
  const written = thoughtItem({
    kind: 'reasoning',
    index: 0,
    id: 'rs_tmp_z582ajgark',
    block: 0,
    progress: false,
    piece: undefined,
    summary: [],
    content: ['Paris sits', ' further north.'],
    part: 'content',
    item,
  });
  expect(JSON.stringify(written)).toBe(JSON.stringify(item));
});

test('a reasoning item that came with no content holds what was written, a summary and the reasoning apart', () => {
  expect(
    thoughtItem({
      kind: 'reasoning',
      index: 0,
      id: 'rs_1',
      block: 0,
      progress: false,
      piece: undefined,
      summary: ['Comparing latitudes.'],
      content: ['Paris is at 48.86N, Lyon at 45.76N.'],
      part: 'content',
      item: {},
    }),
  ).toEqual({
    id: 'rs_1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Comparing latitudes.' }],
    content: [
      { type: 'reasoning_text', text: 'Paris is at 48.86N, Lyon at 45.76N.' },
    ],
  });
});

test('text and a refusal are each written as their own kind of part', () => {
  expect(
    contentPart({ refusal: false, text: 'Hi', annotations: [{ a: 1 }] }),
  ).toEqual({
    type: 'output_text',
    text: 'Hi',
    annotations: [{ a: 1 }],
    logprobs: [],
  });
  expect(contentPart({ refusal: true, text: 'No.', annotations: [] })).toEqual({
    type: 'refusal',
    refusal: 'No.',
  });
});

test('a message item holds its parts, its state and its phase', () => {
  expect(
    messageItem(
      {
        kind: 'message',
        index: 1,
        id: 'msg_1',
        block: 0,
        content: [{ refusal: false, text: 'Hi', annotations: [] }],
        item: { phase: 'final_answer' },
      },
      'completed',
    ),
  ).toEqual({
    phase: 'final_answer',
    id: 'msg_1',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'Hi', annotations: [], logprobs: [] },
    ],
  });
});

test('the last summary of a reasoning item is ended with its whole text', () => {
  expect(
    ended({
      kind: 'reasoning',
      index: 2,
      id: 'rs_1',
      block: undefined,
      progress: true,
      piece: 1,
      summary: ['First.', 'Second.'],
      content: [],
      part: 'summary',
      item: {},
    }),
  ).toEqual([
    {
      type: 'response.reasoning_summary_text.done',
      item_id: 'rs_1',
      output_index: 2,
      summary_index: 1,
      text: 'Second.',
    },
    {
      type: 'response.reasoning_summary_part.done',
      item_id: 'rs_1',
      output_index: 2,
      summary_index: 1,
      part: { type: 'summary_text', text: 'Second.' },
    },
  ]);
});

test('reasoning content is ended as a content part, and an item with no part open ends none', () => {
  expect(
    ended({
      kind: 'reasoning',
      index: 0,
      id: 'rs_1',
      block: 0,
      progress: false,
      piece: undefined,
      summary: ['Comparing latitudes.'],
      content: ['Paris is further north.'],
      part: 'content',
      item: {},
    }),
  ).toEqual([
    {
      type: 'response.reasoning_text.done',
      item_id: 'rs_1',
      output_index: 0,
      content_index: 0,
      text: 'Paris is further north.',
    },
    {
      type: 'response.content_part.done',
      item_id: 'rs_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'reasoning_text', text: 'Paris is further north.' },
    },
  ]);
  expect(
    ended({
      kind: 'reasoning',
      index: 0,
      id: 'rs_1',
      block: 0,
      progress: false,
      piece: undefined,
      summary: [],
      content: [],
      part: undefined,
      item: {},
    }),
  ).toEqual([]);
});

test('the last part of a message is ended as text or as a refusal', () => {
  expect(
    ended({
      kind: 'message',
      index: 0,
      id: 'msg_1',
      block: undefined,
      content: [{ refusal: true, text: 'No.', annotations: [] }],
      item: {},
    }).map(({ type }) => type),
  ).toEqual(['response.refusal.done', 'response.content_part.done']);
  expect(
    ended({
      kind: 'message',
      index: 0,
      id: 'msg_1',
      block: undefined,
      content: [{ refusal: false, text: 'Hi', annotations: [] }],
      item: {},
    })[0],
  ).toEqual({
    type: 'response.output_text.done',
    item_id: 'msg_1',
    output_index: 0,
    content_index: 0,
    text: 'Hi',
    logprobs: [],
  });
});

test('an item given no text has no part to end', () => {
  expect(
    ended({
      kind: 'message',
      index: 0,
      id: 'msg_1',
      block: undefined,
      content: [],
      item: {},
    }),
  ).toEqual([]);
});
