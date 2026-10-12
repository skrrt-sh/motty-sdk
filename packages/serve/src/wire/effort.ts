import type { Json, Options } from '@mottyjs/core/host';

export type Effort = NonNullable<NonNullable<Options['reasoning']>['effort']>;

const ladder: readonly Effort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

// A level an upstream or a model has no word for goes as the nearest it
// has, and as the higher of two equally near. An order not to reason that
// it has no word for goes as its lowest level.
export function nearest(
  levels: readonly Effort[] | undefined,
  level: Effort,
): Effort | undefined {
  if (levels === undefined || levels.includes(level)) return level;
  const at = ladder.indexOf(level);
  const [first] = levels
    .filter((each) => each !== 'none')
    .map((each) => ({ each, rank: ladder.indexOf(each) }))
    .sort(
      (one, other) =>
        Math.abs(one.rank - at) - Math.abs(other.rank - at) ||
        other.rank - one.rank,
    );
  return first?.each;
}

// Both OpenAI APIs name every neutral effort as the neutral option does.
export function isEffort(value: Json | undefined): value is Effort {
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return true;
    default:
      return false;
  }
}
