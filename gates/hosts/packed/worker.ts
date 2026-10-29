import { answer, motty } from '@mottyjs/core';
import { mount } from '@mottyjs/serve';

// Copied beside the packed packages and bundled as a Workers bundler would.
const echo = motty({ name: 'echo' }).handle(() => answer('Use a mutex.'));
const { fetch } = mount(echo, () => ({}));

export default { fetch: (request: Request) => fetch(request) };
