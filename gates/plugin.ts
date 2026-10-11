import { hosted } from '../packages/core/src/host.ts';
import { MottyError, motty } from '../packages/core/src/index.ts';

export class NoCaller extends MottyError.define('no_caller', 401) {}

export function auth() {
  return motty({ name: 'auth' }).derive(() => {
    const { caller } = hosted();
    if (caller === undefined) throw new NoCaller('The host knows no caller');
    return { caller };
  });
}
