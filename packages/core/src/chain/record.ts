import type { Host, RequestRecord } from '../contract.ts';
import type { Calls } from '../request/context.ts';
import type { Ended } from './delivery.ts';

// Exists only for a host that asked for the record, so a request without one
// collects and times nothing.
export type Trace = {
  readonly send: NonNullable<Host['record']>;
  readonly begun: number;
  readonly entries: string[];
  readonly afterResponse: RequestRecord['afterResponse'];
  threw?: { readonly part: string; readonly thrown: unknown };
  answer?: {
    readonly ended: Ended;
    readonly path: readonly string[] | undefined;
    readonly early: string | undefined;
    readonly ms: number;
  };
};

export function tracing(record: Host['record']): Trace | undefined {
  if (record === undefined) return undefined;
  return {
    send: record,
    begun: performance.now(),
    entries: [],
    afterResponse: { failed: [], skipped: [], unreached: [] },
  };
}

// A throw passes every step around the one it came from: the first step to
// see it is the one that threw.
export function threw(
  trace: Trace | undefined,
  part: string,
  thrown: unknown,
): void {
  if (trace === undefined) return;
  if (trace.threw !== undefined && trace.threw.thrown === thrown) return;
  trace.threw = { part, thrown };
}

// A recovered throw is over: the same value thrown again is a new throw.
export function caught(trace: Trace | undefined): void {
  if (trace !== undefined) delete trace.threw;
}

// No path means nothing answered.
export function answered(
  trace: Trace | undefined,
  ended: Ended,
  path: readonly string[] | undefined,
  early: string | undefined,
): void {
  if (trace === undefined) return;
  trace.answer = { ended, path, early, ms: performance.now() - trace.begun };
}

export function recorded(trace: Trace | undefined, calls: Calls): void {
  if (trace?.answer === undefined) return;
  const { ended, path, early, ms } = trace.answer;
  const { outcome, error } = ended;
  const part =
    path === undefined && outcome === 'failed' ? trace.threw?.part : early;
  const record: RequestRecord = {
    outcome,
    ...(error === undefined ? {} : { error }),
    path: [...(path ?? [])],
    entries: trace.entries,
    ...(part === undefined ? {} : { part }),
    calls: calls.made.map((call): RequestRecord['calls'][number] => ({
      ...call,
    })),
    usage: { ...calls.total },
    answerMs: ms,
    totalMs: performance.now() - trace.begun,
    afterResponse: trace.afterResponse,
  };
  try {
    Promise.resolve(trace.send(record)).catch(() => {});
  } catch {}
}
