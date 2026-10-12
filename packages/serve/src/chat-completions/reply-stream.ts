import type { RunStream } from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import type { Dict } from '../wire/json.ts';
import { errorBody } from '../wire/openai-error.ts';
import { reasonWritten, replyFields } from './finish.ts';
import { type Piece, pieces } from './reply-pieces.ts';
import { callFields, rebuilt } from './unread.ts';
import { usageField } from './usage.ts';

function delta(piece: Piece): Dict {
  switch (piece.kind) {
    case 'reasoning':
      // Clients of this wire read either name.
      return {
        ...(piece.text === ''
          ? {}
          : { reasoning: piece.text, reasoning_content: piece.text }),
        ...(piece.details === undefined
          ? {}
          : { reasoning_details: piece.details }),
      };
    case 'content':
      return { content: piece.text };
    case 'refusal':
      return { refusal: piece.text };
    case 'call': {
      const { index, custom, opened, input, carried } = piece;
      const kind = custom ? 'custom' : 'function';
      const name = opened === undefined ? {} : { name: opened.name };
      const outer = {
        index,
        ...(opened === undefined ? {} : { id: opened.id, type: kind }),
      };
      const inner = custom ? { ...name, input } : { ...name, arguments: input };
      return {
        tool_calls: [rebuilt(carried, kind, callFields, outer, inner)],
      };
    }
    case 'annotation':
      return { annotations: [piece.annotation] };
    case 'audio':
      return { audio: piece.audio };
    case 'image':
      return { images: [piece.image] };
    default:
      return piece satisfies never;
  }
}

function logprobs(piece: Piece): Dict | null {
  if (piece.kind !== 'content' && piece.kind !== 'refusal') return null;
  if (piece.logprobs === undefined) return null;
  return piece.kind === 'content'
    ? { content: piece.logprobs, refusal: null }
    : { content: null, refusal: piece.logprobs };
}

export async function* streamed(
  events: RunStream,
  given: {
    id: string;
    model: string;
    muted: boolean;
    usage: boolean;
    custom?: ReadonlySet<string>;
  },
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const head = {
    id: `chatcmpl-${given.id}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: given.model,
  };
  // A caller who asked for usage is sent the field on every chunk.
  const counted = given.usage ? { usage: null } : {};
  const piece = pieces(given.muted, given.custom);
  let role: Dict = { role: 'assistant' };
  for await (const event of events) {
    if (event.type === 'error') {
      // A failed stream ends on an error frame and is never marked done, so
      // a client that reads only deltas still sees a reply that broke off.
      yield { data: JSON.stringify(errorBody(event.error)) };
      return;
    }
    if (event.type === 'finish') {
      const fields = { ...head, ...replyFields(event) };
      const choice = {
        index: 0,
        delta: role,
        logprobs: null,
        finish_reason: reasonWritten(event.reason),
      };
      yield {
        data: JSON.stringify({ ...fields, choices: [choice], ...counted }),
      };
      const { usage } = usageField(event.usage);
      if (given.usage && usage !== undefined) {
        yield { data: JSON.stringify({ ...fields, choices: [], usage }) };
      }
      yield { data: '[DONE]' };
      return;
    }
    const added = piece(event);
    if (added === undefined) continue;
    const choice = {
      index: 0,
      delta: { ...role, ...delta(added) },
      logprobs: logprobs(added),
      finish_reason: null,
    };
    role = {};
    yield { data: JSON.stringify({ ...head, choices: [choice], ...counted }) };
  }
}
