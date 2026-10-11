import { serve } from '@mottyjs/serve';
import coder from './motty.ts';

// Named as an author's serve file names it: the test runs a copy of this
// folder from outside the package, where no path into it would resolve.
export default serve(coder, () => ({}));
