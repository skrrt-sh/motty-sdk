import type { AnyMotty } from '../../packages/core/src/chain/builder.ts';
import { motty } from '../../packages/core/src/chain/motty.ts';
import { reroute } from '../../packages/core/src/chain/route.ts';
import type { Chunk, StreamEvent } from '../../packages/core/src/data/event.ts';
import type { ChatRequest } from '../../packages/core/src/data/message.ts';
import { answer } from '../../packages/core/src/request/answer.ts';
import { model } from '../../packages/core/src/request/model.ts';
import { retry } from '../../packages/core/src/request/retry.ts';
import { fallback, race } from '../../packages/core/src/request/switching.ts';
import { think } from '../../packages/core/src/request/think.ts';
import { timeout } from '../../packages/core/src/request/timeout.ts';

const jev = model('jev');
const mini = model('mini');
const haiku = model('haiku');
const sonnet = model('sonnet');
const gpt = model('gpt');
const opus = model('opus');

async function* withoutReasoning(chunks: AsyncIterable<Chunk>) {
  for await (const chunk of chunks) {
    if (chunk.type !== 'reasoning') yield chunk;
  }
}

function replied(chunks: number) {
  const events: StreamEvent[] = [{ type: 'reasoning', text: 'thought' }];
  while (events.length < chunks) events.push({ type: 'text', text: 'token' });
  events.push({
    type: 'finish',
    reason: 'stop',
    usage: { input: 900, output: chunks },
  });
  return events;
}

// What every model of the chain replays, the judge of the topic aside.
export function script(chunks: number) {
  const reply = replied(chunks);
  return {
    jev: replied(2),
    mini: reply,
    haiku: reply,
    sonnet: reply,
    gpt: reply,
    opus: reply,
  };
}

export function ask(model: string): ChatRequest {
  return {
    id: 'req_1',
    model,
    messages: [
      { role: 'system', text: 'You are a coding assistant.' },
      { role: 'user', text: 'Why does this deadlock?' },
    ],
    tools: [],
    options: {},
    headers: new Headers({ authorization: 'Bearer key' }),
  };
}

// The chain of the coder example, its packages replaced by parts of the same
// shape, so that what is timed is the core and not a plugin or a schema.
export function coder(): AnyMotty {
  const auth = motty({ name: 'auth' })
    .derive(({ request }) => ({ key: request.headers.get('authorization') }))
    .beforeHandle(({ key }) => {
      if (key === null) throw new Error('No key');
    });

  const emptyPrompt = motty({ name: 'empty-prompt' }).beforeHandle(
    ({ request }) => {
      if (request.messages.length === 0) throw new Error('No messages');
    },
  );

  const offTopic = motty({ name: 'off-topic' }).beforeHandle(
    async ({ request }) => {
      const opening = request.messages.findLast(
        (message) => message.role === 'user',
      )?.text;
      if (opening === undefined) return undefined;
      const judged = await jev.complete({
        messages: [{ role: 'user', text: opening }],
      });
      return (await judged.text()) === 'no'
        ? answer('I only answer questions about software.')
        : undefined;
    },
  );

  const compaction = motty({ name: 'compaction' }).beforeHandle(
    ({ prompt }) => {
      if (prompt.messages.length <= 40) return;
      prompt.messages = prompt.messages.slice(-10);
    },
  );

  const hiddenReasoning = motty({ name: 'hidden-reasoning' }).afterHandle(
    (context) => {
      context.answer = answer(
        withoutReasoning(context.answer.chunks()),
        context.answer,
      );
    },
  );

  const structured = motty({ name: 'structured' }).handle(({ prompt }) =>
    sonnet.complete(prompt),
  );

  const deep = motty({ name: 'deep' })
    .beforeHandle(async ({ prompt }) => {
      const plan = await sonnet.complete(prompt);
      think(plan);
      prompt.messages = [
        ...prompt.messages,
        { role: 'user', text: `Follow this plan:\n${await plan.text()}` },
      ];
    })
    .handle(({ prompt }) =>
      fallback(timeout(opus, 30_000), gpt).complete(prompt),
    );

  const tiers = motty({ name: 'tiers' })
    .route(
      ({ request }) => {
        if (request.model.endsWith(':fast')) return 'quick';
        return request.model.endsWith(':max') ? 'deep' : 'standard';
      },
      {
        quick: ({ prompt }) =>
          race(mini, haiku)
            .complete(prompt)
            .catch(() => reroute('standard')),
        standard: ({ prompt }) =>
          fallback(retry(sonnet, 2), gpt).complete(prompt),
        deep: deep.catch(() => reroute('standard')),
      },
    )
    .afterResponse(async ({ outcome, route }) => {
      if (outcome === 'completed') await Promise.resolve(route);
    });

  return motty({ name: 'coder' })
    .use(auth)
    .use(emptyPrompt)
    .use(offTopic)
    .use(compaction)
    .use(hiddenReasoning)
    .route(({ request }) => (request.output ? 'structured' : 'chat'), {
      structured,
      chat: tiers,
    });
}
