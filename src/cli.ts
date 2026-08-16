import { run } from "./cli/program.js";
import { ExitCode } from "./errors.js";
import { MODULE_URL } from "./self/platform.js";
import { updateNotice } from "./self/notice.js";

const argv = process.argv.slice(2);

const code = await run(argv, {
  cwd: process.cwd(),
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});

/**
 * The update notice lives here rather than in `run`, for two reasons. `run` is what the suite
 * drives, and a check that reached the network would make every test in the suite do so. And
 * whether a person is watching is a property of the real process's stderr, which `run` is
 * deliberately given no access to: it takes two functions, not two streams.
 *
 * Only after a command that succeeded. Advice stacked on top of an error is noise at the moment a
 * reader has something else to read, and the error already ends in a next step of its own.
 */
if (code === ExitCode.Success) {
  try {
    const notice = await updateNotice({
      env: process.env,
      argv,
      isTty: process.stderr.isTTY === true,
      now: Date.now(),
      moduleUrl: MODULE_URL,
      mainPath: process.argv[1] ?? "",
      fetch: (url, init) => fetch(url, init),
    });
    if (notice !== undefined) process.stderr.write(`${notice}\n`);
  } catch {
    // Never at the cost of the command that already worked.
  }
}

process.exitCode = code;
