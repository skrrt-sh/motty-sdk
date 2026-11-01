import type { EventStream } from '../contract.ts';
import { stopReason } from '../data/errors.ts';
import { isTerminal, type StreamEvent } from '../data/event.ts';
import type { JsonOutput, Prompt } from '../data/message.ts';
import { type Call, callable, callOf, type Model } from './model.ts';
import { close, onAbort, ownSignal, readOut } from './wait.ts';

export type Upstream = AsyncIterator<StreamEvent>;

// A failure is noted before whoever waits on the call resumes, so a wait
// cut short by the signal can still name it as the cause. A run that may be
// given up while the request goes on holds a signal of its own for that.
export type Run = {
  pending: Promise<Upstream>;
  failed: unknown[];
  own?: ReturnType<typeof ownSignal>;
};

export type Leave = { gone: Promise<typeof gone>; forget: () => void };

export const gone = Symbol('gone');

// A call that ended by itself is not stopped afterwards.
export function ended({ own }: Run): void {
  own?.unfollow();
}

export function abandon(run: Run): void {
  ended(run);
  run.own?.stop();
  run.pending.then(close, () => {});
}

// The one iterator a stream is ever asked for is taken here, so giving the
// call up closes the same one that was read.
export function begin(
  call: Call,
  prompt: Prompt<JsonOutput>,
  signal: AbortSignal,
  own?: ReturnType<typeof ownSignal>,
): Run {
  const failed: unknown[] = [];
  return {
    failed,
    ...(own === undefined ? {} : { own }),
    pending: (async () => {
      try {
        return (await call(prompt, own?.signal ?? signal))[
          Symbol.asyncIterator
        ]();
      } catch (failure) {
        own?.unfollow();
        failed.push(failure);
        throw failure;
      }
    })(),
  };
}

// A call that ignores the signal must not hold whoever waits on it.
export function leaving(signal: AbortSignal): Leave {
  const left = Promise.withResolvers<typeof gone>();
  return {
    gone: left.promise,
    forget: onAbort(signal, () => left.resolve(gone), 'atOnce'),
  };
}

export function abandonKeepingFailure(run: Run, held: unknown): unknown {
  abandon(run);
  return run.failed.length > 0 ? run.failed[0] : held;
}

export function streamOf(upstream: Upstream): EventStream {
  return { [Symbol.asyncIterator]: () => upstream };
}

function handed(run: Run, upstream: Upstream): EventStream {
  let open: Upstream | undefined = upstream;
  return streamOf({
    next: async () => {
      if (open === undefined) return readOut;
      const read = await open.next();
      if (read.done || isTerminal(read.value)) {
        open = undefined;
        ended(run);
      }
      return read;
    },
    return: async () => {
      if (open !== undefined) {
        open = undefined;
        abandon(run);
      }
      return readOut;
    },
  });
}

async function raced(run: Run): Promise<{ run: Run; upstream: Upstream }> {
  return { run, upstream: await run.pending };
}

function callsOf(name: string, models: Model[]): Call[] {
  if (models.length === 0) throw new Error(`${name}() was given no model`);
  return models.map(callOf);
}

/**
 * Tries the models in order and moves on when one fails before its first event,
 * whatever the failure. A failure mid-stream stays in the answer, and when all
 * fail it throws the last failure.
 *
 * @example
 * ```ts
 * const steady = fallback(retry(sonnet, 2), sol);
 * const reply = await steady.complete(prompt);
 * ```
 */
export function fallback(...models: Model[]): Model {
  const calls = callsOf('fallback', models);
  return callable(async (prompt, signal) => {
    const leave = leaving(signal);
    let last: unknown;
    try {
      for (const call of calls) {
        if (signal.aborted) break;
        const run = begin(call, prompt, signal);
        try {
          const opened = await Promise.race([run.pending, leave.gone]);
          if (opened !== gone) return streamOf(opened);
          last = abandonKeepingFailure(run, last);
        } catch (thrown) {
          last = thrown;
        }
      }
      throw signal.aborted ? stopReason(signal.reason, last) : last;
    } finally {
      leave.forget();
    }
  });
}

/**
 * Calls all the models at once and answers with the first to give an event,
 * stopping the others. Every call counts toward `limits.calls` and may be
 * billed, and when all fail it throws the failure of the earliest model listed.
 *
 * @example
 * ```ts
 * const quick = race(luna, haiku);
 * const reply = await quick.complete(prompt);
 * ```
 */
export function race(...models: Model[]): Model {
  const calls = callsOf('race', models);
  return callable(async (prompt, signal) => {
    if (signal.aborted) throw stopReason(signal.reason);
    const leave = leaving(signal);
    const runs = calls.map((call) =>
      begin(call, prompt, signal, ownSignal(signal)),
    );
    try {
      const won = await Promise.race([
        leave.gone,
        Promise.any(runs.map(raced)),
      ]);
      if (won !== gone) {
        for (const run of runs) {
          if (run !== won.run) abandon(run);
        }
        return handed(won.run, won.upstream);
      }
    } catch (thrown) {
      if (!signal.aborted) {
        throw thrown instanceof AggregateError ? thrown.errors[0] : thrown;
      }
    } finally {
      leave.forget();
    }
    for (const run of runs) abandon(run);
    throw stopReason(
      signal.reason,
      runs.find((run) => run.failed.length > 0)?.failed[0],
    );
  });
}
