import { answer, motty, type Chunk } from "@mottyjs/core";

type Text = Extract<Chunk, { type: "text" }>;

const CARD_NUMBER = /\b\d(?:[ -]?\d){12,18}\b/g;
const UNFINISHED_NUMBER = /\d[\d -]*$/;

const removed = (chunk: Text, text: string): Text => ({
  ...chunk,
  text: text.replace(CARD_NUMBER, "[card number removed]"),
});

// A number may arrive split between chunks, so digits that end a chunk wait for what follows them
async function* withoutCardNumbers(chunks: AsyncIterable<Chunk>): AsyncIterable<Chunk> {
  let held: Text | undefined;
  for await (const chunk of chunks) {
    if (held && (chunk.type !== "text" || chunk.block !== held.block)) {
      yield removed(held, held.text);
      held = undefined;
    }
    if (chunk.type !== "text") {
      yield chunk;
      continue;
    }
    const text = (held?.text ?? "") + chunk.text;
    const cut = UNFINISHED_NUMBER.exec(text)?.index ?? text.length;
    if (cut > 0) yield removed(chunk, text.slice(0, cut));
    held = cut < text.length ? { ...chunk, text: text.slice(cut) } : undefined;
  }
  if (held) yield removed(held, held.text);
}

// The caller's agent keeps the transcript, where a card number a model quoted back must not land
export const cardNumbers = motty({ name: "card-numbers" }).afterHandle((ctx) => {
  ctx.answer = answer(withoutCardNumbers(ctx.answer.chunks()), ctx.answer);
});
