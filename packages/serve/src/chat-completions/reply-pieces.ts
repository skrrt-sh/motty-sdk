import type { Chunk, Json, Progress } from '@mottyjs/core/host';
import { type Dict, isDict, list, number } from '../wire/json.ts';
import { hinted } from './family.ts';
import { callFields, type Kind, unreadOf } from './unread.ts';

// One shape for both replies, so a stream and a collected message cannot
// come to differ in what they hold.
export type Piece =
  | { kind: 'reasoning'; text: string; details?: Json[] }
  | { kind: 'content' | 'refusal'; text: string; logprobs?: Json[] }
  | {
      kind: 'call';
      index: number;
      type: Kind;
      // Present on a call's first fragment only, as on the wire.
      opened?: { id: string; name: string };
      input: string;
      carried?: Dict;
    }
  | { kind: 'annotation'; annotation: Dict }
  | { kind: 'audio'; audio: Dict }
  | { kind: 'image'; image: Dict };

// A picture a model made has one place on this wire, a field that holds it
// by address: bytes go as a data address, and a file of another kind or one
// held by id has no form.
export function pictured(
  chunk: Extract<Chunk, { type: 'file' }>,
): Dict | undefined {
  const { url, data, mediaType } = chunk;
  const own = hinted(chunk.provider);
  const { type } = own;
  if (mediaType?.startsWith('image/') !== true && type !== 'image_url') {
    return undefined;
  }
  const address = data === undefined ? url : `data:${mediaType};base64,${data}`;
  return address === undefined
    ? undefined
    : { type: 'image_url', ...own, image_url: { url: address } };
}

// One per reply: tool calls are numbered in the order their ids appear.
export function pieces(muted: boolean, customs?: ReadonlySet<string>) {
  const calls = new Map<string, { index: number; type: Kind }>();
  // Function calls no input has gone out for yet, by id.
  const empty = new Map<string, number>();
  let progress: number | undefined;
  let thinking = false;
  let length = 0;

  // Progress is written as reasoning, the one thing every client of this
  // wire shows apart from the answer. It has no block ids, so a line break
  // is what sets one piece of progress, and the model's own thinking, apart.
  function thought(text: string, piece: number | undefined): Piece | undefined {
    if (muted || text === '') return undefined;
    const lead = thinking && piece !== progress ? '\n' : '';
    thinking = true;
    progress = piece;
    return { kind: 'reasoning', text: lead + text };
  }

  // Details ride on the reasoning they came with, or alone when what signs
  // it came with no text. A caller who muted reasoning gets neither.
  function reasoned(
    event: Extract<Chunk, { type: 'reasoning' }>,
  ): Piece | undefined {
    const { reasoning_details: given } = hinted(event.provider);
    const details = list(given);
    const said = thought(event.text, undefined);
    if (muted || details.length === 0) return said;
    const text = said?.kind === 'reasoning' ? said.text : '';
    return { kind: 'reasoning', text, details };
  }

  function said(
    kind: 'content' | 'refusal',
    event: Extract<Chunk, { type: 'text' | 'refusal' }>,
  ): Piece | undefined {
    const { logprobs } = hinted(event.provider);
    // Likelihoods may come on an empty text. Any other empty text says
    // nothing a client can use.
    if (event.text === '' && !Array.isArray(logprobs)) return undefined;
    if (kind === 'content') length += event.text.length;
    return {
      kind,
      text: event.text,
      ...(Array.isArray(logprobs) ? { logprobs } : {}),
    };
  }

  // Arguments are JSON, and no client parses none: a function call that
  // ended with nothing took an empty object. A custom tool's input is text.
  function closed(index: number): Piece {
    return { kind: 'call', index, type: 'function', input: '{}' };
  }

  // The empty object of every function call still empty when the reply ends.
  function ended(): Piece[] {
    const out = Array.from(empty.values(), closed);
    empty.clear();
    return out;
  }

  function piece(event: Chunk | Progress): Piece | undefined {
    switch (event.type) {
      case 'progress':
        return thought(event.text, event.piece);
      case 'reasoning':
        return reasoned(event);
      case 'text':
        return said('content', event);
      case 'refusal':
        return said('refusal', event);
      case 'tool_call': {
        // A tool the upstream ran itself is nothing this caller may answer.
        if (event.hosted === true) return undefined;
        const known = calls.get(event.id);
        const own = hinted(event.provider);
        const { type: mark } = own;
        // An upstream of another API marks no call: the caller's tools say.
        const call = known ?? {
          index: calls.size,
          type:
            mark === 'custom' || customs?.has(event.name ?? '') === true
              ? 'custom'
              : 'function',
        };
        calls.set(event.id, call);
        if (known === undefined && call.type === 'function') {
          empty.set(event.id, call.index);
        }
        const input =
          event.arguments === '' && event.ended === true && empty.has(event.id)
            ? '{}'
            : event.arguments;
        if (input !== '') empty.delete(event.id);
        // A late fragment of provider data alone may hold none this wire
        // writes, and a client need not be sent a fragment that says nothing.
        if (
          known !== undefined &&
          input === '' &&
          unreadOf(own, call.type, callFields) === undefined
        ) {
          return undefined;
        }
        const added: Piece = {
          kind: 'call',
          ...call,
          ...(known === undefined
            ? { opened: { id: event.id, name: event.name ?? '' } }
            : {}),
          input,
        };
        // Set, not spread: few fragments carry anything, and a spread for
        // those that do not cost a sixth of what collecting a reply does.
        if (event.provider !== undefined) added.carried = own;
        return added;
      }
      case 'citation': {
        if (event.url === undefined) return undefined;
        const { start_index: start, end_index: end } = hinted(event.provider);
        return {
          kind: 'annotation',
          annotation: {
            type: 'url_citation',
            url_citation: {
              // Without the upstream's own span, the place it was cited at.
              start_index: number(start) ?? length,
              end_index: number(end) ?? length,
              title: event.title ?? '',
              url: event.url,
            },
          },
        };
      }
      case 'provider': {
        const { audio } = hinted(event.provider);
        return isDict(audio) ? { kind: 'audio', audio } : undefined;
      }
      case 'file': {
        const image = pictured(event);
        return image === undefined ? undefined : { kind: 'image', image };
      }
      // It has no form on this wire, so the reply ends before it.
      case 'tool_result':
        return undefined;
      default:
        return event satisfies never;
    }
  }

  return { piece, ended };
}
