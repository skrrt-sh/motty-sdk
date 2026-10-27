import type { Json, Message } from '@mottyjs/core/host';
import type { Decoded } from '../codec.ts';
import { formed, formedWhole } from '../wire/formless.ts';
import { given, isDict } from '../wire/json.ts';
import { invalid } from '../wire/refusals.ts';
import { heard, marked, noted } from './family.ts';
import { formless } from './formless.ts';
import { collected } from './message.ts';
import { optionsOf } from './options.ts';
import { contentOf } from './parts.ts';
import { streamed } from './reply.ts';
import { toolOf } from './tools.ts';

// Whatever else a message holds changes the meaning for all this codec
// knows, so it rides as this family's own. Effort is steered as a hint
// everywhere else, so here too.
function messageOf(raw: Json): Message {
  if (!isDict(raw)) invalid('A message must be an object');
  const { role, content, output_config: steer, ...rest } = raw;
  switch (role) {
    case 'user':
    case 'assistant':
    case 'system':
      return {
        role,
        ...contentOf(content, 'Message content'),
        ...marked(rest),
        ...noted(given({ output_config: steer })),
      };
    default:
      return invalid('A message role must be user, assistant or system');
  }
}

function systemOf(system: Json | undefined): Message[] {
  if (system === undefined || system === null) return [];
  return [{ role: 'system', ...contentOf(system, 'system') }];
}

export function decode(body: Json, headers: Headers): Decoded {
  const version = headers.get('anthropic-version');
  // An older version streams other events than the ones written here.
  if (version !== null && version !== '2023-06-01') {
    invalid(`anthropic-version ${version} is not served`);
  }
  if (!isDict(body)) invalid('The request body must be a JSON object');
  const { model, messages, system, stream, tools, ...settings } = body;
  if (typeof model !== 'string') invalid('The body needs a model');
  if (!Array.isArray(messages) || messages.length === 0) {
    invalid('messages must be a list with at least one message');
  }
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) {
    invalid('tools must be a list');
  }
  if (stream !== undefined && typeof stream !== 'boolean') {
    invalid('stream must be true or false');
  }
  const { options, output, shown } = optionsOf(settings, heard(headers));
  return {
    request: {
      model,
      messages: [...systemOf(system), ...messages.map(messageOf)],
      tools: (tools ?? []).map(toolOf),
      options,
      ...(output === undefined ? {} : { output }),
    },
    stream: stream === true,
    formless,
    streamed: (events, id) =>
      streamed(formed(events, formless), id, model, shown),
    collected: (events, finish, id) =>
      collected(formedWhole(events, formless), finish, id, model, shown),
  };
}
