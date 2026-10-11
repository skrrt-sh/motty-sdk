import {
  type Chunk,
  type ErrorFacts,
  type Finish,
  type FinishReason,
  isTerminal,
  type Json,
  type Progress,
  type RunStream,
  type Usage,
} from '@mottyjs/core/host';
import type { ServerSentEvent } from '../sse.ts';
import type { Dict } from '../wire/json.ts';
import { wireCode } from '../wire/openai-error.ts';
import type { Sent } from './output.ts';
import { type Asked, reply } from './reply.ts';

function usageBody(usage: Usage | undefined): Json {
  if (usage === undefined) return null;
  const { input = 0, output = 0, cached = 0, reasoning = 0 } = usage;
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: cached,
      cache_write_tokens: usage.cacheWrite ?? 0,
    },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
    // No field of this API: a router adds it, and a caller is sent it as named.
    ...(usage.cost === undefined ? {} : { cost: usage.cost }),
  };
}

// The response as it stands when it starts: what was asked, echoed the way
// this API echoes it, and nothing held on the server.
function started({ body }: Asked, id: string): Dict {
  const {
    instructions = null,
    max_output_tokens = null,
    metadata,
    model = null,
    parallel_tool_calls,
    reasoning,
    temperature = null,
    text,
    tool_choice,
    tools,
    top_p = null,
    truncation,
    user = null,
  } = body;
  return {
    id: `resp_${id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    background: false,
    error: null,
    incomplete_details: null,
    instructions,
    max_output_tokens,
    metadata: metadata ?? {},
    model,
    output: [],
    parallel_tool_calls: parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: reasoning ?? { effort: null, summary: null },
    store: false,
    temperature,
    text: text ?? { format: { type: 'text' } },
    tool_choice: tool_choice ?? 'auto',
    tools: tools ?? [],
    top_p,
    truncation: truncation ?? 'disabled',
    usage: null,
    user,
  };
}

function cutBy(reason: FinishReason): string | undefined {
  if (reason === 'length') return 'max_output_tokens';
  return reason === 'content_filter' ? 'content_filter' : undefined;
}

// A response cut short is incomplete and says why; any other end, a pause or
// a call to a tool among them, is a completed response.
function finished(
  response: Dict,
  output: Dict[],
  { reason, usage }: Finish,
): Dict {
  const cut = cutBy(reason);
  return {
    ...response,
    status: cut === undefined ? 'completed' : 'incomplete',
    ...(cut === undefined
      ? { completed_at: Math.floor(Date.now() / 1000) }
      : { incomplete_details: { reason: cut } }),
    output,
    usage: usageBody(usage),
  };
}

function failed(
  response: Dict,
  output: Dict[],
  facts: ErrorFacts,
  usage: Usage | undefined,
): Dict {
  const { code, message } = facts;
  return {
    ...response,
    status: 'failed',
    error: { code: wireCode(code), message },
    output,
    usage: usageBody(usage),
  };
}

// A stream that fails after it started ends the way this API ends a failed
// response: the response itself, failed, with the error in it.
export async function* streamed(
  asked: Asked,
  events: RunStream,
  id: string,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const response = started(asked, id);
  const { output, push, closed } = reply(asked, id);
  let sequence = 0;
  const written = ({ type, ...fields }: Sent): ServerSentEvent => ({
    event: type,
    data: JSON.stringify({ type, sequence_number: sequence++, ...fields }),
  });
  yield written({ type: 'response.created', response });
  yield written({ type: 'response.in_progress', response });
  for await (const event of events) {
    if (!isTerminal(event)) {
      for (const sent of push(event)) yield written(sent);
      continue;
    }
    if (event.type === 'error') {
      for (const sent of closed('failed')) yield written(sent);
      yield written({
        type: 'response.failed',
        response: failed(response, output, event.error, event.usage),
      });
      return;
    }
    const end = ending(event);
    for (const sent of closed(end)) yield written(sent);
    yield written({
      type: end === 'cut' ? 'response.incomplete' : 'response.completed',
      response: finished(response, output, event),
    });
    return;
  }
}

function ending({ reason }: Finish): 'whole' | 'cut' {
  return cutBy(reason) === undefined ? 'whole' : 'cut';
}

export function collected(
  asked: Asked,
  events: readonly (Chunk | Progress)[],
  finish: Finish,
  id: string,
): Json {
  const { output, push, closed } = reply(asked, id);
  for (const event of events) push(event);
  closed(ending(finish));
  return finished(started(asked, id), output, finish);
}
