import type { ErrorFacts, Finish, FinishReason } from '@mottyjs/core/host';
import { type Dict, given } from '../wire/json.ts';
import { upstreamFailure } from '../wire/upstream-failure.ts';
import type { Dialect } from './dialect.ts';
import { hinted } from './family.ts';

export function reasonRead(
  raw: string,
  own?: Dialect['endings'],
): FinishReason {
  switch (raw) {
    case 'stop':
    case 'length':
      return raw;
    case 'tool_calls':
    case 'function_call':
      return 'toolCalls';
    // Providers' own names for endings this wire has a reason for.
    case 'content_filter':
    case 'sensitive':
      return 'contentFilter';
    case 'model_context_window_exceeded':
      return 'length';
    default:
      return (
        (own !== undefined && Object.hasOwn(own, raw) ? own[raw] : undefined) ??
        'other'
      );
  }
}

// A provider that ran out of capacity or lost its connection says so where
// the reason goes, and a dialect may name a failure of its own there. The
// reply did not end: the call failed.
export function reasonFailed(
  key: string,
  raw: string,
  own?: Dialect['broken'],
): ErrorFacts | undefined {
  const record = { [key]: { finish_reason: raw } };
  switch (raw) {
    case 'insufficient_system_resource':
      return upstreamFailure({
        code: 'overloaded',
        message: 'The upstream ran out of capacity before it finished',
        record,
      });
    case 'network_error':
      return upstreamFailure({
        code: 'upstreamFailed',
        message: 'The upstream lost its connection before it finished',
        record,
        retryable: true,
      });
    default:
      return own?.includes(raw) === true
        ? upstreamFailure({
            code: 'upstreamFailed',
            message: 'The upstream failed before it finished',
            record,
            retryable: true,
          })
        : undefined;
  }
}

// This wire has no reason for a paused turn or an unknown one: both ended
// the reply without a tool call, which is what a stop tells a client.
export function reasonWritten(reason: FinishReason): string {
  switch (reason) {
    case 'stop':
    case 'length':
      return reason;
    case 'toolCalls':
      return 'tool_calls';
    case 'contentFilter':
      return 'content_filter';
    case 'pause':
    case 'other':
      return 'stop';
    default:
      return reason satisfies never;
  }
}

// What the upstream said of the whole reply, known only when it has ended.
export function replyFields(finish: Finish): Dict {
  const { system_fingerprint, service_tier } = hinted(finish.provider);
  return given({ system_fingerprint, service_tier });
}
