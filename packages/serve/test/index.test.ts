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

test('the serve entry exports exactly the held types', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(
    [...text.matchAll(/export (type )?\{([^}]*)\}/g)]
      .flatMap(([, allTypes, names = '']) =>
        names
          .split(',')
          .map((name) => name.trim())
          .filter((name) => allTypes !== undefined || name.startsWith('type '))
          .map((name) => name.replace('type ', '')),
      )
      .filter((name) => name !== '')
      .sort(),
  ).toEqual(['Edge']);
});
