import { motty, said } from "@mottyjs/core";
import { store } from "@mottyjs/store";
import { z } from "zod";
import { seat } from "./seat";

// A session's state is kept for a day, and the day is part of a row's key, so no reset has to run
const kept = 24 * 60 * 60 * 1000;
const today = () => Math.floor(Date.now() / kept);

// Another release may have written the row, so it is read through a schema, not trusted by type
const Row = z.object({ session: z.string(), seat: z.string(), model: z.string(), task: z.string() });

const total = (session: string) => `spent:${session}`;
const keys = (session: string, seat: string) => ({
  requests: `requests:${session}:${seat}`,
  cost: `cost:${session}:${seat}`,
  failed: `failed:${session}:${seat}`,
  stopped: `stopped:${session}:${seat}`,
});

export const spent = async (session: string) => (await store.get<number>(total(session))) ?? 0;

export const stop = (session: string, seat: string) =>
  store.set(keys(session, seat).stopped, true, { ttl: kept });

// A seat is counted before its row is written, and a row is gone a day later, so some are missing
async function rowAt(day: number, number: number) {
  const row = Row.safeParse(await store.get(`row:${day}:${number}`)).data;
  if (row === undefined) return [];
  const key = keys(row.session, row.seat);
  const [requests = 0, cost = 0, failed = 0, stopped = false] = await Promise.all([
    store.get<number>(key.requests),
    store.get<number>(key.cost),
    store.get<number>(key.failed),
    store.get<boolean>(key.stopped),
  ]);
  return [{ ...row, requests, cost, failed, stopped }];
}

// A row lives a day from its first request, so every row still alive began today or yesterday
export async function rows() {
  const found = await Promise.all(
    [today() - 1, today()].map(async (day) => {
      const seats = (await store.get<number>(`seats:${day}`)) ?? 0;
      return Promise.all(Array.from({ length: seats }, (_, index) => rowAt(day, index + 1)));
    }),
  );
  return found.flat(2);
}

// A seat is numbered the first time it is seen, so the board can list what it cannot search for
export const ledger = motty({ name: "ledger" })
  .use(seat)
  .afterResponse(async ({ request, agent, calls, outcome }) => {
    if (agent === undefined) return;
    const { session, seat } = agent;
    const key = keys(session, seat);
    // A request that failed before any model was called still has a row, under the name it asked for
    const model = calls.made.at(-1)?.model ?? request.model;
    if ((await store.increment(key.requests, 1, { ttl: kept })) === 1) {
      const task = said(request.messages.findLast((message) => message.role === "user"));
      const line = task.replace(/\/\S*\//g, "").replace(/\s+/g, " ");
      const day = today();
      // The count outlives the last row it numbered, which may be written at the end of its day
      const number = await store.increment(`seats:${day}`, 1, { ttl: 2 * kept });
      // A row stays on one line of a terminal, and a cut task says that it was cut
      const row = { session, seat, model, task: line.length > 70 ? `${line.slice(0, 69)}…` : line };
      await store.set(`row:${day}:${number}`, row, { ttl: kept });
    }
    if (outcome === "failed") await store.increment(key.failed, 1, { ttl: kept });
    const { cost = 0 } = calls.total;
    await store.increment(key.cost, cost, { ttl: kept });
    await store.increment(total(session), cost, { ttl: kept });
  });
