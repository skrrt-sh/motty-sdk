import {
  type ErrorFacts,
  type HostOptions,
  type Report,
  toFacts,
} from '@mottyjs/core/host';
import { environment } from '#environment';

type Send = NonNullable<HostOptions['report']>;

const mask = '[held]';

// What a Worker writes at global scope, where a mount runs, reaches no log, so
// there it is held for the mount's first request. Elsewhere it goes at once, for
// an operator to see before any traffic.
export function heldAtStart(): string[] | undefined {
  return typeof navigator !== 'undefined' &&
    navigator.userAgent === 'Cloudflare-Workers'
    ? []
    : undefined;
}

// What reads as a credential whatever it belongs to, a long run of a token's
// alphabet last: the host's keys are in no list the edge can read.
const credentials =
  /bearer\s+\S+|\bsk-[\w-]+|\/\/[^\s/:@]*:[^\s/@]+@|\b[\w-]*(?:key|token|secret|password)=[^\s&]+|[\w.~+=-]{32,}/gi;

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function leaves(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  return typeof value === 'object' && value !== null
    ? Object.values(value).flatMap(leaves)
    : [];
}

// A key held in the environment has no shape to know it by. A short value
// there may be anything and says little, so only a long one is looked for.
function heldInEnvironment(): string[] {
  const held: { [name: string]: string | undefined } = environment();
  return Object.values(held).flatMap((value) =>
    value !== undefined && value.length >= 8 ? [value] : [],
  );
}

// A short value is taken only as a word of its own, or a threshold of 2 would
// take the bound out of "at most 20". The longest first, so a value that holds
// another goes whole.
function unheld(message: string, held: unknown): string {
  let said = message;
  for (const value of [...leaves(held), ...heldInEnvironment()].sort(
    (left, right) => right.length - left.length,
  )) {
    if (value.length >= 8) said = said.replaceAll(value, mask);
    else if (value !== '') {
      said = said.replace(
        new RegExp(`(?<![\\w.])${escaped(value)}(?![\\w.])`, 'g'),
        mask,
      );
    }
  }
  return said;
}

// A message may hold whatever its thrower read, and be as long as a body: one
// line of it, with nothing a host held in it, is all that is written.
export function plain(message: string, held?: unknown): string {
  return unheld(message.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' '), held)
    .replace(credentials, mask)
    .slice(0, 1000);
}

function line(id: string, service: string, message: string, held?: unknown) {
  console.error(`motty: request ${id}: ${service}: ${plain(message, held)}`);
}

// The words the host's failed services are told to the motty in: what they
// say is on the report by the service, in its own words.
const sealed = /^The (?:host's \w+|model call to .+) failed$/;

function recordError(report: Report, error: ErrorFacts): void {
  const { id, part, settings, failed } = report;
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
      settings,
    );
    return;
  }
  line(
    id,
    error.upstream === true ? 'models' : (part ?? 'motty'),
    error.message,
    settings,
  );
}

function written(report: Report): void {
  const { id, error, settings, failed, afterResponse } = report;
  if (error !== undefined) recordError(report, error);
  if (failed !== undefined) {
    for (const { service, error: told } of failed) {
      line(id, service, told.message, settings);
    }
  }
  for (const { part, error: told } of afterResponse.failed) {
    line(id, part, told.message, settings);
  }
}

function lost(report: Report, thrown: unknown): void {
  line(
    report.id,
    'report',
    `The host's report failed, so it lost this record: ${toFacts(thrown).message}`,
    report.settings,
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
