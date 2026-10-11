function stated(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value === null || value.trim() === '' ? undefined : value;
}

function waited(ms: number): number | undefined {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : undefined;
}

// The standard header gives seconds or a date; some upstreams add one in
// milliseconds, which is the more exact and so is read first.
export function retryAfter(headers: Headers): number | undefined {
  const exact = waited(Number(stated(headers, 'retry-after-ms')));
  if (exact !== undefined) return exact;
  const after = stated(headers, 'retry-after');
  if (after === undefined) return undefined;
  return waited(Number(after) * 1000) ?? waited(Date.parse(after) - Date.now());
}

// The official client libraries obey this header before they look at a
// status, so an upstream that sends it has said whether another try can work.
export function shouldRetry(headers: Headers): boolean | undefined {
  const said = stated(headers, 'x-should-retry')?.trim().toLowerCase();
  if (said === 'true') return true;
  return said === 'false' ? false : undefined;
}
