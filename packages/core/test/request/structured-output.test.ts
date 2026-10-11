import { expect, test } from 'bun:test';
import type { EventStream } from '../../src/contract.ts';
import { InvalidOutput } from '../../src/data/errors.ts';
import type { StreamEvent } from '../../src/data/event.ts';
import { answer, buffered } from '../../src/request/answer.ts';
import { enter } from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { isStandard } from '../../src/request/structured-output.ts';
import { stubHost } from '../stub-host.ts';

function stream(events: StreamEvent[]): EventStream {
  const host = stubHost({ 'acme/small': events });
  return host.models('acme/small', { messages: [] }, host.signal);
}

test('a value the schema rejects throws InvalidOutput naming the issues', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":7}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) =>
          typeof value === 'object' &&
          value !== null &&
          'city' in value &&
          typeof value.city === 'string'
            ? { value: { city: value.city } }
            : {
                issues: [
                  { message: 'city must be a string' },
                  { message: 'city is required' },
                ],
              },
      },
    },
  );

  await expect(reply.json()).rejects.toBeInstanceOf(InvalidOutput);
  await expect(reply.json()).rejects.toThrow(
    'The answer does not match the schema: city must be a string; city is required',
  );
  expect(await reply.text()).toBe('{"city":7}');
  expect(await reply.finish()).toBe('stop');
});

test('a validator that throws rejects json with what it threw', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (): { value: { city: string } } => {
          throw new RangeError('The validator broke');
        },
      },
    },
  );

  await expect(reply.json()).rejects.toBeInstanceOf(RangeError);
  expect(await reply.text()).toBe('{"city":"Oslo"}');
});

test('text that is not JSON throws InvalidOutput saying so', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Os' },
      { type: 'finish', reason: 'length', usage: { input: 1, output: 2 } },
    ]),
  );
  const empty = buffered(
    stream([
      { type: 'reasoning', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
  );

  await expect(reply.json()).rejects.toBeInstanceOf(InvalidOutput);
  await expect(reply.json()).rejects.toThrow('The answer is not JSON');
  await expect(answer('Sure, here it is').json()).rejects.toThrow(
    'The answer is not JSON',
  );
  expect(await empty.text()).toBe('');
  await expect(empty.json()).rejects.toThrow('The answer is not JSON');
});

test('json is only parsed, and unknown, for a JSON Schema', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":7}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      name: 'place',
      strict: true,
      schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  );
  const parsed: unknown = await reply.json();
  // @ts-expect-error a JSON Schema gives unknown, which is not a place
  const wrong: { city: string } = await reply.json();

  expect([parsed, wrong]).toEqual([{ city: 7 }, { city: 7 }]);
});

test('a Standard Schema is told by its validate function', () => {
  expect(
    isStandard({
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
      },
    }),
  ).toBe(true);
  expect(isStandard({ schema: { type: 'object' } })).toBe(false);
  expect(isStandard({})).toBe(false);
  expect(isStandard(undefined)).toBe(false);
  expect(isStandard(JSON.parse('{"~standard":{"version":1}}'))).toBe(false);
  expect(isStandard(JSON.parse('{"~standard":null}'))).toBe(false);
});

function misvalidated(result: string) {
  return buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => JSON.parse(result).result,
      },
    },
  );
}

test('a validator that returns no usable result throws InvalidOutput saying so', async () => {
  for (const result of [
    '{}',
    '{"result":null}',
    '{"result":"valid"}',
    '{"result":{}}',
    '{"result":{"issues":"city must be a string"}}',
    '{"result":{"issues":{"message":"city must be a string"}}}',
    '{"result":{"issues":[null]}}',
    '{"result":{"issues":[{"message":"city must be a string"},{"message":7}]}}',
  ]) {
    const thrown = await misvalidated(result)
      .json()
      .catch((raised: unknown) => raised);

    expect(thrown).toBeInstanceOf(InvalidOutput);
    expect(thrown).toMatchObject({
      message: 'The output schema returned no usable result',
    });
  }
});

test('an empty list of issues is a rejection, not a success', async () => {
  const reply = misvalidated(
    '{"result":{"issues":[],"value":{"city":"Oslo"}}}',
  );
  const thrown = await reply.json().catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(InvalidOutput);
  expect(thrown).toMatchObject({
    message: 'The answer does not match the schema',
    cause: [],
  });
});

test('a result with no issues, absent or falsy, is the validated value', async () => {
  expect(
    await misvalidated('{"result":{"value":{"city":"Oslo"}}}').json(),
  ).toEqual({
    city: 'Oslo',
  });
  expect(
    await misvalidated('{"result":{"value":null,"issues":null}}').json(),
  ).toBeNull();
});

test('a validator that rejects fails json with what it rejected with', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (): Promise<{ value: { city: string } }> => {
          throw new RangeError('The validator broke');
        },
      },
    },
  );

  await expect(reply.json()).rejects.toBeInstanceOf(RangeError);
});

