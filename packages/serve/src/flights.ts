// A request is in flight until its record has been delivered: that is after
// the work done once the response has ended, which the response does not
// wait for.
export function flights() {
  const open = new Set<{
    over: Promise<void>;
    stop: (reason: unknown) => void;
  }>();

  function begin(stop: (reason: unknown) => void) {
    const landing = Promise.withResolvers<void>();
    const flight = { over: landing.promise, stop };
    open.add(flight);
    return {
      over: landing.promise,
      // The work is the delivery of the record, and never rejects.
      land: (work: Promise<void>): void => {
        work.then(() => {
          open.delete(flight);
          landing.resolve();
        });
      },
    };
  }

  async function landed(bound: number): Promise<boolean> {
    if (open.size === 0) return true;
    const late = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => late.resolve(false), bound);
    const all = Promise.all([...open].map(({ over }) => over));
    const inTime = await Promise.race([all.then(() => true), late.promise]);
    clearTimeout(timer);
    return inTime;
  }

  function stopAll(reason: unknown): void {
    for (const { stop } of open) stop(reason);
  }

  return { begin, landed, stopAll };
}
