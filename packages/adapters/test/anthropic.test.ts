import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { anthropic } from '../src/anthropic.ts';

const answered = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`;

test('it serves the names under its prefix and no other', () => {
  const adapter = anthropic({ key: 'sk-ant-host' });
  const proxied = anthropic({ key: 'sk-ant-host', prefix: 'bedrock' });

  expect(adapter.serves('anthropic/claude-opus')).toBe(true);
  expect(adapter.serves('anthropic')).toBe(false);
  expect(adapter.serves('anthropics/claude-opus')).toBe(false);
  expect(adapter.serves('openai/gpt-5')).toBe(false);
  expect(proxied.serves('bedrock/claude-opus')).toBe(true);
  expect(proxied.serves('anthropic/claude-opus')).toBe(false);
});

test('with no key it fails when made', () => {
  expect(() => anthropic({ key: undefined })).toThrow(
    'The anthropic adapter was given no key',
  );
  expect(() => anthropic({ key: '' })).toThrow();
  expect(() => anthropic({ key: ' \t' })).toThrow(
    'The anthropic adapter was given no key',
  );
});

test('a connection cut mid-stream ends in one retryable error', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        async function* () {
          yield answered.slice(
            0,
            answered.indexOf('event: content_block_stop'),
          );
          await Bun.sleep(20);
          await upstream.stop(true);
        },
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    anthropic({ key: 'sk-ant-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    {
      type: 'error',
      error: { code: 'upstream_failed', retryable: true, upstream: true },
    },
  ]);
});
