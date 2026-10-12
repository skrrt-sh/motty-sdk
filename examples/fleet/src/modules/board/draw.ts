import { answer, type Answer } from "@mottyjs/core";
import { stopped } from "../../middleware/brake";
import { rows, spent } from "../../middleware/ledger";

const usd = (amount: number) => `$${amount.toFixed(3)}`;

export async function drawn(budget: number): Promise<Answer> {
  const [kept, total] = await Promise.all([rows(), spent()]);
  const lines = await Promise.all(
    kept.map(async (row) => {
      if (row === undefined) return "";
      const who = row.seat === "lead" ? "lead" : `sub ${row.seat.slice(-6)}`;
      const model = row.model.replace(/^[^/]*\//, "");
      const failed = row.failed > 0 ? `${row.failed} FAILED ` : "";
      const closed = (await stopped(row.seat)) ? "STOPPED " : "";
      return [
        who.padEnd(11),
        model.padEnd(17),
        String(row.requests).padStart(3),
        "req",
        `${usd(row.cost).padStart(8)}  ${failed}${closed}${row.task}`,
      ].join(" ");
    }),
  );
  return answer([...lines, `spent ${usd(total)} of ${usd(budget)}`].join("\n"));
}
