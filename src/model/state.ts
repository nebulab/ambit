/**
 * `.ambit/state.json` — the record of what ambit actually put on disk.
 *
 * Ambit deletes or overwrites only paths listed here, so a hand-written skill sitting at a target
 * path can never be touched. It is JSON rather than YAML because nothing reads it by hand, and a
 * crash-safety record wants one unambiguous serialization.
 *
 * Emission is sorted and byte-stable, same as the lock, so a state file does not reshuffle between
 * identical runs and hide the one change that matters in diff noise.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { configError } from "../errors.js";
import {
  DOCUMENT_FORMATS,
  DOCUMENT_SHAPES,
  type DocumentFormat,
  type DocumentShape,
} from "./documents/format.js";

/** The machine-local directory ambit keeps its state in. Always gitignored. */
export const STATE_DIRNAME = ".ambit";

/** The state file within it. */
export const STATE_FILENAME = "state.json";

/** The only state version this build understands. */
export const STATE_VERSION = 1;

/** What an owned artifact is. `harness-config` carries `managedKeys` instead of a `mode`. */
export const ARTIFACT_KINDS = ["harness-config", "hook-dir", "skill-dir", "skills-link"] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * How a materialized directory's source reaches its target: copied for remote sources, symlinked for
 * local ones.
 */
export const ARTIFACT_MODES = ["copy", "link"] as const;

export type ArtifactMode = (typeof ARTIFACT_MODES)[number];

/** One file or directory ambit created, addressed the only way that survives a move: relatively. */
export interface OwnedArtifact {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly kind: ArtifactKind;
  /** Set for `skill-dir`, `hook-dir` and `skills-link`. */
  readonly mode?: ArtifactMode;
  /** Set for `harness-config`: the dotted keys within the file ambit owns. */
  readonly managedKeys?: readonly string[];
  /**
   * Set for `harness-config`: how the file is parsed and written.
   *
   * Recorded because `prune` and `clean` act from state alone — they must edit a `.codex/config.toml`
   * as TOML without re-resolving the project to find out which harness wanted it. Absent reads as
   * `json`, which is what every artifact written before this field existed was.
   */
  readonly format?: DocumentFormat;
  /**
   * Set for `harness-config`: how the managed section is laid out.
   *
   * Recorded for the same reason `format` is, and it is not derivable from `format`: `.mcp.json` and
   * `.claude/settings.json` are both JSON, and the second holds one array per event rather than a
   * table keyed by name. Absent reads as `"map"`, which is what every artifact written before this
   * field existed was.
   */
  readonly shape?: DocumentShape;
}

/** The contents of `.ambit/state.json`. */
export interface State {
  readonly version: number;
  /** The harnesses the artifacts were written for. */
  readonly harnesses: readonly string[];
  readonly artifacts: readonly OwnedArtifact[];
}

/** What a project with no state file is treated as: ambit owns nothing there yet. */
export const EMPTY_STATE: State = {
  version: STATE_VERSION,
  harnesses: [],
  artifacts: [],
};

/** Where the state file lives for a project. */
export function stateFilePath(projectDir: string): string {
  return path.join(projectDir, STATE_DIRNAME, STATE_FILENAME);
}

