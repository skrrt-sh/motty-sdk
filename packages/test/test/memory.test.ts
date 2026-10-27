import { expect, setSystemTime, test } from 'bun:test';
import { memory } from '../src/index.ts';

test('a value set is read back and gone once deleted', async () => {
  const storage = memory();

  await storage.set('tier:c1', { tier: 'deep', turns: [1, 2] });
  const held = await storage.get('tier:c1');
  await storage.delete('tier:c1');

  expect(held).toEqual({ tier: 'deep', turns: [1, 2] });
  expect(await storage.get('tier:c1')).toBeUndefined();
});

test('what is read back is a copy of what was set', async () => {
  const storage = memory();
  const turns = [1, 2];

  await storage.set('turns', turns);
  turns.push(3);

  expect(await storage.get('turns')).toEqual([1, 2]);
});

test('what was read back can be changed without changing what is stored', async () => {
  const storage = memory();
  await storage.set('turns', [1, 2]);

  const read = await storage.get('turns');
  if (Array.isArray(read)) read.push(3);

  expect(read).toEqual([1, 2, 3]);
  expect(await storage.get('turns')).toEqual([1, 2]);
});

test('a value set with a time to live is gone after that many milliseconds', async () => {
  const storage = memory();
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await storage.set('tier:c1', 'deep', { ttl: 60_000 });

  setSystemTime(new Date('2026-01-01T00:00:59Z'));
  const before = await storage.get('tier:c1');
  setSystemTime(new Date('2026-01-01T00:01:00Z'));
  const after = await storage.get('tier:c1');
  setSystemTime();

  expect(before).toBe('deep');
  expect(after).toBeUndefined();
});

test.each([0, 1.5, Number.NaN])(
  'a time to live of %p is refused in the words a real store refuses it in',
  async (ttl) => {
    const storage = memory();

    await expect(storage.set('tier:c1', 'deep', { ttl })).rejects.toThrow(
      `A time to live is a positive, whole number of milliseconds, and ${ttl} is not`,
    );
    expect(await storage.get('tier:c1')).toBeUndefined();
  },
);

test('an increment of a key never set starts from zero, and the total is read back as a number', async () => {
  const storage = memory();

  const total = await storage.increment?.('spent', 2.5);

  expect(total).toBe(2.5);
  expect(await storage.get('spent')).toBe(2.5);
});

test('an increment adds to the number held, and takes away with an amount below zero', async () => {
  const storage = memory();
  await storage.set('spent', 4);

  const totals = [
    await storage.increment?.('spent', 1),
    await storage.increment?.('spent', -3),
  ];

  expect(totals).toEqual([5, 2]);
  expect(await storage.get('spent')).toBe(2);
});

test('a total past the largest number is refused in the words a real store refuses it in, and the value stays', async () => {
  const storage = memory();
  await storage.set('spent', 1.7976931348623157e308);

  await expect(
    storage.increment?.('spent', 1.7976931348623157e308),
  ).rejects.toThrow(
    'The total stored under spent would not be a finite number',
  );
  await expect(
    storage.increment?.('owed', -1.7976931348623157e308),
  ).resolves.toBe(-1.7976931348623157e308);
  await expect(
    storage.increment?.('owed', -1.7976931348623157e308),
  ).rejects.toThrow('The total stored under owed would not be a finite number');
  expect(await storage.get('spent')).toBe(1.7976931348623157e308);
  expect(await storage.get('owed')).toBe(-1.7976931348623157e308);
});

test.each([
  [Number.NaN, null],
  [-0, 0],
  [
    [Number.NaN, -0],
    [null, 0],
  ],
  [
    { spent: -0, left: Number.POSITIVE_INFINITY },
    { spent: 0, left: null },
  ],
])(
  'a set %p is read back as %p, as the JSON text of a real store reads',
  async (value, read) => {
    const storage = memory();

    await storage.set('spent', value);

    expect(await storage.get('spent')).toStrictEqual(read);
  },
);

