import type { EventStream } from '../contract.ts';
import { stopReason, TimedOut, toFacts } from '../data/errors.ts';
import { isTerminal, type StreamEvent } from '../data/event.ts';
import { callable, callOf, type Model, type Read, stopEvent } from './model.ts';
import {
  abandon,
  abandonKeepingFailure,
  begin,
  ended,
  gone,
  type Leave,
  leaving,
  type Run,
  streamOf,
  type Upstream,
} from './switching.ts';
import { clock, close, ownSignal } from './wait.ts';

type Watch =
  | { at: 'streaming' }
  | {
      at: 'reading';
      read: PromiseWithResolvers<Read>;
      timer: ReturnType<typeof clock>;
    }
  | { at: 'ended'; owed?: Read };

const late = Symbol('late');

function invalid(amount?: number): boolean {
  return amount !== undefined && !(Number.isFinite(amount) && amount >= 0);
}

async function firstOrLate(
  opening: Promise<Upstream>,
  left: Promise<typeof gone>,
  ms?: number,
): Promise<Upstream | typeof gone | typeof late> {
  const limit = Promise.withResolvers<typeof late>();
  const timer = clock(() => limit.resolve(late), ms);
  try {
    return await Promise.race([opening, left, limit.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function stallWatched(
  run: Run,
  upstream: Upstream,
  leave: Leave,
  signal: AbortSignal,
  stallMs?: number,
): EventStream {
  let watch: Watch = { at: 'streaming' };

  function endWatch(): PromiseWithResolvers<Read> | undefined {
    const before = watch;
    watch = { at: 'ended' };
    leave.forget();
    switch (before.at) {
      case 'reading':
        clearTimeout(before.timer);
        return before.read;
      case 'streaming':
      case 'ended':
        return undefined;
      default:
        return before satisfies never;
    }
  }

  function giveUp(last?: StreamEvent): void {
    const owed: Read =
      last === undefined
        ? { done: true, value: undefined }
        : { done: false, value: last };
    switch (watch.at) {
      case 'streaming':
        abandon(run);
        endWatch();
        watch = { at: 'ended', owed };
        return;
      case 'reading':
        abandon(run);
        endWatch()?.resolve(owed);
        return;
      case 'ended':
        return;
      default:
        watch satisfies never;
    }
  }

  function stalled(): void {
    giveUp({
      type: 'error',
      error: toFacts(
        new TimedOut(`The stream stalled: no event in ${stallMs} ms`),
      ),
    });
  }

  function pulled(result: IteratorResult<StreamEvent>): void {
    switch (watch.at) {
      case 'reading': {
        const { read, timer } = watch;
        if (result.done || isTerminal(result.value)) {
          // Closed, not aborted: the call ended by itself, and a reader may
          // stop at the terminal event without reading past it.
          close(upstream);
          ended(run);
          endWatch();
        } else {
          clearTimeout(timer);
          watch = { at: 'streaming' };
        }
        read.resolve(result);
        return;
      }
      case 'streaming':
      case 'ended':
        return;
      default:
        watch satisfies never;
    }
  }

  async function pull(): Promise<void> {
    try {
      pulled(await upstream.next());
    } catch (thrown) {
      ended(run);
      endWatch()?.reject(thrown);
    }
  }

  function next(): Promise<Read> {
    switch (watch.at) {
      case 'streaming': {
        const read = Promise.withResolvers<Read>();
        // Timed from the pull, so a slow reader never counts as a stall.
        watch = { at: 'reading', read, timer: clock(stalled, stallMs) };
        pull();
        return read.promise;
      }
      case 'reading':
        return watch.read.promise.then<Read, Read>(next, next);
      case 'ended': {
        const { owed = { done: true, value: undefined } } = watch;
        watch = { at: 'ended' };
        return Promise.resolve(owed);
      }
      default:
        return watch satisfies never;
    }
  }

  leave.gone.then(() => giveUp(stopEvent(signal)));
  return streamOf({
    next,
    return: async () => {
      giveUp();
      watch = { at: 'ended' };
      return { done: true, value: undefined };
    },
  });
}

export function timeout(
  model: Model,
  limit: number | { firstMs?: number; stallMs?: number },
): Model {
  const call = callOf(model);
  const limits = typeof limit === 'number' ? { firstMs: limit } : limit;
  if (
    typeof limits !== 'object' ||
    limits === null ||
    Object.getPrototypeOf(limits) !== Object.prototype ||
    invalid(limits.firstMs) ||
    invalid(limits.stallMs)
  ) {
    throw new Error('timeout() needs limits of zero or more milliseconds');
  }
  const { firstMs, stallMs } = limits;
  if (firstMs === undefined && stallMs === undefined) return model;
  return callable(async (prompt, signal) => {
    if (signal.aborted) throw stopReason(signal.reason);
    const leave = leaving(signal);
    const run = begin(call, prompt, signal, ownSignal(signal));
    const opened = await firstOrLate(run.pending, leave.gone, firstMs).catch(
      (failure: unknown) => {
        leave.forget();
        throw signal.aborted ? stopReason(signal.reason, failure) : failure;
      },
    );
    if (opened === gone) {
      throw stopReason(signal.reason, abandonKeepingFailure(run, undefined));
    }
    if (opened !== late) {
      return stallWatched(run, opened, leave, signal, stallMs);
    }
    leave.forget();
    abandon(run);
    throw new TimedOut(`No first chunk pulled within ${firstMs} ms`);
  });
}
