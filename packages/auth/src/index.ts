import { motty, Unauthenticated } from '@mottyjs/core';
import { hosted } from '@mottyjs/core/host';

/**
 * A part that puts the caller on the context and refuses a request with none,
 * by `Unauthenticated`. The host's auth adapter proves the caller, so without
 * this part a motty runs for anyone, and the token never reaches the motty.
 */
export function auth() {
  return motty({ name: 'auth' }).derive(() => {
    const { caller } = hosted();
    if (caller === undefined) {
      throw new Unauthenticated(
        'The request has no key or token this host accepts, and this motty answers only callers it can identify',
      );
    }
    return { caller };
  });
}
