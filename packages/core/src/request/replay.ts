import { stopReason } from '../data/errors.ts';
import { onAbort } from './wait.ts';

type BufferState =
  | { readonly at: 'arriving' | 'finished' }
  | { readonly at: 'failed'; readonly error: () => unknown };

export type Arrival<Item> = {
  readonly buffer: readonly Item[];
  readonly state: () => BufferState;
  readonly onArrival: (wake: () => void) => () => void;
};

export async function* replayed<Item>(
  { buffer, state, onArrival }: Arrival<Item>,
  signal: AbortSignal | undefined,
): AsyncGenerator<Item, undefined> {
  let read = 0;
  let wake: (() => void) | undefined;
  let giveUp: ((stop: unknown) => void) | undefined;
  let unfollow: (() => void) | undefined;
  const park = (resolve: () => void, reject: (stop: unknown) => void) => {
    wake = resolve;
    giveUp = reject;
  };

  function follow(): () => void {
    const unsubscribe = onArrival(() => wake?.());
    const unwatch =
      signal === undefined
        ? undefined
        : onAbort(
            signal,
            () => giveUp?.(stopReason(signal.reason)),
            'afterTurn',
          );
    return () => {
      unsubscribe();
      unwatch?.();
    };
  }

  try {
    while (true) {
      const item = buffer[read];
      if (item !== undefined) {
        read += 1;
        yield item;
        continue;
      }
      const now = state();
      if (now.at === 'finished') return;
      if (now.at === 'failed') throw now.error();
      unfollow ??= follow();
      await new Promise<void>(park);
    }
  } finally {
    unfollow?.();
  }
}
