import { carrying } from '../wire/carried.ts';
import { apis } from '../wire/fieldless.ts';
import { providerData } from '../wire/provider-data.ts';

export const family = 'anthropic';

export const { hinted, own, mine, marked, noted } = providerData(
  family,
  apis.messages,
);

// Every header of this API's own but its version, which the codec speaks
// one of: the betas a request names turn on fields of its body, and a list
// of the headers known today would leave out the next one.
export const { heard, parted } = carrying(
  (name) => name.startsWith('anthropic-') && name !== 'anthropic-version',
);
