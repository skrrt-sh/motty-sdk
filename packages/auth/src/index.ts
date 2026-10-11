import { motty, Unauthenticated } from '@mottyjs/core';
import { hosted } from '@mottyjs/core/host';

export function auth() {
  return motty({ name: 'auth' }).derive(() => {
    const { caller } = hosted();
    if (caller === undefined) {
      throw new Unauthenticated(
        'This motty needs a caller, and the host knows none',
      );
    }
    return { caller };
  });
}
