import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function listening(control: number | null | undefined) {
  if (typeof control !== 'number') return undefined;
  let reported = '';
  const events = Bun.file(control)
    .stream()
    .pipeThrough(new TextDecoderStream());
  for await (const piece of events) {
    reported += piece;
    const port = /"event":"listen","socket":"http","port":(\d+)/.exec(
      reported,
    )?.[1];
    if (port !== undefined) return port;
  }
  return undefined;
}

// Shown as it comes, so what a worker logs while it serves is not lost.
async function forwarded(errors: ReadableStream<Uint8Array<ArrayBuffer>>) {
  let written = '';
  for await (const piece of errors.pipeThrough(new TextDecoderStream())) {
    process.stderr.write(piece);
    written += piece;
  }
  return written;
}

export async function workerd(worker: {
  // The first is the main module.
  modules: { readonly [name: string]: string };
  flags: readonly string[];
  bindings: { readonly [name: string]: string };
  // A binding to the Durable Object class of that name, kept in SQLite on
  // disk, since workerd keeps no SQLite in memory.
  objects?: { readonly [name: string]: string };
}): Promise<{ address: string; stop: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'workerd-'));
  const { objects = {} } = worker;
  await mkdir(join(folder, 'objects'));
  await Promise.all(
    Object.entries(worker.modules).map(([name, source]) =>
      Bun.write(join(folder, 'modules', name), source),
    ),
  );
  await Bun.write(
    join(folder, 'config.capnp'),
    `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .worker),
    (name = "network", network = (allow = ["local", "private"])),
    (name = "disk", disk = (path = ${JSON.stringify(join(folder, 'objects'))}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "main")],
);

const worker :Workerd.Worker = (
  modules = [${Object.keys(worker.modules)
    .map(
      (name) =>
        `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(`modules/${name}`)})`,
    )
    .join(', ')}],
  compatibilityDate = "2026-01-01",
  compatibilityFlags = ${JSON.stringify(worker.flags)},
  bindings = [${[
    ...Object.entries(worker.bindings).map(
      ([name, text]) =>
        `(name = ${JSON.stringify(name)}, text = ${JSON.stringify(text)})`,
    ),
    ...Object.entries(objects).map(
      ([name, kind]) =>
        `(name = ${JSON.stringify(name)}, durableObjectNamespace = ${JSON.stringify(kind)})`,
    ),
  ].join(', ')}],
  durableObjectNamespaces = [${Object.values(objects)
    .map(
      (kind) =>
        `(className = ${JSON.stringify(kind)}, uniqueKey = ${JSON.stringify(kind)}, enableSql = true)`,
    )
    .join(', ')}],
  durableObjectStorage = (localDisk = "disk"),
  globalOutbound = "network",
);
`,
  );
  const served = Bun.spawn(
    [
      `${import.meta.dir}/../../node_modules/.bin/workerd`,
      'serve',
      '--control-fd=3',
      join(folder, 'config.capnp'),
    ],
    { stdio: ['ignore', 'inherit', 'pipe', 'pipe'] },
  );
  const written = forwarded(served.stderr);
  async function stop() {
    served.kill();
    await served.exited;
    await rm(folder, { recursive: true, force: true });
  }
  const port = await listening(served.stdio[3]);
  if (port === undefined) {
    await stop();
    throw new Error(`workerd did not start: ${(await written).trim()}`);
  }
  return { address: `http://127.0.0.1:${port}`, stop };
}
