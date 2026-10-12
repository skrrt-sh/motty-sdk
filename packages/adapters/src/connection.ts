import type { ErrorFacts } from '@mottyjs/core/host';

// An address is the API's base with its version, and a path is relative to
// it. One slash stands between them, however either was written.
export function endpoint(address: string, path: string): string {
  return `${address.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

// Some runtimes print an address that holds a name and password when a
// request to it fails, and others send neither. Neither refusal quotes it.
export function addressed(prefix: string, address: string): string {
  const url = URL.parse(address);
  if (url === null) {
    throw new Error(`The ${prefix} adapter was given an address that is none`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `The ${prefix} adapter was given an address that holds credentials; send them in a header`,
    );
  }
  return address;
}

// A model is named as the prefix, a slash and the provider's own name. An
// empty prefix would serve names that start with the slash, and one that
// holds a slash would leave where the provider's name starts unsaid.
export function prefixed(prefix: string): string {
  if (prefix === '' || prefix.includes('/')) {
    throw new Error(
      'An adapter was given a prefix that is no name: it takes one or more characters and no /',
    );
  }
  return prefix;
}

// A fetch that threw says only that it threw: whether the request was
// stopped is read from the signal, which is the same on every runtime.
// What it threw may quote the request, so the secrets are cut from it.
export function broken(
  signal: AbortSignal,
  thrown: unknown,
  clean: (text: string) => string,
): ErrorFacts {
  if (signal.aborted) {
    return { code: 'aborted', status: 499, message: 'The call was stopped' };
  }
  return {
    code: 'upstream_failed',
    status: 502,
    message: 'The connection to the upstream failed',
    retryable: true,
    upstream: true,
    ...(thrown instanceof Error ? { cause: clean(thrown.message) } : {}),
  };
}

// A redirect is never followed: the next address would be sent the key and
// every header. Where it points is left out, since an address may hold one.
// A 3xx with nowhere to go is told by its status, as any odd answer is.
export function moved(status: number): ErrorFacts {
  const redirect = [301, 302, 303, 307, 308].includes(status);
  return {
    code: 'upstream_failed',
    status: 502,
    message: redirect
      ? `The upstream answered ${status}, a redirect, which is not followed`
      : `The upstream answered ${status}`,
    retryable: false,
    upstream: true,
  };
}

// No provider's failure is a tenth of this. One that is longer is read no
// further, so it holds no loop and reaches nobody whole.
const most = 65_536;

// A character the limit falls inside is left out, not replaced.
export async function told(response: Response): Promise<string> {
  if (response.body === null) return '';
  const decoder = new TextDecoder();
  let text = '';
  let left = most;
  for await (const chunk of response.body) {
    text += decoder.decode(chunk.subarray(0, left), { stream: true });
    left -= chunk.length;
    if (left <= 0) break;
  }
  return text;
}

// A body left before its end costs its connection, and the next call pays
// for a new one. What follows a stream's last event is read for that, as far
// as a failure is and for a second: an upstream may never end its body.
export async function spent(body: NonNullable<Response['body']>) {
  const reader = body.getReader();
  const late = setTimeout(() => reader.cancel().catch(() => {}), 1000);
  try {
    for (let left = most; left > 0; ) {
      const { done, value } = await reader.read();
      if (done) return;
      left -= value.length;
    }
    await reader.cancel();
  } finally {
    clearTimeout(late);
  }
}

const named = /[\p{L}\p{N}_-]/u;

// A dot joins two characters of a name, and ends a sentence after one.
function joined(text: string, at: number, step: 1 | -1): boolean {
  const beside = text[at] ?? '';
  return named.test(beside === '.' ? (text[at + step] ?? '') : beside);
}

// A mask leaves the ends of a key, four characters of one at the least seen,
// so a run counts from four where it starts or ends the key. Elsewhere it
// counts from eight: a word can sit whole in a key's public prefix.
function echoed(text: string, at: number, key: string): number {
  let end = at;
  while (end < text.length && key.includes(text.slice(at, end + 1))) end += 1;
  if (end - at >= 8) return end;
  for (; end - at >= 4; end -= 1) {
    const run = text.slice(at, end);
    // A mask leaves an end where a name ends, and a word may end as a key
    // does, so an end counts only at that edge of a name.
    if (
      (key.startsWith(run) && !joined(text, at - 1, -1)) ||
      (key.endsWith(run) && !joined(text, end, 1))
    ) {
      return end;
    }
  }
  return at;
}

// A short key may be a word, as a local server's placeholder is, so it is
// cut only whole and where it stands alone: inside a longer name it is a
// part of that name.
function alone(text: string, at: number, key: string): number {
  const end = at + key.length;
  return text.startsWith(key, at) &&
    !joined(text, at - 1, -1) &&
    !joined(text, end, 1)
    ? end
    : at;
}

// A header's part is cut only whole: it may be a word, which a sentence
// holds parts of.
function sent(text: string, at: number, held: string): number {
  return text.startsWith(held, at) ? at + held.length : at;
}

// A provider's key runs past twenty characters. Only one that long is
// looked for by its masked ends: a shorter one's are a word's.
const masked = 20;

function cut(text: string, key: string, whole: string[]): string {
  const found = key.length >= masked ? echoed : alone;
  let clean = '';
  for (let at = 0; at < text.length; ) {
    let end = key === '' ? at : found(text, at, key);
    for (const held of whole) end = Math.max(end, sent(text, at, held));
    clean += end === at ? text[at] : '[key]';
    at = Math.max(end, at + 1);
  }
  return clean;
}

// A gateway's key runs past twenty characters, and one a host made itself
// is seldom under sixteen. A flag, a date or a version is shorter, and
// stays in what an upstream said.
const shortest = 16;

// Made once with the adapter: a request that fails nothing pays for no cut,
// and a key or a header no request can carry fails here, in words that hold
// no value. The key goes as a bearer token unless the API names its header.
export function credentials(
  prefix: string,
  key: string | undefined,
  carrier: string | undefined,
  added: { [name: string]: string } = {},
) {
  const held = key?.trim() ?? '';
  const headers = new Headers();
  for (const [name, value] of Object.entries(added)) {
    try {
      headers.append(name, value);
    } catch {
      throw new Error(
        `The ${prefix} adapter was given a header no request can carry: ${name}`,
      );
    }
  }
  if (held !== '') {
    try {
      headers.set(
        carrier ?? 'authorization',
        carrier === undefined ? `Bearer ${held}` : held,
      );
    } catch {
      throw new Error(
        `The ${prefix} adapter was given a key no header can carry`,
      );
    }
  }
  // A secret may stand beside a scheme, a tenant or another pair, so each
  // part of a value is cut, and the value whole.
  const whole = Object.values(added)
    .flatMap((value) => [value.trim(), ...value.split(/[\s;,=]+/)])
    .filter((part) => part.length >= shortest);
  return { headers, clean: (text: string) => cut(text, held, whole) };
}
