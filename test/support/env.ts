/**
 * Environment stubbing for the suite, which `bun:test` has no equivalent of.
 *
 * Every expectation ambit checks is an environment variable, so most suites have to run against an
 * environment they chose rather than the developer's. The original value of each name is recorded on
 * the first stub and put back by {@link restoreEnv}, so a suite that stubs a variable the machine
 * really has does not leave it changed for whatever runs next — `bun test` shares one process across
 * files.
 */

/** The value each stubbed name had before the first stub, `undefined` for a name that was unset. */
const original = new Map<string, string | undefined>();

/** Sets `name` for the rest of the file, or unsets it when `value` is `undefined`. */
export function stubEnv(name: string, value: string | undefined): void {
  if (!original.has(name)) original.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Puts every name {@link stubEnv} touched back the way it was found. */
export function restoreEnv(): void {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  original.clear();
}