test('the InvalidOutput for a schema rejection holds the issues as its cause', async () => {
  const reply = misvalidated(
    '{"result":{"issues":[{"message":"city must be a string","path":["city"]},{"message":"city is required"}]}}',
  );
  const thrown = await reply.json().catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(InvalidOutput);
  expect(thrown).toMatchObject({
    message:
      'The answer does not match the schema: city must be a string; city is required',
    cause: [
      { message: 'city must be a string', path: ['city'] },
      { message: 'city is required' },
    ],
  });
});

test('the InvalidOutput for text that is not JSON holds the parse error as its cause', async () => {
  const thrown = await answer('Sure, here it is')
    .json()
    .catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(InvalidOutput);
  expect(thrown instanceof Error && thrown.cause).toBeInstanceOf(SyntaxError);
});

test('JSON behind a byte-order mark or a Markdown fence is not JSON', async () => {
  await expect(answer('﻿{"city":"Oslo"}').json()).rejects.toThrow(
    'The answer is not JSON',
  );
  await expect(
    answer('```json\n{"city":"Oslo"}\n```').json(),
  ).rejects.toBeInstanceOf(InvalidOutput);
});

test('isStandard is false for anything that is not a schema with a validate function', () => {
  expect(isStandard(JSON.parse('null'))).toBe(false);
  expect(isStandard(JSON.parse('"~standard"'))).toBe(false);
  expect(isStandard(JSON.parse('7'))).toBe(false);
  expect(isStandard(JSON.parse('{"~standard":"validate"}'))).toBe(false);
  expect(isStandard(JSON.parse('{"~standard":7}'))).toBe(false);
  expect(isStandard(JSON.parse('{"~standard":{"validate":true}}'))).toBe(false);
  expect(isStandard(JSON.parse('{"~standard":{}}'))).toBe(false);
});

test('isStandard counts an inherited key and a callable schema', () => {
  const standard = {
    version: 1,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  } as const;

  expect(isStandard(Object.create({ '~standard': standard }))).toBe(true);
  expect(isStandard({ '~standard': Object.create(standard) })).toBe(true);
  expect(isStandard(Object.assign(() => {}, { '~standard': standard }))).toBe(
    true,
  );
});

test('a schema whose ~standard is a function carrying validate is a Standard Schema', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': Object.assign(() => {}, {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: { city: 'Bergen' } }),
      } as const),
    },
  );

  expect(
    isStandard({
      '~standard': Object.assign(() => {}, {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
      } as const),
    }),
  ).toBe(true);
  expect(isStandard(JSON.parse('{"~standard":{"validate":{}}}'))).toBe(false);
  expect(await reply.json()).toEqual({ city: 'Bergen' });
});

test('a validator result whose value is inherited, not its own, is a usable result', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => Object.create({ value: { city: 'Bergen' } }),
      },
    },
  );

  expect(await reply.json()).toEqual({ city: 'Bergen' });
});

test('a value the Standard Schema rejects throws InvalidOutput', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: '{"city":7}' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 2, cached: 0, reasoning: 0 },
      },
    ],
  });

  await enter(host, async () => {
    const reply = await model('acme/small').complete({
      messages: [],
      output: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) =>
            typeof value === 'object' &&
            value !== null &&
            'city' in value &&
            typeof value.city === 'string'
              ? { value: { city: value.city } }
              : { issues: [{ message: 'city must be a string' }] },
          jsonSchema: { output: () => ({ type: 'object' }) },
        },
      },
    });
    await expect(reply.json()).rejects.toBeInstanceOf(InvalidOutput);
  });
});

test('a value the Standard Schema inside the object form rejects throws InvalidOutput naming the issues', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":7}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      name: 'place',
      strict: true,
      schema: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) =>
            typeof value === 'object' &&
            value !== null &&
            'city' in value &&
            typeof value.city === 'string'
              ? { value: { city: value.city } }
              : { issues: [{ message: 'city must be a string' }] },
        },
      },
    },
  );

  await expect(reply.json()).rejects.toBeInstanceOf(InvalidOutput);
  await expect(reply.json()).rejects.toThrow(
    'The answer does not match the schema: city must be a string',
  );
  expect(await reply.text()).toBe('{"city":7}');
});

test('json is the value the Standard Schema inside the object form gives back, typed by it', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo","extra":true}' },
      { type: 'finish', reason: 'stop' },
    ]),
    {
      strict: true,
      schema: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: () => ({ value: { city: 'Oslo' } }),
        },
      },
    },
  );

  const place: { city: string } = await reply.json();
  // @ts-expect-error the schema's output has no number in it
  const wrong: { city: number } = await reply.json();

  expect([place, wrong]).toEqual([{ city: 'Oslo' }, { city: 'Oslo' }]);
});
