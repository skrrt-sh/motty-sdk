export function event(delta: object, finish: string | null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-4o-mini',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

const usage = { prompt_tokens: 9, completion_tokens: 20, total_tokens: 29 };

function reply(pieces: string[]) {
  const text = pieces.join('');
  const encoder = new TextEncoder();
  return {
    text,
    chunks: pieces.length,
    streamed: encoder.encode(
      [
        event({ role: 'assistant', content: '' }, null),
        ...pieces.map((content) => event({ content }, null)),
        event({}, 'stop'),
        'data: [DONE]\n\n',
      ].join(''),
    ),
    whole: encoder.encode(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text, refusal: null },
            logprobs: null,
            finish_reason: 'stop',
          },
        ],
        usage,
      }),
    ),
  };
}

export const replies = {
  short: reply(Array.from({ length: 20 }, () => 'token ')),
  long: reply(Array.from({ length: 200 }, () => 'token ')),
  object: reply([
    '{"city":"Paris","words":[',
    ...Array.from({ length: 17 }, () => '"token",'),
    '"token"',
    ']}',
  ]),
};

let canned = replies.short;

export function answering(name: keyof typeof replies) {
  canned = replies[name];
  return canned;
}

// Every SDK is given this in place of the network: the bytes are encoded
// once, and a call that asks for no stream is the only one sent a JSON body.
export const upstream = Object.assign(
  async (_address: string | URL | Request, sent?: RequestInit) => {
    if (typeof sent?.body !== 'string') {
      throw new Error('The upstream was sent a body that is not text');
    }
    return sent.body.includes('"stream":true')
      ? new Response(canned.streamed, {
          headers: { 'content-type': 'text/event-stream' },
        })
      : new Response(canned.whole, {
          headers: { 'content-type': 'application/json' },
        });
  },
  { preconnect: fetch.preconnect },
);

export const question = 'Why does this deadlock?';
