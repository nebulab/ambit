/**
 * Runs `dist/cli.js` under **Node** against the fixture catalog, and fails if anything about it is
 * off.
 *
 * The npm package is the only artifact ambit ships that Bun does not run, and the ways it breaks are
 * not ways the suite can see: `bun test` executes `src/`, not the bundle, and the bundle is where a
 * dependency resolved by Node's rules rather than Bun's turns up. jsonc-parser is the standing
 * example — Node takes its UMD build, whose inner `require` a bundler cannot follow — so this
 * installs for real rather than asking the binary for its version, and touches every document format
 * ambit writes on the way.
 *
 * Run after `bun run build`, with `node` on the PATH. Exits non-zero with the child's own output.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildFixtureCatalog } from "./fixture-catalog.js";

const BUNDLE = "dist/cli.js";

/** Both harnesses, so the run writes JSON, JSONC and TOML rather than only the first. */
const PROFILE = `version: 1
harnesses: [claude, codex]

catalogs:
  - name: company
    source: path:../catalog

requires:
  - pack: "company/function.engineering"
  - pack: "company/project.acme"
`;

/** Runs the bundle under Node, returning its exit code and everything it printed. */
function ambit(args: readonly string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BUNDLE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/** Runs one command, printing what it printed, and throwing if it failed. */
async function expectSuccess(args: readonly string[]): Promise<void> {
  const { code, output } = await ambit(args);
  console.log(`$ node ${BUNDLE} ${args.join(" ")}\n${output}`);
  if (code !== 0) throw new Error(`\`${args.join(" ")}\` exited ${code}`);
}

const root = await mkdtemp(path.join(tmpdir(), "ambit-smoke-"));
const project = path.join(root, "project");

try {
  await buildFixtureCatalog(path.join(root, "catalog"));
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "ambit.yml"), PROFILE, "utf8");

  await expectSuccess(["--version"]);
  // `--explain` walks the whole selection, so a dependency that only breaks once it is used breaks
  // here rather than in a user's project.
  await expectSuccess(["resolve", "--explain", "--json", "--project", project]);
  await expectSuccess(["install", "--project", project]);
  // Nothing drifted the moment after installing, which is what says the artifacts install wrote are
  // the ones resolution asked for — read back out of every format it just wrote.
  await expectSuccess(["status", "--check", "--project", project]);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("smoke test passed");
