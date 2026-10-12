import type { Finish } from '../data/event.ts';
import type { Options } from '../data/message.ts';

// Every header one of the wire APIs takes a credential in, in lower case. A
// token in one of them reaches no motty and no upstream but the host's own.
export const credentials: readonly string[] = [
  'authorization',
  'api-key',
  'x-api-key',
];

const never = new Set([
  // The runtime writes these for the request it makes, and another
  // request's get a refusal or a wait with no end.
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'accept-encoding',
  // The upstream is sent the connection's credential and nobody else's.
  ...credentials,
  'proxy-authorization',
  'cookie',
  'set-cookie',
  // Said of another body than the one the request carries.
  'digest',
]);
const body = 'content-';

// Where a request came from, which is the host's alone to pass on, and
// which an upstream that signs its requests refuses.
const origins = new Set([
  'forwarded',
  'via',
  'origin',
  'referer',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'fly-client-ip',
  'fastly-client-ip',
  'cdn-loop',
  'x-original-forwarded-for',
  'x-envoy-external-address',
]);
const prefixes = ['x-forwarded', 'x_forwarded', 'cf-', 'sec-'];

type Stated = NonNullable<Options['headers']>;

// RFC 9110 section 7.6.1 has whoever passes a request on remove the fields
// its Connection header names.
function nominated(stated: Stated): string[] {
  return Object.entries(stated).flatMap(([name, value]) =>
    name.toLowerCase() === 'connection'
      ? (value ?? '').split(',').map((token) => token.trim().toLowerCase())
      : [],
  );
}

function fits(name: string, value: string): boolean {
  try {
    new Headers().set(name, value);
    return true;
  } catch {
    return false;
  }
}

// Thrown plain, since the header was written by the motty's own code and
// not by its caller. The value may be a secret, so only the name is quoted.
function checked(name: string, value: string): void {
  if (fits(name, value)) return;
  throw new Error(
    `A call stated the header ${JSON.stringify(name)} with a ${fits(name, '') ? 'value' : 'name'} no request can carry`,
  );
}

// Naming an origin header is the host's choice and forwarding any is not
// one, and a header the request already has is the host's or the API's.
export function forwarded(
  stated: Stated,
  allowed: readonly string[] | true = [],
  taken: readonly string[] = [],
) {
  const open =
    allowed === true || new Set(allowed.map((name) => name.toLowerCase()));
  const held = new Set(taken.map((name) => name.toLowerCase()));
  const hops = new Set(nominated(stated));
  const headers: [string, string][] = [];
  const leftOut = new Map<string, NonNullable<Finish['warnings']>[number]>();
  for (const [name, value] of Object.entries(stated)) {
    if (value === undefined || value === null) continue;
    checked(name, value);
    const lower = name.toLowerCase();
    const detail =
      never.has(lower) ||
      hops.has(lower) ||
      lower.startsWith(body) ||
      (open === true &&
        (origins.has(lower) ||
          prefixes.some((prefix) => lower.startsWith(prefix))))
        ? 'A call never sends this header'
        : open !== true && !open.has(lower)
          ? 'The connection does not forward this header'
          : held.has(lower)
            ? 'The connection or the API states this header itself'
            : undefined;
    if (detail === undefined) headers.push([name, value]);
    else leftOut.set(lower, { setting: `headers.${lower}`, detail });
  }
  // Made from entries, a header named as the prototype is one like any other.
  return {
    headers: Object.fromEntries(headers),
    leftOut: [...leftOut.values()],
  };
}
