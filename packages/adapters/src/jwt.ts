import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import type { AuthAdapter } from '@mottyjs/core/host';
import {
  createRemoteJWKSet,
  errors,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';

// Exactly one way to check the signature: the address of a key set, a public
// key in PEM or a shared secret.
export type JwtOptions = { issuer?: string; audience?: string } & (
  | { jwks: string | undefined; key?: never; secret?: never }
  | { key: string | undefined; jwks?: never; secret?: never }
  | { secret: string | undefined; jwks?: never; key?: never }
);

function given(adapter: string, name: string, value: string | undefined) {
  if (value === undefined || value === '') {
    throw new Error(`The ${adapter} adapter was given no ${name}`);
  }
  return value;
}

// A key set that cannot be read is the host's failure, so it throws: "no
// caller" would tell a caller with a valid token to sign in again. The errors
// are kept here to tell them from everything a token can cause.
const unread = new WeakSet<Error>();

function keySet(address: string): JWTVerifyGetKey {
  const read = createRemoteJWKSet(new URL(address));
  return (header, signed) =>
    read(header, signed).catch((cause: unknown) => {
      if (
        cause instanceof errors.JWKSNoMatchingKey ||
        cause instanceof errors.JWKSMultipleMatchingKeys ||
        cause instanceof errors.JOSENotSupported
      ) {
        throw cause;
      }
      const error = new Error(`The key set at ${address} could not be read`, {
        cause,
      });
      unread.add(error);
      throw error;
    });
}

// A token that states no expiry is accepted: whether tokens expire is the
// issuer's to decide, and one that states an expiry is held to it.
export function jwt(options: JwtOptions): AuthAdapter {
  const { jwks, key, secret, ...claims } = options;
  // Past the types, a second way to verify would be ignored without a word.
  if (['jwks', 'key', 'secret'].filter((way) => way in options).length !== 1) {
    throw new Error(
      'The jwt adapter takes exactly one of a key set address, a public key and a secret',
    );
  }
  const verifier =
    'jwks' in options
      ? keySet(given('jwt', 'key set address', jwks))
      : 'key' in options
        ? createPublicKey(given('jwt', 'public key', key))
        : new TextEncoder().encode(given('jwt', 'secret', secret));
  return {
    verify: async (sent) => {
      try {
        const { payload } = await jwtVerify(sent, verifier, claims);
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
  const held = digest(secret);
  return {
    verify: (sent) =>
      timingSafeEqual(digest(sent), held) ? { id: options.id } : undefined,
  };
}
