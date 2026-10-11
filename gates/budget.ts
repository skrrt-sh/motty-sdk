import type { Measured } from './measure.ts';

type Counts = Record<string, number>;

type Baseline = {
  [Gate in keyof Omit<Measured, 'reproducibility' | 'timePerCall'>]: Counts;
};

const percentOver = { size: 0, typeCost: 5, timePerCall: 15 };

function isCounts(value: unknown): value is Counts {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((count) => typeof count === 'number')
  );
}

export function baseline(recorded: unknown): Baseline {
  if (
    typeof recorded === 'object' &&
    recorded !== null &&
    'size' in recorded &&
    'typeCost' in recorded &&
    isCounts(recorded.size) &&
    isCounts(recorded.typeCost)
  ) {
    return { size: recorded.size, typeCost: recorded.typeCost };
  }
  throw new Error('The baseline is malformed, record it again');
}

function overBudget(allowed: Counts, measured: Counts, percent: number) {
  return Object.entries(measured).flatMap(([name, value]) => {
    const recorded = allowed[name];
    if (recorded === undefined) return [`${name} has no baseline`];
    return value * 100 > recorded * (100 + percent)
      ? [`${name} ${value} is over ${recorded} by more than ${percent}%`]
      : [];
  });
}

export function failures(allowed: Baseline, measured: Measured) {
  const reasons = {
    size: overBudget(allowed.size, measured.size, percentOver.size),
    reproducibility: Object.entries(measured.reproducibility).flatMap(
      ([name, hashes]) =>
        new Set(hashes).size > 1
          ? [`${name} built to different hashes ${hashes.join(' and ')}`]
          : [],
    ),
    typeCost: overBudget(
      allowed.typeCost,
      measured.typeCost,
      percentOver.typeCost,
    ),
    timePerCall: Object.entries(measured.timePerCall).flatMap(
      ([name, share]) =>
        share * 100 > 100 + percentOver.timePerCall
          ? [
              `${name} takes ${share} times what it takes on the base commit, over by more than ${percentOver.timePerCall}%`,
            ]
          : [],
    ),
  };
  return Object.entries(reasons).flatMap(([gate, found]) =>
    found.map((reason) => ({ gate, reason })),
  );
}
