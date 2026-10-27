import { expect, test } from 'bun:test';
import { thoughtItem } from '../../src/responses/output.ts';

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
