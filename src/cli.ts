import { run } from "./program.js";

const code = await run(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});

process.exitCode = code;
