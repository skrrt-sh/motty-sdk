import { TimedOut, toFacts } from '../data/errors.ts';
import {
  beginAfterResponse,
  endPhase,
  type RequestState,
} from '../request/context.ts';
import { clock, wait } from '../request/wait.ts';
import type { Lifecycle } from './assemble.ts';
import type { Outcome, Supplied } from './builder.ts';
import type { Trace } from './record.ts';

export type Finished = {
  readonly lifecycle: Lifecycle;
  readonly context: Supplied;
  readonly cut: number;
  readonly answered: boolean;
};

const defaultLimitMs = 30_000;

export async function afterwards(
  finished: readonly Finished[],
  outcome: Outcome,
  { limits }: RequestState,
  trace: Trace | undefined,
): Promise<void> {
  if (finished.length === 0) return;
  const { signal, stop } = beginAfterResponse();
  const limitMs = limits.afterResponse ?? defaultLimitMs;
  // A hook that blocked leaves the timer no turn to fire, so the clock is read.
  const due = performance.now() + limitMs;
  const timer = clock(
    () => stop(new TimedOut('After-response work passed its time limit')),
    limitMs,
  );
  for (const { lifecycle, context, cut, answered } of finished) {
    // A lifecycle that gave no answer did not complete, whatever the caller got.
    const seen = answered || outcome === 'aborted' ? outcome : 'failed';
    for (const hook of lifecycle.afterResponse) {
      const unreached = hook.needs >= cut;
      if (unreached || signal.aborted || performance.now() >= due) {
        trace?.afterResponse[unreached ? 'unreached' : 'skipped'].push(
          hook.owner,
        );
        continue;
      }
      try {
        await wait(hook.run({ ...context, signal, outcome: seen }), signal);
      } catch (thrown) {
        trace?.afterResponse.failed.push({
          part: hook.owner,
          error: toFacts(thrown),
        });
      }
    }
  }
  clearTimeout(timer);
  await endPhase();
}
