import { expect, test } from 'bun:test';
import {
  exportJWK,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
} from 'jose';
import { bearer, jwt } from '../src/jwt.ts';

function signed(secret: string, claims: { sub?: string; exp?: string }) {
  const token = new SignJWT({}).setProtectedHeader({ alg: 'HS256' });
  if (claims.sub !== undefined) token.setSubject(claims.sub);
  return token
    .setExpirationTime(claims.exp ?? '5m')
    .sign(new TextEncoder().encode(secret));
}

test('a token signed with the shared secret gives its subject as the caller', async () => {
  const adapter = jwt({ secret: 'host-secret' });
  const token = await signed('host-secret', { sub: 'user-1' });

  expect(await adapter.verify(token)).toEqual({
    id: 'user-1',
  });
});

test('a token that is not a signed token means no caller', async () => {
  const adapter = jwt({ secret: 'host-secret' });
  const unsigned = new UnsecuredJWT({}).setSubject('user-1').encode();

  expect(await adapter.verify('abc')).toBeUndefined();
  expect(await adapter.verify('a.b.c')).toBeUndefined();
  expect(await adapter.verify(unsigned)).toBeUndefined();
});

test('an expired token means no caller', async () => {
  const adapter = jwt({ secret: 'host-secret' });
  const token = await signed('host-secret', { sub: 'user-1', exp: '-1s' });

  expect(await adapter.verify(token)).toBeUndefined();
});

test("a token that states no expiry is accepted: whether tokens expire is the issuer's to decide", async () => {
  const adapter = jwt({ secret: 'host-secret' });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('service-1')
    .sign(new TextEncoder().encode('host-secret'));

  expect(await adapter.verify(token)).toEqual({ id: 'service-1' });
});

test('a token that states no expiry signs nobody in where the host requires one', async () => {
  const adapter = jwt({ secret: 'host-secret', requiredClaims: ['exp'] });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('service-1')
    .sign(new TextEncoder().encode('host-secret'));

  expect(await adapter.verify(token)).toBeUndefined();
  expect(
    await adapter.verify(await signed('host-secret', { sub: 'user-1' })),
  ).toEqual({ id: 'user-1' });
});

test('a token with no subject, or an empty one, means no caller', async () => {
  const adapter = jwt({ secret: 'host-secret' });
  const none = await signed('host-secret', {});
  const empty = await signed('host-secret', { sub: '' });

  expect(await adapter.verify(none)).toBeUndefined();
  expect(await adapter.verify(empty)).toBeUndefined();
});

test('the issuer and the audience are checked when the host names them', async () => {
  const adapter = jwt({
    secret: 'host-secret',
    issuer: 'https://id.example',
    audience: 'coder',
  });
  const mint = (issuer: string, audience: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer(issuer)
      .setAudience(audience)
      .sign(new TextEncoder().encode('host-secret'));
  const right = await mint('https://id.example', 'coder');
  const issuer = await mint('https://evil.example', 'coder');
  const audience = await mint('https://id.example', 'other');
  const neither = await signed('host-secret', { sub: 'user-1' });

  expect(await adapter.verify(right)).toEqual({
    id: 'user-1',
  });
  expect(await adapter.verify(issuer)).toBeUndefined();
  expect(await adapter.verify(audience)).toBeUndefined();
  expect(await adapter.verify(neither)).toBeUndefined();
});

test('the issuer and the audience are not checked when the host names neither', async () => {
  const adapter = jwt({ secret: 'host-secret' });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer('https://anyone.example')
    .setAudience('anything')
    .sign(new TextEncoder().encode('host-secret'));

  expect(await adapter.verify(token)).toEqual({ id: 'user-1' });
});

test('a token signed with the private key is verified with the public key', async () => {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const stranger = await generateKeyPair('ES256');
  const adapter = jwt({ key: await exportSPKI(pair.publicKey) });
  const mint = (key: CryptoKey) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('user-1')
      .sign(key);

  expect(await adapter.verify(await mint(pair.privateKey))).toEqual({
    id: 'user-1',
  });
  expect(await adapter.verify(await mint(stranger.privateKey))).toBeUndefined();
});

test('a token of another kind of algorithm than the key means no caller', async () => {
  const elliptic = await generateKeyPair('ES256', { extractable: true });
  const rsa = await generateKeyPair('RS256');
  const pem = await exportSPKI(elliptic.publicKey);
  const byRsa = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('user-1')
    .sign(rsa.privateKey);
  // The classic forgery: the public key, which is no secret, used as one.
  const byPublicKey = await signed(pem, { sub: 'user-1' });

  expect(await jwt({ key: pem }).verify(byRsa)).toBeUndefined();
  expect(await jwt({ key: pem }).verify(byPublicKey)).toBeUndefined();
  expect(await jwt({ secret: 'host-secret' }).verify(byRsa)).toBeUndefined();
});

test('a token is verified against the key set the host points at', async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  const stranger = await generateKeyPair('RS256');
  const published = { ...(await exportJWK(pair.publicKey)), kid: 'k1' };
  const server = Bun.serve({
    port: 0,
    fetch: () => Response.json({ keys: [published] }),
  });
  const adapter = jwt({ jwks: `${server.url}jwks.json` });
  const mint = (key: CryptoKey, kid: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid })
      .setSubject('user-1')
      .sign(key);
  const right = await mint(pair.privateKey, 'k1');
  const forged = await mint(stranger.privateKey, 'k1');
  const unknown = await mint(stranger.privateKey, 'k2');
  const symmetric = await signed('host-secret', { sub: 'user-1' });

  const callers = [
    await adapter.verify(right),
    await adapter.verify(forged),
    await adapter.verify(unknown),
    await adapter.verify(symmetric),
  ];
  await server.stop(true);

  expect(callers).toEqual([{ id: 'user-1' }, undefined, undefined, undefined]);
});

