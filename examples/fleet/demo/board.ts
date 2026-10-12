import { z } from "zod";
import { name } from "../src/models";

// The reply comes off the wire, so it is read through a schema, not trusted by type
const Reply = z.object({
  choices: z.tuple([z.object({ message: z.object({ content: z.string() }) })]),
});

// The board is asked for the way anyone would, with a plain chat request that names no agent
export async function board(url: string): Promise<string> {
  const asked = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: name, messages: [{ role: "user", content: "status?" }] }),
  });
  return Reply.parse(await asked.json()).choices[0].message.content;
}

if (import.meta.main) console.log(await board(Bun.argv[2] ?? "http://localhost:3000"));
