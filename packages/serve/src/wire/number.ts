import type { Json } from '@mottyjs/core/host';
import { invalid } from './refusals.ts';

export function numberOf(
  value: Json | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return value;
  invalid(`${name} must be a number`);
}
