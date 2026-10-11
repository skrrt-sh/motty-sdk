import type { ErrorFacts } from '@mottyjs/core/host';

// A stream that broke may work when asked again, whatever broke it.
function broken(message: string): ErrorFacts {
  return { code: 'upstream_failed', message, retryable: true, upstream: true };
}

export function unreadable(): ErrorFacts {
  return broken('The upstream sent an event that cannot be read');
}

export function cutShort(): ErrorFacts {
  return broken('The upstream closed the stream before it finished');
}
