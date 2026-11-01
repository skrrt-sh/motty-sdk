import { answer, motty } from '@mottyjs/core';
import { mount, serve } from '../src/index.ts';

// Read by the typecheck and never run: a host's options, in the form the
// documents give, under the Workers types as much as under Bun's.
const coder = motty({ name: 'coder' }).handle(() => answer('Use a mutex.'));

export const mounted = mount(coder, ({ OPENAI_KEY }) => ({
  namespace: OPENAI_KEY ?? 'coder',
}));

export const served = serve(coder, ({ NAMESPACE = 'coder' }) => ({
  namespace: NAMESPACE,
}));
