import type { Chunk } from '@mottyjs/core/host';
import { without } from '../wire/json.ts';
import { held } from './family.ts';
import { callUncarried, isCustom, put } from './fields.ts';
import type { Spaced } from './namespaces.ts';
import {
  type Call,
  callItem,
  type Ended,
  type Sent,
  type Writing,
} from './output.ts';

export function called(
  writing: Writing,
  calls: Map<string, Call>,
  asked: {
    custom: ReadonlySet<string>;
    spaced: Spaced;
    clients: ReadonlySet<string>;
  },
  event: Chunk & { type: 'tool_call' },
): Sent[] {
  const sent: Sent[] = [];
  let call = calls.get(event.id);
  if (call === undefined) {
    sent.push(...writing.settled());
    const index = writing.output.length;
    const own = held(event.provider) ?? {};
    // An upstream of another API marks no call, so the caller's tools say.
    const named = event.name ?? '';
    const custom = isCustom(own) || asked.custom.has(named);
    // A call this API made says its namespace itself; another family's is
    // named apart from it.
    const spaced = !('namespace' in own) && asked.spaced.get(named);
    const run = !('type' in own) && asked.clients.has(named);
    const itemId = `${custom ? 'ctc' : run ? 'tsc' : 'fc'}_${writing.id}_${index}`;
    call = {
      index,
      id: itemId,
      holds: custom ? 'input' : run ? 'object' : 'arguments',
      given: '',
      item: {
        ...without(own, callUncarried),
        id: itemId,
        ...(run
          ? { type: `${named}_call`, call_id: event.id, execution: 'client' }
          : {
              type: custom ? 'custom_tool_call' : 'function_call',
              call_id: event.id,
              ...(spaced || { name: named }),
            }),
      },
    };
    calls.set(event.id, call);
    sent.push(writing.added(callItem(call, 'in_progress')));
  } else if (event.provider !== undefined) {
    put(call.item, without(held(event.provider) ?? {}, callUncarried));
  }
  if (event.arguments === '') return sent;
  call.given += event.arguments;
  // Its arguments are an object, written whole when the call is done.
  if (call.holds === 'object') return sent;
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

// Arguments are JSON, and no client parses none: a call that ended having
// said nothing took an empty object. A custom tool's input is free text.
export function given(call: Call, status: Ended): Sent[] {
  if (status === 'completed' && call.holds !== 'input') call.given ||= '{}';
  const { index, id, holds, given: whole } = call;
  if (holds === 'object') return [];
  return [
    {
      type:
        holds === 'input'
          ? 'response.custom_tool_call_input.done'
          : 'response.function_call_arguments.done',
      item_id: id,
      output_index: index,
      [holds]: whole,
    },
  ];
}
