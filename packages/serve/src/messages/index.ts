import type { Codec } from '../codec.ts';
import { decode } from './decode.ts';
import { encode } from './encode.ts';
import { error, failure } from './errors.ts';
import { events } from './events.ts';

export const messages: Codec = {
  paths: ['/v1/messages'],
  credentials: ['x-api-key', 'authorization'],
  requestId: 'request-id',
  decode,
  error,
  encode,
  events,
  failure,
};
