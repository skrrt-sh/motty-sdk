import type { Chunk, Progress } from '@mottyjs/core/host';
import type { Dict } from '../wire/json.ts';
import { unsupported } from '../wire/refusals.ts';
import { called, given } from './calls.ts';
import { api, held } from './family.ts';
import { field } from './fields.ts';
import type { Spaced } from './namespaces.ts';
import {
  type Call,
  callItem,
  type Ended,
  ended,
  imageItem,
  messageItem,
  type Sent,
  thoughtItem,
  type Writing,
} from './output.ts';
import { thought } from './reasoning.ts';
import { cited, said } from './spoken.ts';

export type Asked = {
  body: Dict;
  muted: boolean;
  custom: ReadonlySet<string>;
  spaced: Spaced;
  clients: ReadonlySet<string>;
  // Whether the caller asked for what a model goes on from its reasoning with.
  encrypted: boolean;
};

export function reply(asked: Asked, id: string) {
  const output: Dict[] = [];
  const calls = new Map<string, Call>();
  const over = new Set<string>();
  const writing: Writing = { id, output, open: undefined, added, settled };

  function added(item: Dict): Sent {
    output.push(item);
    return {
      type: 'response.output_item.added',
      output_index: output.length - 1,
      item,
    };
  }

  function done(index: number, item: Dict): Sent {
    output[index] = item;
    return { type: 'response.output_item.done', output_index: index, item };
  }

  function settled(status: Ended = 'completed'): Sent[] {
    const last = writing.open;
    if (last === undefined) return [];
    writing.open = undefined;
    return [
      ...ended(last),
      done(
        last.index,
        last.kind === 'reasoning'
          ? thoughtItem(last, status)
          : messageItem(last, status),
      ),
    ];
  }

  // An item that comes whole is added and done at once.
  function whole(item: Dict | undefined): Sent[] {
    if (item === undefined || typeof field(item, 'type') !== 'string') {
      return [];
    }
    const sent = [...settled(), added(item)];
    return [...sent, done(output.length - 1, item)];
  }

  function push(event: Chunk | Progress): Sent[] {
    switch (event.type) {
      case 'progress':
        return asked.muted
          ? []
          : thought(writing, event.text, {
              part: 'summary',
              piece: event.piece,
            });
      case 'reasoning': {
        const own = held(event.provider);
        const kind = field(own, 'type');
        const item =
          kind === 'summary_text' || kind === 'reasoning_text'
            ? undefined
            : own;
        // Another family's data is the caller's to send back when it asked.
        const carried =
          own === undefined && asked.encrypted ? event.provider : undefined;
        // Muted, the model's reasoning is still handed back when it is this
        // API's own item: the caller returns it for the model to go on from.
        // The content that item holds is streamed, so the two agree.
        if (asked.muted && own === undefined && carried === undefined) {
          return [];
        }
        const shown = !asked.muted || kind === 'reasoning_text';
        return thought(writing, shown ? event.text : '', {
          part: kind === 'reasoning_text' ? 'content' : 'summary',
          ...(event.block === undefined ? {} : { block: event.block }),
          ...(item === undefined ? {} : { item }),
          ...(carried === undefined ? {} : { carried }),
        });
      }
      case 'text':
      case 'refusal':
        return said(writing, event);
      case 'citation':
        return cited(writing, event);
      case 'tool_call': {
        if (event.hosted === true) return [];
        // An item that is done cannot be opened again on this wire, and its
        // arguments were written whole, so more of them fails the reply.
        if (over.has(event.id)) {
          if (event.arguments === '') return [];
          unsupported(
            `${api} cannot write a tool call that was told more after it ended`,
          );
        }
        const sent = called(writing, calls, asked, event);
        const call = event.ended === true ? calls.get(event.id) : undefined;
        if (call === undefined) return sent;
        // Only a call said to have ended is done here, as pieces of calls
        // made together may come in turn and no other chunk says the last.
        calls.delete(event.id);
        over.add(event.id);
        sent.push(
          ...given(call, 'completed'),
          done(call.index, callItem(call, 'completed')),
        );
        return sent;
      }
      case 'provider':
        return whole(held(event.provider));
      case 'file':
        return whole(imageItem(`ig_${id}_${output.length}`, event));
      default:
        return [];
    }
  }

  // A reply that failed finished none of the items still being written; one
  // that was cut off did not finish the last.
  function closed(end: 'whole' | 'cut' | 'failed'): Sent[] {
    const last = output.length - 1;
    const status = (index: number): Ended =>
      end === 'failed' || (end === 'cut' && index === last)
        ? 'incomplete'
        : 'completed';
    const { open } = writing;
    const sent = settled(open === undefined ? undefined : status(open.index));
    for (const call of calls.values()) {
      sent.push(
        ...given(call, status(call.index)),
        done(call.index, callItem(call, status(call.index))),
      );
    }
    calls.clear();
    return sent;
  }

  return { output, push, closed };
}
