import type {
  ErrorFacts,
  Json,
  KnownCode,
  ProviderData,
} from '@mottyjs/core/host';
import {
  copied,
  type Dict,
  dict,
  given,
  isDict,
  list,
  parsed,
  text,
} from './json.ts';
import { shouldRetry } from './retry-after.ts';

const longest = 300;

function specific(raw: Json | undefined): string | undefined {
  const read = typeof raw === 'string' ? (parsed(raw) ?? raw) : raw;
  if (read === undefined || read === null) return undefined;
  if (typeof read === 'string') return read.trim() || undefined;
  const { error, message } = dict(read);
  const { message: inner } = dict(error);
  return text(inner) ?? text(message) ?? text(error) ?? JSON.stringify(read);
}

// A router may say only that its provider refused and put what the provider
// said beside it, as `raw`: text, or JSON that may hold a message of its own.
export function detailed(
  message: string | undefined,
  ...beside: (Json | undefined)[]
): string | undefined {
  for (const metadata of beside) {
    const { raw } = dict(metadata);
    const whole = specific(raw);
    if (whole !== undefined && whole !== message) return whole;
  }
  return undefined;
}

function joined(
  message: string | undefined,
  detail: string | undefined,
): string | undefined {
  // A provider's reply may be a page, and the caller reads its opening.
  const opening = detail?.slice(0, longest);
  if (opening === undefined) return message;
  return message === undefined ? opening : `${message}: ${opening}`;
}

// Not every upstream tells a failure in its family's shape: the error may
// be a sentence where the family has an object.
export function raised(error: Json | undefined): Dict {
  if (typeof error !== 'string') return dict(error);
  return error.trim() === '' ? {} : { message: error };
}

// What a validator refused comes as a list of where and what. Entries are
// told whole while the text stays short, the first whatever its length, so
// a name in one is still whole when it is cut.
function listed(detail: Json | undefined): string | undefined {
  let told: string | undefined;
  for (const entry of list(detail)) {
    const { loc, msg } = dict(entry);
    const what = text(msg);
    if (what === undefined) continue;
    const where = list(loc)
      .filter((step) => typeof step === 'string' || typeof step === 'number')
      .join('.');
    const one = where === '' ? what : `${where}: ${what}`;
    const next = told === undefined ? one : `${told}; ${one}`;
    if (told !== undefined && next.length > longest) break;
    told = next;
  }
  return told;
}

// Words at the top of a body that holds no error are still what was said.
// They name no model, so a 404 with them stays a wrong address. A list
// they were made from goes beside them, for the record.
export function loose(body: Dict): Dict {
  const { error, message, detail } = body;
  if ((error ?? null) !== null) return {};
  const said = text(message) ?? text(detail);
  if (said !== undefined) return { message: said };
  const told = listed(detail);
  return told === undefined ? {} : given({ message: told, detail });
}

// A provider's own table, read before its wire family's: given the status,
// the headers and the error it sent, it names the failure or leaves it.
export type FailureReader = (
  status: number | undefined,
  headers: Headers,
  error: Dict,
) =>
  | ({ code: KnownCode } & Pick<ErrorFacts, 'retryable' | 'retryAfter'>)
  | undefined;

// What in a provider's failure names the host's account, and what stands in
// its place. A bare one is the name alone, with none of the words around it.
export type Cut = { pattern: RegExp; replacement: string; bare?: true };

// A request told back to the caller may hold a name of the caller's own in
// the shape of an account's, so there a name is cut only by its words.
function echoed(code: KnownCode): boolean {
  return (
    code === 'invalid_request' ||
    code === 'unsupported' ||
    code === 'context_too_long' ||
    code === 'unknown_model'
  );
}

// A name cut with nothing in its place takes with it the one space it
// would leave doubled, or standing before a closing mark.
function lifted({ pattern, replacement, bare }: Cut): RegExp {
  if (bare !== true || replacement !== '') return pattern;
  const { source, flags } = pattern;
  return new RegExp(
    `(?<= )(?:${source}) | (?:${source})(?=[.,;:!?)])|${source}`,
    flags,
  );
}