test('increments made at once are all kept', async () => {
  const storage = memory();

  const totals = await Promise.all(
    Array.from({ length: 20 }, () => storage.increment?.('turns', 1)),
  );

  expect(totals.toSorted((one, other) => (one ?? 0) - (other ?? 0))).toEqual(
    Array.from({ length: 20 }, (_, at) => at + 1),
  );
  expect(await storage.get('turns')).toBe(20);
});

test('the time to live is set by the increment that made the key and left alone by the ones after', async () => {
  const storage = memory();
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await storage.increment?.('spent', 1, { ttl: 60_000 });

  setSystemTime(new Date('2026-01-01T00:00:30Z'));
  await storage.increment?.('spent', 1, { ttl: 60_000 });
  setSystemTime(new Date('2026-01-01T00:00:59Z'));
  const before = await storage.get('spent');
  setSystemTime(new Date('2026-01-01T00:01:00Z'));
  const after = await storage.get('spent');
  setSystemTime();

  expect(before).toBe(2);
  expect(after).toBeUndefined();
});

test('an increment with a time to live gives none to a key that was set without one', async () => {
  const storage = memory();
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await storage.set('spent', 4);
  await storage.increment?.('spent', 1, { ttl: 60_000 });

  setSystemTime(new Date('2026-01-01T01:00:00Z'));
  const held = await storage.get('spent');
  setSystemTime();

  expect(held).toBe(5);
});

test('an increment keeps the time to live the key was set with', async () => {
  const storage = memory();
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await storage.set('spent', 4, { ttl: 60_000 });
  await storage.increment?.('spent', 1);

  setSystemTime(new Date('2026-01-01T00:01:00Z'));
  const held = await storage.get('spent');
  setSystemTime();

  expect(held).toBeUndefined();
});

test('an increment of a key whose time ran out starts from zero, with a time to live of its own', async () => {
  const storage = memory();
  setSystemTime(new Date('2026-01-01T00:00:00Z'));
  await storage.set('spent', 4, { ttl: 60_000 });

  setSystemTime(new Date('2026-01-01T00:01:00Z'));
  const total = await storage.increment?.('spent', 1, { ttl: 60_000 });
  setSystemTime(new Date('2026-01-01T00:01:59Z'));
  const before = await storage.get('spent');
  setSystemTime(new Date('2026-01-01T00:02:00Z'));
  const after = await storage.get('spent');
  setSystemTime();

  expect(total).toBe(1);
  expect(before).toBe(1);
  expect(after).toBeUndefined();
});

test.each(['5', null])(
  'an increment of a held %p is refused in the words a real store refuses it in, and the value stays',
  async (value) => {
    const storage = memory();
    await storage.set('tier:c1', value);

    await expect(storage.increment?.('tier:c1', 1)).rejects.toThrow(
      'The value stored under tier:c1 is not a number',
    );
    expect(await storage.get('tier:c1')).toEqual(value);
  },
);

test.each([Number.POSITIVE_INFINITY])(
  'an increment by %p is refused in the words a real store refuses it in',
  async (by) => {
    const storage = memory();

    await expect(storage.increment?.('spent', by)).rejects.toThrow(
      `An increment is a finite number, and ${by} is not`,
    );
    expect(await storage.get('spent')).toBeUndefined();
  },
);

test.each([0])(
  'an increment with a time to live of %p is refused as a set with it is, whether or not the key is held',
  async (ttl) => {
    const storage = memory();
    await storage.set('held', 4);

    await expect(storage.increment?.('spent', 1, { ttl })).rejects.toThrow(
      `A time to live is a positive, whole number of milliseconds, and ${ttl} is not`,
    );
    await expect(storage.increment?.('held', 1, { ttl })).rejects.toThrow(
      `A time to live is a positive, whole number of milliseconds, and ${ttl} is not`,
    );
    expect(await storage.get('spent')).toBeUndefined();
    expect(await storage.get('held')).toBe(4);
  },
);

test('two memories share nothing', async () => {
  const first = memory();

  await first.set('tier:c1', 'deep');

  expect(await memory().get('tier:c1')).toBeUndefined();
});
