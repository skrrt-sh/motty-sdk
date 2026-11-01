import { motty } from '@mottyjs/core';
import { mount } from '../src/index.ts';

// The worker of workers.test.ts: `/written` tells what the mount below wrote,
// and every other path is the mount's own.
const written: string[] = [];
console.error = (line: string) => written.push(line);

const clock = Date.now();
let given: string | undefined;
const { fetch } = mount(
  motty({ name: 'coder' }).handle(() => {
    // Written over, which hides the binding from `process.env` and from no log.
    if (typeof process !== 'undefined') process.env['KEY'] = 'something else';
    // A secret of no known shape, as a thrower that read it would say it.
    throw new Error(`Refused ${given}`);
  }),
  ({ KEY }) => {
    given = KEY;
    return { auth: { verify: () => undefined } };
  },
);

export default {
  fetch: (request: Request) =>
    new URL(request.url).pathname === '/written'
      ? Response.json({ clock, written, given })
      : fetch(request),
};
