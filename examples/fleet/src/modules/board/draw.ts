import { answer, type Answer } from "@mottyjs/core";
import { rows, spent } from "../../middleware/ledger";

const usd = (amount: number) => `$${amount.toFixed(3)}`;

export async function drawn(budget: number): Promise<Answer> {
  const sessions = Map.groupBy(await rows(), (row) => row.session);
  const blocks = await Promise.all(
    [...sessions].map(async ([session, seats]) => [
      ...seats.map((row) => {
        const who = row.seat === "lead" ? "lead" : `sub ${row.seat.slice(-6)}`;
        const model = row.model.replace(/^[^/]*\//, "");
        const failed = row.failed > 0 ? `${row.failed} FAILED ` : "";
        const closed = row.stopped ? "STOPPED " : "";
        return [
          who.padEnd(11),
          model.padEnd(17),
          String(row.requests).padStart(3),
          "req",
          `${usd(row.cost).padStart(8)}  ${failed}${closed}${row.task}`,
        ].join(" ");
      }),
      `spent ${usd(await spent(session))} of ${usd(budget)}`,
    ]),
  );
  const lines = blocks.length > 0 ? blocks.flat() : [`spent ${usd(0)} of ${usd(budget)}`];
  return answer(lines.join("\n"));
}
