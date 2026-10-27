import { expect, test } from 'bun:test';
import { isMarked, type Marked, mark, version } from '../src/contract.ts';
import type { StandardSchema } from '../src/data/message.ts';
import { stubHost } from './stub-host.ts';

function relay(): Marked {
  return {
    [mark]: {
      version,
      description: { sdk: '0.0.0', name: 'relay', plugins: ['tenant'] },
      run: (request, host) =>
        host.models(
          request.model,
          { messages: [...request.messages] },
          host.signal,
        ),
    },
  };
}

// A bundle carries its own copy of the core, so the key in the registry is
// what the host and the bundle agree on.
test.each([
  ['a value carrying the mark', relay()],
  ['a function carrying the mark', Object.assign(() => {}, relay())],
  [
    'a value marked by another copy of the core',
    { [Symbol.for('@mottyjs/core')]: relay()[mark] },
  ],
])('%s is recognised', (_, value) => {
  expect(isMarked(value)).toBe(true);
});

test.each([
  [
    'a value with the same shape but no mark',
    { version, description: relay()[mark].description, run: () => {} },
  ],
  [
    'a value under a look-alike symbol',
    { [Symbol('@mottyjs/core')]: relay()[mark] },
  ],
  ['undefined', undefined],
  ['null', null],
  ['zero', 0],
  ['a string', 'motty'],
  ['true', true],
])('%s is not recognised', (_, value) => {
  expect(isMarked(value)).toBe(false);
});

test('the prompt that crosses carries a JSON Schema and no Standard Schema', () => {
  const host = stubHost();
  const schema: StandardSchema = {
    '~standard': {
      version: 1,
      vendor: 'acme',
      validate: (value) => ({ value }),
    },
  };
  host.models(
    'a',
    { messages: [], output: { schema: { type: 'object' } } },
    host.signal,
  );
  // @ts-expect-error a bare JSON Schema is not an output by itself
  host.models('c', { messages: [], output: { type: 'object' } }, host.signal);
  // @ts-expect-error a Standard Schema holds a function and never crosses
  host.models('b', { messages: [], output: schema }, host.signal);
  expect(host.sent('a')).toEqual([
    { messages: [], output: { schema: { type: 'object' } } },
  ]);
});
