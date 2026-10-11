import { apis } from '../wire/fieldless.ts';
import { providerData } from '../wire/provider-data.ts';

export const family = 'anthropic';

export const { hinted, own, marked, noted } = providerData(
  family,
  apis.messages,
);
