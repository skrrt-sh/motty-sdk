import { think, UpstreamFailed, type Model, type Prompt } from "@mottyjs/core";

const QUORUM = 2;

// The caller reads each panelist as reasoning while the others are still writing
async function opinionOf(seat: Model, prompt: Prompt): Promise<string> {
  const reply = await seat.complete(prompt);
  think(reply);
  return reply.text();
}

export async function ask(seats: readonly Model[], prompt: Prompt): Promise<string[]> {
  const asked = await Promise.allSettled(seats.map((seat) => opinionOf(seat, prompt)));
  const opinions = asked.flatMap((seat) =>
    seat.status === "fulfilled" && seat.value.trim() ? [seat.value] : [],
  );
  if (opinions.length < QUORUM) {
    const failures: unknown[] = asked.flatMap((seat) =>
      seat.status === "rejected" ? [seat.reason] : [],
    );
    throw new UpstreamFailed(
      `${opinions.length} of ${seats.length} panelists answered, and a council needs ${QUORUM}`,
      { cause: failures[0] },
    );
  }
  return opinions;
}
