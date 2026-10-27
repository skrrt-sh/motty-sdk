import { stopped, stopReason } from '../data/errors.ts';
import { keyed } from '../data/message.ts';

type Timer = ReturnType<typeof setTimeout>;

type Told = () => void;

type When = 'atOnce' | 'afterTurn';

type Waiters = {
  atOnce?: Set<Told>;
  afterTurn?: Set<Told>;
  // Only on a signal the core did not make, whose owner tells nobody.
  readonly listener?: Told;
  timer?: Timer;
};

const waiters = Symbol('waiters');

type Followed = AbortSignal & { [waiters]?: Waiters };

// Shared by every stop with no reason given, so ending a phase makes no error.
const noReason = new DOMException(stopped, 'AbortError');

// A timer given a longer delay than this fires after one millisecond.
const timerMax = 2 ** 31 - 1;

export function clock(ring: () => void, ms?: number): Timer | undefined {
  return ms === undefined
    ? undefined
    : setTimeout(ring, Math.min(ms, timerMax));
}

// Not awaited: a stream that never answers its close must not hold whoever
// gave it up.
export function close(source: { return?: () => unknown }): void {
  (async () => source.return?.())().catch(() => {});
}

export function reasonOf(signal: AbortSignal): unknown {
  return signal.reason === noReason ? undefined : signal.reason;
}

function tellAll(told: Set<Told> | undefined): void {
  if (told === undefined) return;
  for (const each of told) {
    told.delete(each);
    each();
  }
}

function tellAfterTurn(held: Waiters): void {
  if (held.afterTurn === undefined || held.afterTurn.size === 0) return;
  held.timer ??= setTimeout(() => {
    delete held.timer;
    tellAll(held.afterTurn);
  });
}

function tell(held: Waiters): void {
  tellAll(held.atOnce);
  tellAfterTurn(held);
}

function isIdle({ atOnce, afterTurn }: Waiters): boolean {
  return (atOnce?.size ?? 0) + (afterTurn?.size ?? 0) === 0;
}

function waitersOf(signal: Followed): Waiters {
  if (signal[waiters] !== undefined) return signal[waiters];
  const held: Waiters = { listener: () => tell(held) };
  signal[waiters] = held;
  return held;
}

function nothingToUnfollow(): void {}

// Code that follows the signal itself ends a few microtasks after it fires
// and says more than the stop does: whoever would cut it short asks to be told
// after the turn. Whoever must act before anything else runs asks for at once.
export function onAbort(signal: Followed, told: Told, when: When): () => void {
  const held = waitersOf(signal);
  if (signal.aborted && when === 'atOnce') {
    told();
    return nothingToUnfollow;
  }
  const { listener } = held;
  if (listener !== undefined && !signal.aborted && isIdle(held)) {
    signal.addEventListener('abort', listener);
  }
  held[when] ??= new Set();
  held[when].add(told);
  if (signal.aborted) tellAfterTurn(held);
  return () => {
    held[when]?.delete(told);
    if (!isIdle(held)) return;
    if (listener !== undefined) signal.removeEventListener('abort', listener);
    if (held.timer === undefined) return;
    clearTimeout(held.timer);
    delete held.timer;
  };
}

export function ownSignal(parent?: AbortSignal): {
  signal: AbortSignal;
  stop: (reason?: unknown) => void;
  unfollow: () => void;
} {
  const own = new AbortController();
  const signal: Followed = own.signal;
  const held: Waiters = {};
  signal[waiters] = held;
  const stop = (reason: unknown = noReason) => {
    if (signal.aborted) return;
    own.abort(reason);
    tell(held);
  };
  const unfollow =
    parent === undefined
      ? nothingToUnfollow
      : onAbort(parent, () => stop(parent.reason), 'atOnce');
  return { signal, stop, unfollow };
}

function isPending<Value>(
  given: Value | PromiseLike<Value>,
): given is PromiseLike<Value> {
  return keyed(given) && 'then' in given && typeof given.then === 'function';
}

export function wait<Value>(
  given: PromiseLike<Value>,
  signal: AbortSignal,
): Promise<Value>;
export function wait<Value>(
  given: Value | PromiseLike<Value>,
  signal: AbortSignal,
): Value | Promise<Value>;
export function wait<Value>(
  given: Value | PromiseLike<Value>,
  signal: AbortSignal,
): Value | Promise<Value> {
  if (!isPending(given)) return given;
  return new Promise<Value>((resolve, reject) => {
    const unwatch = onAbort(
      signal,
      () => reject(stopReason(signal.reason)),
      'afterTurn',
    );
    given.then(
      (value) => {
        unwatch();
        resolve(value);
      },
      (thrown: unknown) => {
        unwatch();
        reject(thrown);
      },
    );
  });
}

export function stepUnder<Given, Result>(
  signal: AbortSignal,
  step: (given: Given) => Result | PromiseLike<Result>,
  given: Given,
): Result | Promise<Result> {
  if (signal.aborted) throw stopReason(signal.reason);
  return wait(step(given), signal);
}

export function reader(
  source: AsyncIterator<unknown>,
  signal: AbortSignal | undefined,
  onGiveUp: () => void,
): {
  read: (
    took: (result: IteratorResult<unknown>) => void,
    threw: (thrown: unknown) => void,
  ) => void;
  end: (readOut: boolean) => void;
} {
  const unwatch =
    signal === undefined ? undefined : onAbort(signal, onGiveUp, 'afterTurn');
  // Ended once: a read that settles after the source was given up would end
  // it, and close it, again.
  let ended = false;
  return {
    read: (took, threw) => {
      if (signal?.aborted) return onGiveUp();
      try {
        Promise.resolve(source.next()).then(took, threw);
      } catch (thrown) {
        threw(thrown);
      }
    },
    end: (readOut) => {
      if (ended) return;
      ended = true;
      unwatch?.();
      if (!readOut) close(source);
    },
  };
}

export function readToEnd(
  items: AsyncIterable<unknown>,
  signal: AbortSignal | undefined,
  take: (item: unknown) => void,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const source = reader(items[Symbol.asyncIterator](), signal, () => {
      source.end(false);
      resolve(false);
    });
    const threw = (thrown: unknown) => {
      source.end(false);
      reject(thrown);
    };
    const took = (result: IteratorResult<unknown>) => {
      try {
        if (!result.done) {
          take(result.value);
          return source.read(took, threw);
        }
        source.end(true);
        resolve(true);
      } catch (thrown) {
        threw(thrown);
      }
    };
    source.read(took, threw);
  });
}
