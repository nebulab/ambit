/**
 * Exit codes. Every failure path maps onto exactly one of these.
 */
export const ExitCode = {
  Success: 0,
  Internal: 1,
  /** Config or ownership error. */
  Config: 2,
  /** Resolution error — unknown scope, missing requirement, cycle, name conflict. */
  Resolution: 3,
  /** Network or cache error. */
  Network: 4,
  /** Drift detected (`status --check`, `install --frozen`). */
  Drift: 5,
  /** A health check found something: `doctor` failures. */
  Doctor: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * An error with a known exit code and a message already formatted for the user.
 *
 * Every message names the offending file, the offending identifier, and one
 * concrete next step. `detail` lines carry the latter two; they are printed indented under
 * the summary.
 */
export class AmbitError extends Error {
  readonly code: ExitCode;
  readonly detail: readonly string[];

  constructor(code: ExitCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = "AmbitError";
    this.code = code;
    this.detail = detail;
  }

  /** The full multi-line rendering, without the trailing newline. */
  format(): string {
    const head = `error: ${this.message}`;
    if (this.detail.length === 0) return head;
    return [head, ...this.detail.map((line) => `       ${line}`)].join("\n");
  }
}

/**
 * The `(file line N)` suffix a message carries, degrading to `(file)` when nothing positioned
 * the value.
 *
 * Spec §6 requires every error to name the offending file, and the line is what makes it
 * actionable — so the two are rendered in one place rather than per call site, including for
 * errors raised long after the document was parsed.
 */
export function at(file: string, line: number | undefined): string {
  return line === undefined ? `(${file})` : `(${file} line ${line})`;
}

export function configError(message: string, detail?: readonly string[]): AmbitError {
  return new AmbitError(ExitCode.Config, message, detail);
}

export function resolutionError(message: string, detail?: readonly string[]): AmbitError {
  return new AmbitError(ExitCode.Resolution, message, detail);
}

export function networkError(message: string, detail?: readonly string[]): AmbitError {
  return new AmbitError(ExitCode.Network, message, detail);
}

export function driftError(message: string, detail?: readonly string[]): AmbitError {
  return new AmbitError(ExitCode.Drift, message, detail);
}
