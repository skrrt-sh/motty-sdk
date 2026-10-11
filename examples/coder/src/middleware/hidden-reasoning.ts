import { answer, motty, type Chunk } from "@mottyjs/core";

async function* withoutReasoning(chunks: AsyncIterable<Chunk>): AsyncIterable<Chunk> {
  for await (const chunk of chunks) {
    if (chunk.type !== "reasoning") yield chunk;
  }
}

export const hiddenReasoning = motty({ name: "hidden-reasoning" }).afterHandle((ctx) => {
  ctx.answer = answer(withoutReasoning(ctx.answer.chunks()), ctx.answer);
});
