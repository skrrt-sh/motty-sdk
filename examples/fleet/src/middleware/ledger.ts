import { motty, type Message } from "@mottyjs/core";
import { store } from "@mottyjs/store";
import { z } from "zod";
import { seat } from "./seat";

// Another release may have written the row, so it is read through a schema, not trusted by type
const Row = z.object({ seat: z.string(), model: z.string(), task: z.string() });

export const spent = async () => (await store.get<number>("spent")) ?? 0;

async function rowAt(number: number) {
  const row = Row.safeParse(await store.get(`row:${number}`)).data;
  if (row === undefined) return undefined;
  const [requests = 0, cost = 0, failed = 0] = await Promise.all([
    store.get<number>(`requests:${row.seat}`),
    store.get<number>(`cost:${row.seat}`),
    store.get<number>(`failed:${row.seat}`),
  ]);
  return { ...row, requests, cost, failed };
}

export async function rows() {
  const seats = (await store.get<number>("seats")) ?? 0;
  return Promise.all(Array.from({ length: seats }, (_, index) => rowAt(index + 1)));
}

// An agent puts its own notes ahead of what it was asked, so the last text is the task
const said = (message: Message | undefined) =>
  message?.text ??
  message?.parts?.flatMap((part) => (part.type === "text" ? [part.text] : [])).at(-1) ??
  "";

// A seat is numbered the first time it is seen, so the board can list what it cannot search for
export const ledger = motty({ name: "ledger" })
  .use(seat)
  .afterResponse(async ({ request, family, seat, calls, outcome }) => {
    if (family === undefined || seat === undefined) return;
    // A request that failed before any model was called still has a row, under the name it asked for
    const model = calls.made.at(-1)?.model ?? request.model;
    if ((await store.increment(`requests:${seat}`)) === 1) {
      const task = said(request.messages.findLast((message) => message.role === "user"));
      const line = task.replace(/\/\S*\//g, "").replace(/\s+/g, " ");
      // A row stays on one line of a terminal, and a cut task says that it was cut
      const row = { seat, model, task: line.length > 70 ? `${line.slice(0, 69)}…` : line };
      await store.set(`row:${await store.increment("seats")}`, row);
    }
    if (outcome === "failed") await store.increment(`failed:${seat}`);
    const { cost = 0 } = calls.total;
    await store.increment(`cost:${seat}`, cost);
    await store.increment("spent", cost);
  });
