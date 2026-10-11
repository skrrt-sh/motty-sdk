import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import type { AuthAdapter } from '@mottyjs/core/host';
import {
  createRemoteJWKSet,
  errors,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
  jwtVerify,
} from 'jose';

// Exactly one way to check the signature: the address of a key set, a public
// key in PEM or a shared secret. Every further check is the host's to name.
export type JwtOptions = JWTVerifyOptions &
  (
    | { jwksAddress: string | undefined; publicKey?: never; secret?: never }
    | { publicKey: string | undefined; jwksAddress?: never; secret?: never }
    | { secret: string | undefined; jwksAddress?: never; publicKey?: never }
  );

function given(adapter: string, option: string, value: string | undefined) {
  if (value === undefined || value === '') {
    throw new Error(`The ${adapter} adapter was given no ${option}`);
  }
  return value;
}

// A key set that cannot be read is the host's failure, so it throws: "no
// caller" would tell a caller with a valid token to sign in again. The errors
// are kept here to tell them from everything a token can cause.
const unread = new WeakSet<Error>();

// The address may hold a token, so no refusal quotes it, and what a runtime
// threw while fetching, which may, is not kept as the cause.
function keySet(address: string): JWTVerifyGetKey {
  const url = URL.parse(address);
  if (url === null) {
    throw new Error('The jwt adapter was given a jwksAddress that is none');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      'The jwt adapter was given a jwksAddress that holds credentials',
    );
  }
  const read = createRemoteJWKSet(url);
  return (header, signed) =>
    read(header, signed).catch((cause: unknown) => {
      if (
        cause instanceof errors.JWKSNoMatchingKey ||
        cause instanceof errors.JWKSMultipleMatchingKeys ||
        cause instanceof errors.JOSENotSupported
      ) {
        throw cause;
      }
      const error = new Error(
        'The key set could not be read',
        cause instanceof errors.JOSEError ? { cause } : {},
      );
      unread.add(error);
      throw error;
    });
}

// What a runtime says of text it cannot read may quote it, and a host may
// have set a private key here by mistake, so the refusal is our own words.
function pem(text: string) {
  try {
    return createPublicKey(text);
  } catch {
    throw new Error(
      'The jwt adapter was given a publicKey that is no public key in PEM',
    );
  }
}

// A token that states no expiry is accepted: whether tokens expire is the
// issuer's to decide, and one that states an expiry is held to it.
export function jwt(options: JwtOptions): AuthAdapter {
  const { jwksAddress, publicKey, secret, ...checks } = options;
  // Past the types, a second way to verify would be ignored without a word.
  if (
    ['jwksAddress', 'publicKey', 'secret'].filter((way) => way in options)
      .length !== 1
  ) {
    throw new Error(
      'The jwt adapter takes exactly one of jwksAddress, publicKey and secret',
    );
  }
  const verifier =
    'jwksAddress' in options
      ? keySet(given('jwt', 'jwksAddress', jwksAddress))
      : 'publicKey' in options
        ? pem(given('jwt', 'publicKey', publicKey))
        : new TextEncoder().encode(given('jwt', 'secret', secret));
  return {
    verify: async (sent) => {
      try {
        const { payload } = await jwtVerify(sent, verifier, checks);
        return typeof payload.sub === 'string' && payload.sub !== ''
          ? { id: payload.sub }
          : undefined;
      } catch (error) {
        if (error instanceof Error && unread.has(error)) throw error;
        return undefined;
      }
    },
  };
}

// Both sides are hashed so that the comparison takes the same time whatever
// the length of what was sent.
function digest(text: string) {
  return createHash('sha256').update(text).digest();
}

export function bearer(options: {
  secret: string | undefined;
  id: string;
}): AuthAdapter {
  const secret = given('bearer', 'secret', options.secret);
  // RFC 6750's alphabet: any other secret could never arrive in a header.
  if (!/^[\w\-.~+/]+=*$/.test(secret)) {
    throw new Error(
      'The bearer adapter was given a secret no header can carry: a bearer token holds letters, digits and - . _ ~ + / and may end in =',
    );
  }
  const id = given('bearer', 'id', options.id);
  const held = digest(secret);
  return {
    verify: (sent) =>
      timingSafeEqual(digest(sent), held) ? { id } : undefined,
  };
}
