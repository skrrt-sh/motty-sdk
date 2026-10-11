import { expect, test } from 'bun:test';
import { baseline, failures } from '../budget.ts';

function recorded() {
  return {
    size: { core: 100 },
    typeCost: { instantiations: 1000, types: 2000 },
  };
}

function measured() {
  return {
    ...recorded(),
    reproducibility: { core: ['a1', 'a1'] },
    timePerCall: { request: 1 },
  };
}

function failedGates(...args: Parameters<typeof failures>) {
  return failures(...args).map((failure) => failure.gate);
}

test('a measurement at the baseline passes', () => {
  expect(failedGates(recorded(), measured())).toEqual([]);
});

test('a smaller measurement passes', () => {
  expect(
    failedGates(recorded(), { ...measured(), size: { core: 99 } }),
  ).toEqual([]);
});

test('size one byte over fails', () => {
  expect(
    failedGates(recorded(), { ...measured(), size: { core: 101 } }),
  ).toEqual(['size']);
});

test('type counts at exactly five percent over pass', () => {
  expect(
    failedGates(recorded(), {
      ...measured(),
      typeCost: { instantiations: 1050, types: 2100 },
    }),
  ).toEqual([]);
});

test('either type count just past five percent fails', () => {
  expect(
    failures(recorded(), {
      ...measured(),
      typeCost: { instantiations: 1051, types: 2101 },
    }),
  ).toHaveLength(2);
  expect(
    failedGates(recorded(), {
      ...measured(),
      typeCost: { instantiations: 1000, types: 2101 },
    }),
  ).toEqual(['typeCost']);
});

test('a request faster than on the base commit passes', () => {
  expect(
    failedGates(recorded(), { ...measured(), timePerCall: { request: 0.8 } }),
  ).toEqual([]);
});

test('a request fifteen percent slower than on the base commit passes and past it fails', () => {
  expect(
    failedGates(recorded(), { ...measured(), timePerCall: { request: 1.15 } }),
  ).toEqual([]);
  expect(
    failedGates(recorded(), { ...measured(), timePerCall: { request: 1.16 } }),
  ).toEqual(['timePerCall']);
});

test('no time subjects passes', () => {
  expect(failedGates(recorded(), { ...measured(), timePerCall: {} })).toEqual(
    [],
  );
});

test('differing hashes fail', () => {
  expect(
    failedGates(recorded(), {
      ...measured(),
      reproducibility: { core: ['a1', 'b2'] },
    }),
  ).toEqual(['reproducibility']);
});

test('a measured key absent from the baseline fails', () => {
  expect(
    failedGates(
      { ...recorded(), size: {} },
      { ...measured(), size: { core: 0 } },
    ),
  ).toEqual(['size']);
});

test('a recorded baseline is read back as it was written', () => {
  expect(baseline(JSON.parse(JSON.stringify(recorded())))).toEqual(recorded());
});

test('a malformed baseline is rejected', () => {
  expect(() => baseline({ size: { core: 100 } })).toThrow();
  expect(() =>
    baseline({ ...recorded(), typeCost: { types: '2000' } }),
  ).toThrow();
});