function nameless(
  said: string | undefined,
  cuts: readonly Cut[],
  worded: boolean,
): string | undefined {
  return cuts.reduce(
    (left, cut) =>
      worded && cut.bare === true
        ? left
        : left?.replace(lifted(cut), cut.replacement),
    said,
  );
}

const largest = 2000;

// Fields are kept in the order they came while the whole stays small.
function bounded(fields: Dict, each: (held: Json) => Json): Dict {
  const kept: [string, Json][] = [];
  let size = 0;
  for (const [name, held] of Object.entries(fields)) {
    const cut = each(held);
    size += name.length + JSON.stringify(cut).length;
    if (size > largest) break;
    kept.push([name, cut]);
  }
  // Made from entries, a name that is the prototype's is a field like any.
  return Object.fromEntries(kept);
}

function capped(value: Json, fields: boolean): Json {
  if (JSON.stringify(value).length <= longest) return value;
  if (fields && isDict(value)) {
    return bounded(value, (held) => capped(held, false));
  }
  const source = typeof value === 'string' ? value : JSON.stringify(value);
  return source.slice(0, longest);
}

// What is the host's alone in an upstream's words is known to whoever holds
// the connection, who hands over what removes it. It runs over all that was
// said before any of it is shortened, so no cap leaves a part behind.
export type Clean = (text: string) => string;

export function cleaned(
  said: string | undefined,
  clean: Clean | undefined,
): string | undefined {
  return said === undefined || clean === undefined ? said : clean(said);
}

// An upstream may echo a secret as a field's name, so a name is cleaned as
// a value is. Two names made equal are both kept, the later numbered.
function renamed(fields: Dict, clean: Clean): Dict {
  const kept = new Map<string, Json>();
  for (const [name, held] of Object.entries(fields)) {
    const shown = clean(name);
    let free = shown;
    for (let nth = 2; kept.has(free); nth += 1) free = `${shown} ${nth}`;
    kept.set(free, cleared(held, clean));
  }
  return Object.fromEntries(kept);
}

function cleared(value: Json, clean: Clean): Json {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map((item) => cleared(item, clean));
  return isDict(value) ? renamed(value, clean) : value;
}

// All the error says beside its message goes to the record. A router may
// put its provider's whole reply there, so what is long is cut short, and
// so is an error of more fields than a record is worth.
export function stated(error: Dict, clean?: Clean): Dict {
  const { message: _, ...beside } = error;
  return bounded(
    clean === undefined ? beside : renamed(beside, clean),
    (held) => capped(held, true),
  );
}

function numbered(status: number | undefined, said: boolean): KnownCode {
  switch (status) {
    // The key is the host's, so the caller did nothing wrong.
    case 401:
    case 403:
      return 'upstream_refused';
    case 402:
      return 'quota_exceeded';
    // An API names the model it does not know; a wrong address names nothing.
    case 404:
      return said ? 'unknown_model' : 'upstream_failed';
    case 408:
    case 504:
    case 524:
      return 'timed_out';
    case 429:
      return 'rate_limited';
    case 498:
    case 503:
    case 529:
      return 'overloaded';
    default:
      return status !== undefined && status >= 400 && status < 500
        ? 'invalid_request'
        : 'upstream_failed';
  }
}

// What the upstream said is the host's to read whole, so where the caller
// is told less or other than that, it is kept in the record of each family.
function kept(record: ProviderData, message: string | undefined): ProviderData {
  if (message === undefined) return record;
  return Object.fromEntries(
    Object.entries(record).map(([key, held]) => [
      key,
      { ...dict(copied(held)), message },
    ]),
  );
}

const link = /(?:https?:\/\/|www\.)\S/i;

