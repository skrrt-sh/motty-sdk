import type { RunStream } from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import type { Dict } from '../wire/json.ts';
import { errorBody } from '../wire/openai-error.ts';
import { reasonWritten, replyFields } from './finish.ts';
import { type Piece, pieces } from './reply-pieces.ts';
import { wireCall } from './unread.ts';
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
      const { index, type, opened, input, carried } = piece;
      return { tool_calls: [wireCall(type, input, carried, opened, index)] };
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
  const { piece, ended } = pieces(given.muted, given.custom);
  let role: Dict = { role: 'assistant' };
  function sent(added: Piece): ServerSentEvent {
    const choice = {
      index: 0,
      delta: { ...role, ...delta(added) },
      logprobs: logprobs(added),
      finish_reason: null,
    };
    role = {};
    return {
      data: JSON.stringify({ ...head, choices: [choice], ...counted }),
    };
  }
  for await (const event of events) {
    if (event.type === 'error') {
      // A failed stream ends on an error frame and is never marked done, so
      // a client that reads only deltas still sees a reply that broke off.
      yield { data: JSON.stringify(errorBody(event.error)) };
      return;
    }
    if (event.type === 'finish') {
      for (const added of ended()) yield sent(added);
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
    if (added !== undefined) yield sent(added);
  }
}
