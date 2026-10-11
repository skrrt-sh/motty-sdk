import type { Progress, RunStream } from '../contract.ts';
import {
  disclosed,
  type ErrorFacts,
  stopReason,
  toFacts,
} from '../data/errors.ts';
import {
  isTerminal,
  type StreamEvent,
  type Terminal,
  type Usage,
} from '../data/event.ts';
import { type Answer, ending, sentWith } from '../request/answer.ts';
import {
  endPhase,
  phaseStopper,
  type RequestState,
} from '../request/context.ts';
import { progress } from '../request/think.ts';
import { onAbort } from '../request/wait.ts';
import type { Outcome } from './builder.ts';

type Sent = StreamEvent | Progress;

type SentRead = IteratorResult<Sent, undefined>;

type Phase = { at: 'open' } | { at: 'stopped' } | { at: 'ended' };

// The whole error, for the host: the caller is told it without its stack
// and cause, and one who left is told nothing.
export type Ended = { outcome: Outcome; error?: ErrorFacts };

export type Delivery = {
  stream: RunStream;
  answered: (answer: Answer) => Promise<Ended>;
  failed: (thrown: unknown) => Promise<Ended>;
};

export function delivery(state: RequestState): Delivery {
  const stopPhase = phaseStopper();
  const { signal, calls } = state;
  const stage = progress(state, () => {
    pumping = pump();
  });
  const offered: { event: Sent; taken: (reached: boolean) => void }[] = [];
  const asking: ((read: SentRead) => void)[] = [];
  let phase: Phase = { at: 'open' };
  let pumping: Promise<void> | undefined;
  let reason: ErrorFacts | undefined;

  function failure(error: ErrorFacts): Terminal {
    return {
      type: 'error',
      error: disclosed(error),
      usage: { ...calls.total },
    };
  }

  // Read once: the caller and the host are told of the one stop.
  function why(): ErrorFacts {
    reason ??= toFacts(stopReason(signal.reason));
    return reason;
  }

  function stopRead(): SentRead {
    return { done: false, value: failure(why()) };
  }

  function drop(): void {
    if (offered.length === 0) return;
    for (const offer of offered.splice(0)) offer.taken(false);
  }

  function endStream(): void {
    phase = { at: 'ended' };
    drop();
    if (asking.length === 0) return;
    for (const give of asking.splice(0)) give({ done: true, value: undefined });
  }

  function onStop(): void {
    switch (phase.at) {
      case 'open': {
        const give = asking.shift();
        if (give === undefined) {
          drop();
          phase = { at: 'stopped' };
        } else {
          give(stopRead());
          endStream();
        }
        return;
      }
      case 'stopped':
      case 'ended':
        return;
      default:
        phase satisfies never;
    }
  }

  function delivered(event: Sent): Promise<boolean> {
    switch (phase.at) {
      case 'open': {
        const give = asking.shift();
        if (give === undefined) {
          return new Promise((taken) => {
            offered.push({ event, taken });
          });
        }
        give({ done: false, value: event });
        if (isTerminal(event)) endStream();
        return Promise.resolve(true);
      }
      case 'stopped':
      case 'ended':
        return Promise.resolve(false);
      default:
        return phase satisfies never;
    }
  }

  function next(): Promise<SentRead> {
    switch (phase.at) {
      case 'open': {
        const offer = offered.shift();
        if (offer === undefined) {
          return new Promise((give) => {
            asking.push(give);
          });
        }
        const { event, taken } = offer;
        if (isTerminal(event)) endStream();
        taken(true);
        return Promise.resolve({ done: false, value: event });
      }
      case 'stopped':
        endStream();
        return Promise.resolve(stopRead());
      case 'ended':
        return Promise.resolve({ done: true, value: undefined });
      default:
        return phase satisfies never;
    }
  }

  function left(): Promise<SentRead> {
    switch (phase.at) {
      case 'open':
      case 'stopped':
        endStream();
        stopPhase();
        break;
      case 'ended':
        break;
      default:
        phase satisfies never;
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  async function pump(): Promise<void> {
    for await (const { piece, text } of stage.pieces) {
      await delivered({ type: 'progress', piece, text });
    }
  }

  // Every line offered so far still goes out ahead of the answer.
  async function closed(): Promise<void> {
    stage.close();
    await pumping;
  }

  // The phase ends ahead of the terminal event, so the usage a caller is told
  // counts every call, as the record does. Whatever stopped the request, it
  // did not complete and did not fail.
  async function last(
    built?: (usage: Usage) => Terminal,
    error?: ErrorFacts,
  ): Promise<Ended> {
    unfollow();
    await endPhase();
    if (built === undefined || !(await delivered(built({ ...calls.total })))) {
      return { outcome: 'aborted', error: why() };
    }
    return error === undefined
      ? { outcome: 'completed' }
      : { outcome: 'failed', error };
  }

  function failed(thrown: unknown): Promise<Ended> {
    const error = toFacts(thrown);
    return last(() => failure(error), error);
  }

  // Told at once, so the caller hears of the stop ahead of whatever the
  // stopped work throws.
  const unfollow = onAbort(signal, onStop, 'atOnce');
  const reader: AsyncIterator<Sent, undefined> = { next, return: left };

  return {
    stream: { [Symbol.asyncIterator]: () => reader },
    answered: async (answer) => {
      await closed();
      try {
        for await (const chunk of answer.chunks()) {
          if (!(await delivered(chunk))) return last();
        }
        const finish = await ending(answer);
        return last((usage) => sentWith(finish, usage));
      } catch (thrown) {
        return failed(thrown);
      }
    },
    failed: async (thrown) => {
      await closed();
      return failed(thrown);
    },
  };
}