// A spent balance and a rate limit are told with a link into the host's
// account. The caller is told the sentences that hold none, never part of
// one that does, and no question that only leads into one.
function linkless(message: string): string | undefined {
  const clean: string[] = [];
  let left = false;
  for (const sentence of message.split(/(?<=[.!?])\s+/).reverse()) {
    if (sentence.trim() === '') continue;
    left = link.test(sentence) || (left && sentence.endsWith('?'));
    if (!left) clean.push(sentence);
  }
  return clean.length > 0 ? clean.reverse().join(' ') : undefined;
}

// No provider's own message is this long, so one that is longer is told
// up to its last whole sentence, or else its last whole word.
function short(message: string): string {
  if (message.length <= largest) return message;
  const head = message.slice(0, largest + 1);
  return (
    /^.*[.!?](?=\s)/s.exec(head)?.[0] ??
    /^.*\S(?=\s)/s.exec(head)?.[0] ??
    head.slice(0, largest)
  );
}

// The most specific thing said names the failure: the provider's own table,
// then the family's, then a status the error holds where none was sent, then
// the status. One nothing names is not worth another try unless a server's.
export function upstreamFailure(
  told: {
    code: KnownCode | undefined;
    message: string | undefined;
    detail?: string;
    record: ProviderData;
    retryable?: boolean;
    error?: Dict;
    headers?: Headers;
  },
  status?: number,
  retryAfter?: number,
  byProvider?: FailureReader,
  cuts?: readonly Cut[],
): ErrorFacts {
  const { error = {}, headers = new Headers() } = told;
  const own = byProvider?.(status, headers, error);
  const { code: held } = error;
  // A status in the error may be written as text.
  const inner =
    typeof held === 'string' && /^\d{3}$/.test(held) ? Number(held) : held;
  const sent =
    (status !== undefined && status >= 400) ||
    typeof inner !== 'number' ||
    inner < 400 ||
    inner > 599
      ? status
      : inner;
  const named = own?.code ?? told.code;
  const code = named ?? numbered(sent, Object.keys(error).length > 0);
  const server = sent !== undefined && sent >= 500;
  const unnamed = named === undefined && code === 'upstream_failed' && !server;
  // What the upstream says of another try outranks what its kind implies,
  // but no flag brings back a quota that is spent or mends the host's key.
  const flag =
    own?.retryable ??
    shouldRetry(headers) ??
    told.retryable ??
    (unnamed ? false : undefined);
  const lasting = code === 'quota_exceeded' || code === 'upstream_refused';
  const retryable = lasting && flag === true ? undefined : flag;
  const wait = own?.retryAfter ?? retryAfter;
  // The host's key was turned down, which is not the caller's 401 to see.
  const refused = code === 'upstream_refused';
  const whole = joined(told.message, told.detail);
  const spent = code === 'quota_exceeded';
  // A name is cut from all that was said, so no cap can leave half of one.
  const cut =
    cuts === undefined
      ? whole
      : joined(
          nameless(told.message, cuts, echoed(code)),
          nameless(told.detail, cuts, echoed(code)),
        );
  const linked =
    (spent || code === 'rate_limited') && cut !== undefined
      ? (linkless(cut) ??
        (spent
          ? "The upstream's account has no quota left for this request"
          : "The upstream's rate limit has no room left for this request"))
      : cut;
  // A message that was nothing but a name says nothing.
  const said =
    linked === undefined || linked.trim() === '' ? undefined : short(linked);
  // Only a request the caller got wrong keeps the status that says how; any
  // other kind answers with its own, whatever the upstream chose for it.
  const shown =
    code === 'invalid_request' && numbered(sent, true) === 'invalid_request';
  return {
    code,
    ...(shown && sent !== undefined ? { status: sent } : {}),
    message: refused
      ? "The upstream refused the host's credentials or account"
      : (said ??
        (status === undefined
          ? 'The upstream answered with an error'
          : `The upstream answered ${status}`)),
    ...(retryable === undefined ? {} : { retryable }),
    ...(wait === undefined ? {} : { retryAfter: wait }),
    provider:
      refused || said !== whole ? kept(told.record, whole) : told.record,
    upstream: true,
  };
}
