import { expect, test } from 'bun:test';
import * as core from '../src/index.ts';

test('the author entry exports exactly the held values', () => {
  expect(Object.keys(core).sort()).toEqual([
    'Aborted',
    'Blocked',
    'ContextTooLong',
    'Forbidden',
    'InvalidOutput',
    'InvalidRequest',
    'LimitReached',
    'MottyError',
    'Overloaded',
    'QuotaExceeded',
    'RateLimited',
    'RouteLoop',
    'TimedOut',
    'Unauthenticated',
    'UnknownModel',
    'UnknownRoute',
    'Unsupported',
    'UpstreamFailed',
    'UpstreamRefused',
    'answer',
    'fallback',
    'model',
    'motty',
    'race',
    'reroute',
    'retry',
    'said',
    'think',
    'timeout',
  ]);
});

test('the author entry exports exactly the held types', async () => {
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
  ).toEqual([
    'Answer',
    'Cache',
    'Calls',
    'ChatRequest',
    'Chunk',
    'Closed',
    'Draft',
    'FinishReason',
    'Message',
    'Model',
    'Motty',
    'NamedModel',
    'Options',
    'Outcome',
    'Part',
    'Prompt',
    'ReadonlyJson',
    'StandardSchema',
    'Tool',
    'Usage',
  ]);
});

test('the author entry holds named exports from other files and nothing else', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(
    text.replace(/export (type )?\{[^}]*\} from '[^']*';/g, '').trim(),
  ).toBe('');
});
