import { wait } from './wait.ts';

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
  let unfollow: (() => void) | undefined;
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
      // Each wait follows the signal itself: a stop told while no read
      // waited would be lost to the next one.
      const arrived = new Promise<void>((resolve) => {
        wake = resolve;
      });
      await (signal === undefined ? arrived : wait(arrived, signal));
    }
  } finally {
    unfollow?.();
  }
}