test('a key set that cannot be read is told without its address, and without what the runtime threw', async () => {
  const token = await signed('host-secret', { sub: 'user-1' });
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('down for maintenance', { status: 503 }),
  });
  const refused = jwt({
    jwks: 'http://127.0.0.1:1/jwks.json?token=held-in-the-address',
  });
  const answered = jwt({
    jwks: `${server.url}jwks.json?token=held-in-the-address`,
  });

  const failures = await Promise.allSettled([
    refused.verify(token),
    answered.verify(token),
  ]);
  await server.stop(true);

  expect(failures).toHaveProperty(
    '0.reason.message',
    'The key set could not be read',
  );
  expect(failures).not.toHaveProperty('0.reason.cause');
  expect(failures).toHaveProperty(
    '1.reason.message',
    'The key set could not be read',
  );
  expect(failures).toHaveProperty(
    '1.reason.cause.message',
    'Expected 200 OK from the JSON Web Key Set HTTP response',
  );
});

test('a key set address that holds a name or a password, or is no address, fails when made, in words without it', () => {
  expect(() =>
    jwt({ jwks: 'https://reader:held-in-the-address@id.example/jwks' }),
  ).toThrow(
    /^The jwt adapter was given a key set address that holds credentials$/,
  );
  expect(() => jwt({ jwks: 'held-in-the-address' })).toThrow(
    /^The jwt adapter was given a key set address that is none$/,
  );
});

test('with no key set, key or secret it fails when made', () => {
  expect(() => jwt({ jwks: undefined })).toThrow(
    'The jwt adapter was given no key set address',
  );
  expect(() => jwt({ key: undefined })).toThrow(
    'The jwt adapter was given no public key',
  );
  expect(() => jwt({ key: '' })).toThrow(
    'The jwt adapter was given no public key',
  );
  expect(() => jwt({ secret: undefined })).toThrow(
    'The jwt adapter was given no secret',
  );
  expect(() => jwt({ secret: '' })).toThrow(
    'The jwt adapter was given no secret',
  );
});

test('a public key that is no PEM fails when made, in words that hold none of it', () => {
  expect(() => jwt({ key: 'held-in-the-option' })).toThrow(
    /^The jwt adapter was given a public key that is no PEM$/,
  );
});

test('two sources cannot be given at once, nor none, in the types or past them', () => {
  const both: { secret: string; key: string } = {
    secret: 'host-secret',
    key: 'not read',
  };

  // @ts-expect-error a secret and a public key together are not an option
  expect(() => jwt(both)).toThrow(
    'The jwt adapter takes exactly one of a key set address, a public key and a secret',
  );
  // @ts-expect-error nor are a key set address and a secret
  expect(() => jwt({ jwks: 'https://id.example', secret: 'a' })).toThrow(
    'The jwt adapter takes exactly one of a key set address, a public key and a secret',
  );
  // @ts-expect-error nor a key set address and a public key
  expect(() => jwt({ jwks: undefined, key: 'b' })).toThrow(
    'The jwt adapter takes exactly one of a key set address, a public key and a secret',
  );
  // @ts-expect-error nor is none of them
  expect(() => jwt({})).toThrow('The jwt adapter takes exactly one of');
  // @ts-expect-error nor the checks alone
  expect(() => jwt({ issuer: 'https://id.example' })).toThrow(
    'The jwt adapter takes exactly one of',
  );
});

test('the plain secret gives the caller the host named', async () => {
  const adapter = bearer({ secret: 'host-secret', id: 'ops' });

  expect(await adapter.verify('host-secret')).toEqual({
    id: 'ops',
  });
});

test('a wrong plain secret of any length means no caller', async () => {
  const adapter = bearer({ secret: 'host-secret', id: 'ops' });

  expect(await adapter.verify('host-secreT')).toBeUndefined();
  expect(await adapter.verify('host')).toBeUndefined();
  expect(await adapter.verify('host-secret-x')).toBeUndefined();
  expect(await adapter.verify('')).toBeUndefined();
});

test('with no plain secret it fails when made', () => {
  expect(() => bearer({ secret: undefined, id: 'ops' })).toThrow(
    'The bearer adapter was given no secret',
  );
});

test('with no id for its caller it fails when made', () => {
  expect(() => bearer({ secret: 'host-secret', id: '' })).toThrow(
    'The bearer adapter was given no id',
  );
});

test('a plain secret no bearer header can carry fails when made', () => {
  expect(() => bearer({ secret: 'p@ss w0rd!', id: 'ops' })).toThrow(
    'The bearer adapter was given a secret no header can carry',
  );
  expect(() => bearer({ secret: 'pa$$', id: 'ops' })).toThrow();
  expect(() => bearer({ secret: 'two words', id: 'ops' })).toThrow();
  expect(() => bearer({ secret: 'aB3-._~+/==', id: 'ops' })).not.toThrow();
});
