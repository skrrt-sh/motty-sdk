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
  let stopped = false;
  let wake: (() => void) | undefined;
  let unfollow: (() => void) | undefined;
  let unwatch: (() => void) | undefined;
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
      unfollow ??= onArrival(() => wake?.());
      // Followed once and the stop kept, so a stop told while no read waited
      // still ends the next one.
      unwatch ??=
        signal &&
        onAbort(
          signal,
          () => {
            stopped = true;
            wake?.();
          },
          'afterTurn',
        );
      if (!stopped) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (stopped) throw stopReason(signal?.reason);
    }
  } finally {
    unfollow?.();
    unwatch?.();
  }
}
