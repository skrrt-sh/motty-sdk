import { expect, test } from 'bun:test';
import { baseline, failures } from '../budget.ts';
import { measure } from '../measure.ts';

test('the measurement stays within the recorded baseline', async () => {
  const measured = await measure();
  const recorded = Bun.file('gates/baseline.json');

  if ('RECORD' in Bun.env) {
    const { size, typeCost } = measured;
    await Bun.write(
      recorded,
      `${JSON.stringify({ size, typeCost }, null, 2)}\n`,
    );
  }

  expect(failures(baseline(await recorded.json()), measured)).toEqual([]);
}, 60_000);
