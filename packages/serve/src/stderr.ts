import {
  type ErrorFacts,
  type HostOptions,
  type Report,
  toFacts,
} from '@mottyjs/core/host';

type Send = NonNullable<HostOptions['report']>;

// What a Worker writes at global scope, where a mount runs, reaches no log, so
// there it is held for the mount's first request. Elsewhere it goes at once, for
// an operator to see before any traffic.
export function heldAtStart(): string[] | undefined {
  return typeof navigator !== 'undefined' &&
    navigator.userAgent === 'Cloudflare-Workers'
    ? []
    : undefined;
}

// A message may be as long as a body and hold anything: one line of it is all
// that is written.
export function plain(message: string): string {
  return message.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').slice(0, 1000);
}

function line(id: string, service: string, message: string) {
  console.error(`motty: request ${id}: ${service}: ${plain(message)}`);
}

// The words the host's failed services are told to the motty in: what they
// say is on the report by the service, in its own words.
const sealed = /^The (?:host's \w+|model call to .+) failed$/;

function recordError(report: Report, error: ErrorFacts): void {
  const { id, part, failed } = report;
  // A caller who left is no failure, whatever else stopped the request is. Nor
  // is one the motty refused, or anyone with a bad token could fill the host's
  // log. An upstream's refusal and a name no adapter serves stay, as the host
  // may have wired it wrong.
  if (error.code === 'aborted') return;
  if (
    error.upstream !== true &&
    error.code !== 'unknownModel' &&
    (error.status ?? 500) < 500
  ) {
    return;
  }
  if (failed !== undefined && sealed.test(error.message)) return;
  // In the core's words: an upstream that knows no such model says so in its
  // own, having been reached by an adapter that serves the name.
  if (
    error.code === 'unknownModel' &&
    error.message.startsWith('No model named ')
  ) {
    line(
      id,
      'models',
      `${error.message}: no adapter of this host serves that name`,
    );
    return;
  }
  line(
    id,
    error.upstream === true ? 'models' : (part ?? 'motty'),
    error.message,
  );
}

function written(report: Report): void {
  const { id, error, failed, afterResponse } = report;
  if (error !== undefined) recordError(report, error);
  if (failed !== undefined) {
    for (const { service, error: told } of failed) {
      line(id, service, told.message);
    }
  }
  for (const { part, error: told } of afterResponse.failed) {
    line(id, part, told.message);
  }
}

function lost(report: Report, thrown: unknown): void {
  line(
    report.id,
    'report',
    `The host's report failed, so it lost this record: ${toFacts(thrown).message}`,
  );
  written(report);
}

// Without a report of the host's the failures go to stderr, and with one that
// fails, the record it lost. Nothing is read of a request that went well but
// the three fields that would have held a failure.
export function reporting(send: Send | undefined): Send {
  if (send === undefined) return written;
  return (report) => {
    try {
      return Promise.resolve(send(report)).catch((thrown: unknown) =>
        lost(report, thrown),
      );
    } catch (thrown) {
      lost(report, thrown);
      return undefined;
    }
  };
}

// A throw at the edge that no record will hold. What was meant for the caller
// is no failure of the host's.
export function unrecorded(facts: ErrorFacts, id?: string): void {
  if (facts.unexpected !== true) return;
  if (id !== undefined) line(id, 'the reply', facts.message);
  else
    console.error(`motty: a request with no record: ${plain(facts.message)}`);
}
