import { isMarked, type Marked } from "@mottyjs/core/host";
import { $ } from "bun";

const folder = `${import.meta.dir}/..`;

export const file = `${folder}/dist/motty.js`;

// Built by the script an author runs, and read as a host reads it: a file it knows nothing of
// but the mark on its default export
export async function bundled(): Promise<Marked> {
  await $`bun run build`.cwd(folder).quiet();
  const loaded: unknown = await import(file);
  if (
    typeof loaded === "object" &&
    loaded !== null &&
    "default" in loaded &&
    isMarked(loaded.default)
  ) {
    return loaded.default;
  }
  throw new Error("The default export of the bundle is not a motty");
}
