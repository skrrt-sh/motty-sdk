import { answer, motty } from '@mottyjs/core';
import { serve } from '../src/index.ts';

// A serve file as an author writes one, started by the test as its own
// process: what is printed is all the test can see of it.
export default serve(
  motty({ name: 'coder' })
    .afterResponse(async () => {
      await Bun.sleep(100);
      console.log('after-response work done');
    })
    .handle(async () => {
      console.log('asked');
      await Bun.sleep(300);
      return answer('Use a mutex.');
    }),
  () => ({ report: ({ outcome }) => console.log(`report: ${outcome}`) }),
);
