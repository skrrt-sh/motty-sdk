const { PATH } = Bun.env;

// The directory a harness works in is its home too, so the user's own
// settings are neither read nor written.
export async function harnessed(
  command: string[],
  dir: string,
  env: { [name: string]: string },
) {
  const harness = Bun.spawn(command, {
    cwd: dir,
    env: { PATH, HOME: dir, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, said, complained] = await Promise.all([
    harness.exited,
    harness.stdout.text(),
    harness.stderr.text(),
  ]);
  return { exit, said, complained };
}
