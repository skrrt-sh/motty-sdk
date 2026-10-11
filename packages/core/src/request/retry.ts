import type { EventStream } from '../contract.ts';
import {
  Aborted,
  LimitReached,
  MottyError,
  stopReason,
} from '../data/errors.ts';
import { callable, callOf, type Model } from './model.ts';
import {
  abandonKeepingFailure,
  begin,
  gone,
  leaving,
  streamOf,
} from './switching.ts';
import { clock } from './wait.ts';

type Attempt =
  | { at: 'trying'; retried: number; failure?: unknown }
  | { at: 'waiting'; retried: number; ms: number; failure: unknown }
  | { at: 'answered'; events: EventStream }
  | { at: 'givenUp'; failure: unknown }
  | { at: 'stopped'; failure?: unknown };

const backoffCap = 30_000;

function backoff(failure: unknown, retried: number): number | undefined {
  if (
    !(failure instanceof MottyError) ||
    failure instanceof Aborted ||
    failure instanceof LimitReached ||
    !failure.retryable
  ) {
    return undefined;
  }
  const hint = failure.retryAfter;
  if (hint === undefined || !Number.isFinite(hint) || hint < 0) {
    return Math.min(500 * 2 ** retried, backoffCap);
  }
  // An upstream that asks for longer than any backoff lasts is not waited
  // for, and not called sooner than it asked either.
  return hint > backoffCap ? undefined : hint;
}

async function paused(ms: number, left: Promise<unknown>): Promise<void> {
  const waited = Promise.withResolvers<void>();
  const timer = clock(waited.resolve, ms);
  await Promise.race([waited.promise, left]);
  clearTimeout(timer);
}

export function retry(model: Model, times: number): Model {
  if (!Number.isInteger(times) || times < 0) {
    throw new Error(`retry() needs a whole number of retries, not ${times}`);
  }
  const call = callOf(model);
  return callable(async (prompt, signal) => {
    const leave = leaving(signal);
    let attempt: Attempt = { at: 'trying', retried: 0 };
    try {
      while (true) {
        switch (attempt.at) {
          case 'trying': {
            const retried: number = attempt.retried;
            const held: unknown = attempt.failure;
            if (signal.aborted) {
              attempt = { at: 'stopped', failure: held };
              break;
            }
            const run = begin(call, prompt, signal);
            try {
              const opened = await Promise.race([run.pending, leave.gone]);
              attempt =
                opened === gone
                  ? { at: 'stopped', failure: abandonKeepingFailure(run, held) }
                  : { at: 'answered', events: streamOf(opened) };
            } catch (failure) {
              const ms: number | undefined =
                retried < times ? backoff(failure, retried) : undefined;
              if (signal.aborted) attempt = { at: 'stopped', failure };
              else if (ms === undefined) attempt = { at: 'givenUp', failure };
              else attempt = { at: 'waiting', retried, ms, failure };
            }
            break;
          }
          case 'waiting':
            await paused(attempt.ms, leave.gone);
            attempt = {
              at: 'trying',
              retried: attempt.retried + 1,
              failure: attempt.failure,
            };
            break;
          case 'answered':
            return attempt.events;
          case 'givenUp':
            throw attempt.failure;
          case 'stopped':
            throw stopReason(signal.reason, attempt.failure);
          default:
            throw attempt satisfies never;
        }
      }
    } finally {
      leave.forget();
    }
  });
}
