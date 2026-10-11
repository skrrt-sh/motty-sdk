import { isMarked } from '../../packages/core/src/host.ts';
import { host } from './host.ts';

// The author's bundle is a module of its own beside this one, so the SDK in
// it is a copy and the mark is all the two share.
const beside = './motty.js';
const loaded: unknown = await import(beside);
if (
  typeof loaded !== 'object' ||
  loaded === null ||
  !('default' in loaded) ||
  !isMarked(loaded.default)
) {
  throw new Error('The default export of the bundle is not a motty');
}

const { UPSTREAM, RECORDS } = process.env;
if (UPSTREAM === undefined || RECORDS === undefined) {
  throw new Error('The worker has no UPSTREAM or no RECORDS');
}

const answered = host(loaded.default, { upstream: UPSTREAM, records: RECORDS });

export default {
  fetch: (
    request: Request,
    _env: unknown,
    context: { waitUntil: (work: Promise<unknown>) => void },
  ): Promise<Response> => answered(request, (work) => context.waitUntil(work)),
};
