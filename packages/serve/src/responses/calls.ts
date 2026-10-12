import type { Chunk } from '@mottyjs/core/host';
import { without } from '../wire/json.ts';
import { held } from './family.ts';
import { callUncarried, isCustom, put } from './fields.ts';
import { type Call, callItem, type Sent, type Writing } from './output.ts';

export function called(
  writing: Writing,
  calls: Map<string, Call>,
  customs: ReadonlySet<string>,
  event: Chunk & { type: 'tool_call' },
): Sent[] {
  const sent: Sent[] = [];
  let call = calls.get(event.id);
  if (call === undefined) {
    sent.push(...writing.settled());
    const index = writing.output.length;
    const own = held(event.provider) ?? {};
    // An upstream of another API marks no call, so the caller's tools say.
    const custom = isCustom(own) || customs.has(event.name ?? '');
    const itemId = `${custom ? 'ctc' : 'fc'}_${writing.id}_${index}`;
    call = {
      index,
      id: itemId,
      holds: custom ? 'input' : 'arguments',
      given: '',
      item: {
        ...without(own, callUncarried),
        id: itemId,
        type: custom ? 'custom_tool_call' : 'function_call',
        call_id: event.id,
        name: event.name ?? '',
      },
    };
    calls.set(event.id, call);
    sent.push(writing.added(callItem(call, 'in_progress')));
  } else if (event.provider !== undefined) {
    put(call.item, without(held(event.provider) ?? {}, callUncarried));
  }
  if (event.arguments === '') return sent;
  call.given += event.arguments;
  sent.push({
    type:
      call.holds === 'input'
        ? 'response.custom_tool_call_input.delta'
        : 'response.function_call_arguments.delta',
    item_id: call.id,
    output_index: call.index,
    delta: event.arguments,
  });
  return sent;
}

export function given({ index, id, holds, given: whole }: Call): Sent {
  return {
    type:
      holds === 'input'
        ? 'response.custom_tool_call_input.done'
        : 'response.function_call_arguments.done',
    item_id: id,
    output_index: index,
    [holds]: whole,
  };
}
