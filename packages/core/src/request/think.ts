import { type Answer, arrival, isAnswer } from './answer.ts';
import { type RequestState, running } from './context.ts';
import { readOut } from './wait.ts';

type Delta = { piece: number; text: string };

type Forwarded = {
  readonly piece: number;
  readonly from: ReturnType<typeof arrival>;
  read: number;
  unfollow?: () => void;
};

// A forwarded answer is read from what has arrived of it and never waited
// on, so what goes out does not depend on who read it when.
type Offer = { readonly piece: number; readonly text: string } | Forwarded;

type Stage = {
  offer: (progress: string | Answer) => void;
  pieces: AsyncIterable<Delta>;
  close: () => void;
};

type Staging = { stage?: Stage; closed: boolean; begun?: () => void };

const stages = new WeakMap<RequestState, Staging>();

function nextArrivedText(offer: Forwarded): string | undefined {
  const { buffer } = offer.from;
  while (offer.read < buffer.length) {
    const chunk = buffer[offer.read];
    offer.read += 1;
    if (chunk?.type === 'text') return chunk.text;
  }
  return undefined;
}

function staged(): Stage {
  const offered: Offer[] = [];
  const asking: ((result: IteratorResult<Delta, undefined>) => void)[] = [];
  let taken = 0;
  let phase: 'open' | 'draining' | 'closed' = 'open';

  function advance(): void {
    while (asking.length > 0) {
      const [offer] = offered;
      if (offer === undefined) {
        if (phase === 'open') return;
        phase = 'closed';
        asking.shift()?.(readOut);
        continue;
      }
      if ('text' in offer) {
        offered.shift();
        asking.shift()?.({ done: false, value: offer });
        continue;
      }
      const text = nextArrivedText(offer);
      if (text !== undefined) {
        asking.shift()?.({ done: false, value: { piece: offer.piece, text } });
      } else if (offer.from.state().at !== 'arriving') {
        offer.unfollow?.();
        offered.shift();
      } else {
        offer.unfollow ??= offer.from.onArrival(advance);
        return;
      }
    }
  }

  function cutShort(): void {
    if (phase !== 'open') return;
    phase = 'draining';
    for (const offer of offered.splice(0)) {
      if ('text' in offer) {
        offered.push(offer);
        continue;
      }
      offer.unfollow?.();
      for (let text = nextArrivedText(offer); text !== undefined; ) {
        offered.push({ piece: offer.piece, text });
        text = nextArrivedText(offer);
      }
    }
    advance();
  }

  function leave(): void {
    phase = 'closed';
    for (const offer of offered.splice(0)) {
      if (!('text' in offer)) offer.unfollow?.();
    }
    advance();
  }

  const reader: AsyncIterator<Delta, undefined> = {
    next: () =>
      new Promise((resolve) => {
        asking.push(resolve);
        if (asking.length === 1) advance();
      }),
    return: async () => {
      leave();
      return readOut;
    },
  };

  return {
    offer: (progress) => {
      if (phase !== 'open') return;
      // Offers leave in the order they came, so each keeps the number it
      // took when offered.
      const piece = taken;
      taken += 1;
      offered.push(
        typeof progress === 'string'
          ? { piece, text: progress }
          : { piece, from: arrival(progress), read: 0 },
      );
      advance();
    },
    pieces: { [Symbol.asyncIterator]: () => reader },
    close: cutShort,
  };
}

// The stage is set up at the first offer or the first read, so a request
// that offers no progress pays for none.
function entryOf(state: RequestState): Staging {
  const found = stages.get(state);
  if (found !== undefined) return found;
  const entry: Staging = { closed: false };
  stages.set(state, entry);
  return entry;
}

function stageOf(entry: Staging): Stage {
  if (entry.stage !== undefined) return entry.stage;
  entry.stage = staged();
  if (entry.closed) entry.stage.close();
  else entry.begun?.();
  return entry.stage;
}

export function think(progress: string | Answer): void {
  // Past the types anything may come: only a line or an answer is progress.
  if (typeof progress === 'string' ? progress === '' : !isAnswer(progress)) {
    return;
  }
  const state = running();
  if (state === undefined) return;
  const entry = entryOf(state);
  if (!entry.closed) stageOf(entry).offer(progress);
}

export function progress(
  state: RequestState,
  begun?: () => void,
): {
  pieces: AsyncIterable<{ piece: number; text: string }>;
  close: () => void;
} {
  const entry = entryOf(state);
  if (begun !== undefined) entry.begun = begun;
  return {
    pieces: {
      [Symbol.asyncIterator]: () =>
        stageOf(entry).pieces[Symbol.asyncIterator](),
    },
    close: () => {
      entry.closed = true;
      entry.stage?.close();
    },
  };
}
