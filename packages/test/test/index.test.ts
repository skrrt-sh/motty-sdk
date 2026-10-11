import { expect, test } from 'bun:test';
import * as kit from '../src/index.ts';

test('the test kit exports exactly the held values', () => {
  expect(Object.keys(kit).sort()).toEqual([
    'Unscripted',
    'fake',
    'memory',
    'on',
    'run',
  ]);
});

test('the test kit exports exactly the held types', async () => {
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
  ).toEqual(['Asked', 'ChatReply', 'DecisionReply', 'Fake', 'Ran']);
});
