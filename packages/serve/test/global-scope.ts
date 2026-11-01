import { answer, motty } from '@mottyjs/core';
import { mount } from '../src/index.ts';

// The worker of workers.test.ts: `/written` tells what the mount below wrote,
// and every other path is the mount's own.
const written: string[] = [];
console.error = (line: string) => written.push(line);

const clock = Date.now();
const { fetch } = mount(
  motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
  () => ({ auth: { verify: () => undefined } }),
);

export default {
  fetch: (request: Request) =>
    new URL(request.url).pathname === '/written'
      ? Response.json({ clock, written })
      : fetch(request),
};
