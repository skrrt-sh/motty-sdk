import { InvalidRequest } from '@mottyjs/core';
import type { Options } from '@mottyjs/core/host';
import { chatCompletions, messages, responses } from '@mottyjs/serve';

const never = new Set([
  // The connection's own: the runtime writes these for the request it
  // makes, and another request's get a refusal or a wait with no end.
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
  // A credential: the upstream is sent the adapter's and nobody else's.
  ...[chatCompletions, responses, messages].flatMap(
    (codec) => codec.credentials,
  ),
  'proxy-authorization',
  'cookie',
  'set-cookie',
  // Where a request came from, which is not the upstream's to see, and
  // which an upstream that signs its requests refuses.
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
  // Said of another body than the one the adapter writes.
  'digest',
]);

// An edge's or a browser's account of where a request came from, and the
// last what is said of another body.
const families = ['x-forwarded', 'x_forwarded', 'cf-', 'sec-', 'content-'];

// A header the connection states is the host's, as the credential is: the
// call's of that name is left out, so it neither replaces nor joins it.
export function passed(
  prefix: string,
  held: Headers,
  keyHeader: string | undefined,
  headers: NonNullable<Options['headers']>,
) {
  const own = keyHeader?.toLowerCase();
  const sent = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      never.has(lower) ||
      lower === own ||
      families.some((family) => lower.startsWith(family))
    ) {
      continue;
    }
    try {
      if (!held.has(name)) sent.set(name, value);
    } catch {
      throw new InvalidRequest(
        `The ${prefix} adapter was given a header no request can carry: ${name}`,
      );
    }
  }
  return sent;
}
