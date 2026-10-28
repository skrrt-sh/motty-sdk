// The stores count whole milliseconds and refuse none. A time that is no
// count is the caller's mistake, so it is named before any call.
export function milliseconds(ttl: number): number {
  if (!(ttl >= 1) || !Number.isSafeInteger(ttl)) {
    throw new Error(
      `A time to live is a positive, whole number of milliseconds, and ${ttl} is not`,
    );
  }
  return ttl;
}
