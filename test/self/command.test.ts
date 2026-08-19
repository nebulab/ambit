/**
 * `ambit self-update` as a user reaches it: the spec, the rule, and the handler wired together.
 *
 * The suite runs under `bun test`, which is not a compiled binary, so every invocation here lands
 * on the same refusal. That is the point: it is the exact refusal an npm user gets, and it proves
 * the command is dispatched rather than reported unimplemented.
 */
import { describe, expect, it } from "bun:test";

import { ExitCode } from "../../src/errors.js";
import { run } from "../../src/cli/program.js";

interface Invocation {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(...argv: readonly string[]): Promise<Invocation> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    cwd: process.cwd(),
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("ambit self-update", () => {
  it("is dispatched, and refuses an install it cannot replace", async () => {
    const result = await invoke("self-update");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("installed from npm");
    expect(result.stderr).toContain("npm i -g @teamnebulab/ambit@latest");
    expect(result.stdout).toBe("");
  });

  it("refuses `--offline` before it gets that far", async () => {
    const result = await invoke("self-update", "--offline");

    expect(result.code).toBe(ExitCode.Network);
    expect(result.stderr).toContain("`--offline` cannot install a release");
  });

  it("refuses `--project`, which names something it does not act on", async () => {
    const result = await invoke("self-update", "--project", ".");

    expect(result.code).toBe(ExitCode.Config);
    expect(result.stderr).toContain("unknown option '--project'");
  });

  it("takes the version as a positional, since `--version` prints ambit's own", async () => {
    const usage = await invoke("self-update", "--help");

    expect(usage.code).toBe(ExitCode.Success);
    expect(usage.stdout).toContain("[version]");
    expect(usage.stdout).not.toContain("--version");
  });
});
