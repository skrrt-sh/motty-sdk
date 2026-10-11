import { motty, QuotaExceeded } from "@mottyjs/core";
import { auth } from "@mottyjs/auth";
import { store } from "@mottyjs/store";
import { tuning } from "../settings";

const KEPT_SECONDS = 2 * 24 * 60 * 60;

// The day is part of the key, so a new day starts at nothing and no reset has to run
const spendKey = (callerId: string) =>
  `spend:${callerId}:${new Date().toISOString().slice(0, 10)}`;

export const dailyLimit = motty({ name: "daily-limit" })
  .use(auth())
  .use(tuning)
  .beforeHandle(async ({ caller, settings }) => {
    const { dailyUsd } = settings.spend;
    if (((await store.get<number>(spendKey(caller.id))) ?? 0) >= dailyUsd) {
      throw new QuotaExceeded(`Today's limit of $${dailyUsd} is spent`);
    }
  })
  // A request that failed or was left has paid for its calls all the same
  .afterResponse(async ({ caller, calls }) => {
    const { cost } = calls.total;
    if (!caller || !cost) return;
    // One step of the store: one caller's requests overlap, and each addition must be kept
    await store.increment(spendKey(caller.id), cost, { ttl: KEPT_SECONDS });
  });
