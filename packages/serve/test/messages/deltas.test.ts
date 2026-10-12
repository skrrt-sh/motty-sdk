import { expect, test } from 'bun:test';
import { grown } from '../../src/messages/deltas.ts';

test('a delta of a kind read here grows the field it names', () => {
  expect(
    grown({ type: 'text', text: 'Hel' }, { type: 'text_delta', text: 'lo' }),
  ).toEqual({ type: 'text', text: 'Hello' });
  expect(
    grown(
      { type: 'thinking', thinking: 'Hm' },
      { type: 'thinking_delta', thinking: 'm.' },
    ),
  ).toEqual({ type: 'thinking', thinking: 'Hmm.' });
  expect(
    grown(
      { type: 'thinking', thinking: 'Hmm.', signature: '' },
      { type: 'signature_delta', signature: 'EqQB' },
    ),
  ).toEqual({ type: 'thinking', thinking: 'Hmm.', signature: 'EqQB' });
});

test('a cited source is added after the ones the block holds', () => {
  expect(
    grown(
      { type: 'text', text: 'Hello' },
      { type: 'citations_delta', citation: { cited_text: 'Hel' } },
    ),
  ).toEqual({
    type: 'text',
    text: 'Hello',
    citations: [{ cited_text: 'Hel' }],
  });
  expect(
    grown(
      { type: 'text', text: 'Hello', citations: [{ cited_text: 'Hel' }] },
      { type: 'citations_delta', citation: { cited_text: 'lo' } },
    ),
  ).toEqual({
    type: 'text',
    text: 'Hello',
    citations: [{ cited_text: 'Hel' }, { cited_text: 'lo' }],
  });
});

test('a delta of a kind not read here sets its fields on the block, and never its kind or its input text', () => {
  expect(
    grown(
      { type: 'compaction', content: null },
      { type: 'compaction_delta', content: 'Summary', partial_json: '{"a"' },
    ),
  ).toEqual({ type: 'compaction', content: 'Summary' });
});
