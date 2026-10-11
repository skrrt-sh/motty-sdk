import { answer, motty } from '@mottyjs/core';

export default motty({ name: 'coder' }).handle(() => answer('Use a mutex.'));
