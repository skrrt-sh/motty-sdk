import { expect, test } from 'bun:test';
import { inputOf, whole } from '../../src/messages/deltas.ts';
import { dict, parsed } from '../../src/wire/json.ts';

test('a delta of a kind read here grows the field it names', () => {
  expect(
    whole({
      block: { type: 'text', text: 'Hel' },
      deltas: [{ type: 'text_delta', text: 'lo' }],
    }),
  ).toEqual({ type: 'text', text: 'Hello' });
  expect(
    whole({
      block: { type: 'thinking', thinking: 'Hm', signature: '' },
      deltas: [
        { type: 'thinking_delta', thinking: 'm.' },
        { type: 'signature_delta', signature: 'EqQB' },
      ],
    }),
  ).toEqual({ type: 'thinking', thinking: 'Hmm.', signature: 'EqQB' });
});

test('a cited source is added after the ones the block holds', () => {
  expect(
    whole({
      block: { type: 'text', text: 'Hello' },
      deltas: [
        { type: 'citations_delta', citation: { cited_text: 'Hel' } },
        { type: 'citations_delta', citation: { cited_text: 'lo' } },
      ],
    }),
  ).toEqual({
    type: 'text',
    text: 'Hello',
    citations: [{ cited_text: 'Hel' }, { cited_text: 'lo' }],
  });
  expect(
    whole({
      block: { type: 'text', text: 'Hello', citations: [{ cited_text: 'H' }] },
      deltas: [{ type: 'citations_delta', citation: { cited_text: 'lo' } }],
    }),
  ).toHaveProperty('citations', [{ cited_text: 'H' }, { cited_text: 'lo' }]);
});

test('a delta of a kind not read here sets its fields on the block, and never its kind', () => {
  expect(
    whole({
      block: { type: 'compaction', content: null },
      deltas: [
        { type: 'compaction_delta', content: 'Summary' },
        { type: 'compaction_delta', encrypted_content: 'EuYBCkQYAiJA' },
      ],
    }),
  ).toEqual({
    type: 'compaction',
    content: 'Summary',
    encrypted_content: 'EuYBCkQYAiJA',
  });
});

test('the pieces of input are read together as the object they spell', () => {
  expect(
    whole({
      block: { type: 'mcp_tool_use', id: 'mcptoolu_01', input: {} },
      deltas: [
        { type: 'input_json_delta', partial_json: '{"q":' },
        { type: 'input_json_delta', partial_json: ' "rain"}' },
      ],
    }),
  ).toEqual({ type: 'mcp_tool_use', id: 'mcptoolu_01', input: { q: 'rain' } });
});

test('a block with no delta, or none that says input, keeps the input it started with', () => {
  const block = { type: 'tool_use', id: 'toolu_01', input: { a: 1 } };
  expect(whole({ block, deltas: [] })).toBe(block);
  expect(
    whole({ block, deltas: [{ type: 'input_json_delta', partial_json: '' }] }),
  ).toEqual(block);
});

test.each(['{"q":', '[1]'])(
  'input said as %s is no object, and is kept as the text it was',
  (json) => {
    expect(inputOf(json)).toBeUndefined();
    expect(
      whole({
        block: { type: 'mcp_tool_use', id: 'mcptoolu_01', input: {} },
        deltas: [{ type: 'input_json_delta', partial_json: json }],
      }),
    ).toEqual({
      type: 'mcp_tool_use',
      id: 'mcptoolu_01',
      input: { INVALID_JSON: json },
    });
  },
);

test('a field named as the prototype is a field like any other', () => {
  const told = whole({
    block: { type: 'future_block' },
    deltas: [dict(parsed('{"type":"future_delta","__proto__":{"a":1}}'))],
  });
  expect(Object.keys(told)).toEqual(['type', '__proto__']);
  expect(Object.getPrototypeOf(told)).toBe(Object.prototype);
});
