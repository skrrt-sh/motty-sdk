import { expect, test } from 'bun:test';
import * as serve from '../src/index.ts';

test('the serve entry exports exactly the held values', () => {
  expect(Object.keys(serve).sort()).toEqual([
    'chatCompletions',
    'chatCompletionsIn',
    'messages',
    'mount',
    'responses',
    'responsesIn',
    'serve',
  ]);
});