/** The set of paths ambit may delete or overwrite. */
export function ownedPaths(state: State): ReadonlySet<string> {
  return new Set(state.artifacts.map((artifact) => artifact.path));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function artifactJson(artifact: OwnedArtifact): Readonly<Record<string, unknown>> {
  return {
    ...(artifact.format !== undefined && { format: artifact.format }),
    kind: artifact.kind,
    ...(artifact.managedKeys !== undefined && {
      managedKeys: [...artifact.managedKeys].sort(compare),
    }),
    ...(artifact.mode !== undefined && { mode: artifact.mode }),
    path: artifact.path,
    ...(artifact.shape !== undefined && { shape: artifact.shape }),
  };
}

/** Renders state as the bytes written to disk: keys sorted, artifacts by path, trailing newline. */
export function serializeState(state: State): string {
  const body = {
    artifacts: [...state.artifacts].sort((a, b) => compare(a.path, b.path)).map(artifactJson),
    harnesses: [...new Set(state.harnesses)].sort(compare),
    version: state.version,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function stateError(file: string, problem: string): never {
  throw configError(`${file} is not a valid ambit state file`, [
    problem,
    "delete it and run `ambit install` again to rebuild it",
  ]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown, file: string, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    stateError(file, `"${label}" must be an array of strings`);
  }
  return value as readonly string[];
}

function parseArtifact(value: unknown, file: string, index: number): OwnedArtifact {
  const label = `artifacts[${index}]`;
  if (!isRecord(value)) stateError(file, `"${label}" must be an object`);

  const target = value.path;
  if (typeof target !== "string" || target === "") {
    stateError(file, `"${label}.path" must be a non-empty string`);
  }

  const kind = value.kind;
  if (typeof kind !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
    stateError(file, `"${label}.kind" must be one of: ${ARTIFACT_KINDS.join(", ")}`);
  }

  const mode = value.mode;
  if (
    mode !== undefined &&
    (typeof mode !== "string" || !(ARTIFACT_MODES as readonly string[]).includes(mode))
  ) {
    stateError(file, `"${label}.mode" must be one of: ${ARTIFACT_MODES.join(", ")}`);
  }

  const format = value.format;
  if (
    format !== undefined &&
    (typeof format !== "string" || !(DOCUMENT_FORMATS as readonly string[]).includes(format))
  ) {
    stateError(file, `"${label}.format" must be one of: ${DOCUMENT_FORMATS.join(", ")}`);
  }

  const shape = value.shape;
  if (
    shape !== undefined &&
    (typeof shape !== "string" || !(DOCUMENT_SHAPES as readonly string[]).includes(shape))
  ) {
    stateError(file, `"${label}.shape" must be one of: ${DOCUMENT_SHAPES.join(", ")}`);
  }

  const managedKeys = value.managedKeys;
  return {
    path: target,
    kind: kind as ArtifactKind,
    ...(mode !== undefined && { mode: mode as ArtifactMode }),
    ...(format !== undefined && { format: format as DocumentFormat }),
    ...(shape !== undefined && { shape: shape as DocumentShape }),
    ...(managedKeys !== undefined && {
      managedKeys: stringList(managedKeys, file, `${label}.managedKeys`),
    }),
  };
}

/**
 * Parses a state document.
 *
 * @param text the file contents.
 * @param file how it is named in error messages, conventionally project-relative.
 * @throws {AmbitError} exit 2 for malformed JSON, an unsupported version, or a bad artifact
 *   entry — an unreadable ownership record is exactly when ambit must stop rather than guess.
 */
export function parseState(text: string, file: string): State {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    stateError(file, error instanceof Error ? error.message : String(error));
  }

  if (!isRecord(document)) stateError(file, "the document must be a JSON object");

  const version = document.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    stateError(file, '"version" must be an integer');
  }
  if (version !== STATE_VERSION) {
    throw configError(`${file} has unsupported state version ${version}`, [
      `this build of ambit understands version ${STATE_VERSION}`,
      "upgrade ambit, or delete the file and run `ambit install` again",
    ]);
  }

  const artifacts = document.artifacts;
  if (!Array.isArray(artifacts)) stateError(file, '"artifacts" must be an array');

  return {
    version,
    harnesses: stringList(document.harnesses, file, "harnesses"),
    artifacts: artifacts.map((artifact, index) => parseArtifact(artifact, file, index)),
  };
}

/**
 * Reads a project's state, treating an absent file as "ambit owns nothing here".
 *
 * @throws {AmbitError} exit 2 if the file exists but cannot be trusted.
 */
export async function readState(projectDir: string): Promise<State> {
  const file = stateFilePath(projectDir);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return EMPTY_STATE;
    throw configError(`cannot read ${STATE_DIRNAME}/${STATE_FILENAME}`, [
      error instanceof Error ? error.message : String(error),
      `make ${file} readable, or delete it and run \`ambit install\` again`,
    ]);
  }
  return parseState(text, `${STATE_DIRNAME}/${STATE_FILENAME}`);
}

/**
 * Writes a project's state.
 *
 * Called only after the filesystem changes it describes have succeeded, so a crash leaves
 * artifacts owned and recoverable rather than orphaned.
 */
export async function writeState(projectDir: string, state: State): Promise<void> {
  const file = stateFilePath(projectDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, serializeState(state), "utf8");
}
