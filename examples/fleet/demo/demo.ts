import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mount } from "@mottyjs/serve";
import { name } from "../src/models";
import fleet from "../src/motty";
import { host } from "../src/serve";
import { board } from "./board";

const [scouts = "small", budget = "1", agent = "claude", asked = name] = Bun.argv.slice(2);
const { PATH } = Bun.env;

const served = mount(fleet, () => ({
  ...host({ ...Bun.env, SCOUTS: scouts, BUDGET: budget }),
  // The board is what a run shows, and a record printed after each request would break it up
  report: () => {},
}));

using server = Bun.serve({ port: 0, fetch: served.fetch, idleTimeout: 240 });
const url = `http://localhost:${server.port}`;
const dir = await mkdtemp(join(tmpdir(), "motty-fleet-"));
// Codex wants its home to be there already, and Claude Code makes its own
await mkdir(join(dir, ".codex"));
for (const module of ["orders", "payments", "users", "stock", "mail"]) {
  await Bun.write(
    join(dir, `${module}.ts`),
    `import { db } from "./db";\n\nexport const list = () => db.all("${module}");\nexport const find = (id: string) => db.one("${module}", id);\n`,
  );
}

const began = Date.now();
const seconds = () => Math.round((Date.now() - began) / 1000);
const shown = { board: "" };
const watching = setInterval(async () => {
  const now = await board(url);
  if (now === shown.board) return;
  shown.board = now;
  // A terminal is redrawn in place, and a pipe gets each new board under the last
  console.log(`${process.stdout.isTTY ? "\x1b[2J\x1b[H" : ""}--- ${seconds()} s\n${now}`);
}, 500);
const task =
  "Understand this repo. Use one subagent per module, in parallel, and then tell me in five short lines what each module does.";
// Each agent keeps its settings in the temporary directory, so the ones of whoever runs this stay as they are
const agents = {
  claude: {
    command: [
      "claude",
      "--print",
      task,
      "--permission-mode",
      "acceptEdits",
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    env: {
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_API_KEY: "not-a-key",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
  },
  codex: {
    command: [
      "codex",
      "exec",
      "--skip-git-repo-check",
      "-m",
      asked,
      "-c",
      'model_provider="fleet"',
      "-c",
      `model_providers.fleet={name="fleet",base_url="${url}/v1",env_key="FLEET_KEY",wire_api="responses"}`,
      task,
    ],
    env: { CODEX_HOME: join(dir, ".codex"), FLEET_KEY: "not-a-key" },
  },
};
const { command, env } = agent === "codex" ? agents.codex : agents.claude;
const harness = Bun.spawn(command, {
  cwd: dir,
  env: { PATH, HOME: dir, ...env },
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const [exit, said, complained] = await Promise.all([
  harness.exited,
  harness.stdout.text(),
  harness.stderr.text(),
]);

clearInterval(watching);
console.log(`\n${agent}, scouts ${scouts}, budget $${budget}, exit ${exit}, ${seconds()} s\n${await board(url)}`);
console.log(`\n${said.trim()}${complained.slice(0, 300)}`);
await served.close();
await rm(dir, { recursive: true });
