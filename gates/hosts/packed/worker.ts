import { answer, motty } from '@mottyjs/core';
import { mount } from '@mottyjs/serve';

// Copied beside the packed packages and bundled as a Workers bundler would.
// The answer holds a text binding, so that a reply shows what the options read.
let lock = 'nothing';
const echo = motty({ name: 'echo' }).handle(() => answer(`Use a ${lock}.`));
const { fetch } = mount(echo, ({ LOCK = lock }) => {
  lock = LOCK;
  return {};
});

export default { fetch: (request: Request) => fetch(request) };
