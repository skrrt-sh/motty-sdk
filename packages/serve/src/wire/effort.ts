import type { Json, Options } from '@mottyjs/core/host';

type Effort = NonNullable<NonNullable<Options['reasoning']>['effort']>;

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
