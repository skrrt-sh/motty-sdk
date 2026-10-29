import { motty, Unauthenticated } from '@mottyjs/core';
import { hosted } from '@mottyjs/core/host';

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
