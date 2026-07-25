/**
 * The MCP entity commands (spec §6, "Catalog authoring"): `ambit catalog mcp new|rm`.
 *
 * An entity is one file whose stem is its name (spec §3.3), so this module is the simplest of the
 * authoring set — and the two things that are not simple both come from that identity:
 *
 * - **`new` writes the whole file through `emitYaml`** (authoring rule 3), because ambit owns every
 *   byte of a document it is creating: sorted keys at every depth, quoting where a value would
 *   otherwise coerce, and a `transport` carrying exactly one kind key. That last one is a *type*
 *   here rather than a check — {@link newMcp} takes an {@link McpTransport}, which cannot name zero
 *   or two kinds — so the discriminator §3.3 insists on can never be ambiguous in what ambit writes.
 *   The kind's own flags are the handler's to read.
 * - **`rm` removes the file the entity is actually written as**, `.yml` or `.yaml`
 *   ({@link mcpDocumentFile}). Nothing carries an entity's filename — `McpEntity` is the same type an
 *   inline `ambit.yml` declaration parses into, and that has no file at all — so the one place that
 *   deletes one looks it up. Removing the `.yml` a name *would* take would otherwise be a silent
 *   no-op against a catalog that spells it `.yaml`.
 *
 * `new` declares no scopes, because the surface spec §6 gives it has no `--scope`: a new server is
 * reachable only through a skill's `requires` until someone gives it a `scopes` entry, and the
 * command says so on the way out. `rm` refuses while any skill requires `mcp.<name>`, naming every
 * requirer — the editor would refuse the write anyway, since a dangling requirement does not
 * validate, but the list of files to fix is the useful answer.
 *
 * Both write through the B02 editor, so they inherit atomic writes, the root check, `--dry-run`, and
 * validation of the whole result.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import type { Catalog, CatalogSkill } from "./catalog.js";
import { MCPS_DIRNAME, MCP_EXTENSIONS, SKILL_FILENAME, parseCatalogDirectory } from "./catalog.js";
import type { EditOptions, EditResult } from "./editor.js";
import { applyCatalogEdit, mcpDocumentPath } from "./editor.js";
import type { AmbitError } from "./errors.js";
import { at, configError, resolutionError } from "./errors.js";
import type { McpEntity, McpTransport } from "./mcp.js";
import { MCP_REQUIREMENT_PREFIX } from "./resolve.js";
import { emitYaml } from "./yaml.js";

/** The keys an entity document holds (spec §3.3). */
const NAME_KEY = "name";
const TRANSPORT_KEY = "transport";
const ENV_KEY = "env";

/** What an edit to an entity amounted to: the editor's own report, unchanged. */
export type McpEdit = EditResult;

/** A server as a report names it: what it is called, and where it is reached. */
export interface McpSummary {
  readonly name: string;
  readonly transport: McpTransport["kind"];
  /** The command it spawns, arguments included, or the url it is reached at. */
  readonly target: string;
}

export interface McpNewResult extends McpEdit {
  readonly created: McpSummary;
}

export interface McpRemoveResult extends McpEdit {
  readonly removed: string;
}

export interface McpNewOptions extends EditOptions {
  /** The one transport the entity declares. Exactly one kind, by construction (spec §3.3). */
  readonly transport: McpTransport;
  /** Env vars the server needs. Absent leaves the key out rather than writing an empty list. */
  readonly env?: readonly string[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A list as ambit writes it into a file it is creating: sorted and deduplicated.
 *
 * `env` only. A stdio command's `args` are deliberately left in the order they were given — they are
 * positional arguments to a program, so argv order there *is* information.
 */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/** How a server reads in a report: the command it spawns, or the url it is reached at. */
export function mcpTarget(transport: McpTransport): string {
  return transport.kind === "stdio"
    ? [transport.command, ...transport.args].join(" ")
    : transport.url;
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * The file an entity is written as, catalog-relative: whichever §3.3 extension it actually carries,
 * falling back to the one ambit writes.
 *
 * Parsing refuses a stem that carries both extensions, so at most one of them is there. Exported
 * because every command that *edits* an existing entity needs it for the same reason `rm` does —
 * `catalog annotate` will.
 */
export async function mcpDocumentFile(root: string, name: string): Promise<string> {
  for (const extension of MCP_EXTENSIONS) {
    const file = `${MCPS_DIRNAME}/${name}${extension}`;
    if (await isFile(path.join(root, file))) return file;
  }
  return mcpDocumentPath(name);
}

/**
 * Rejects a name that cannot be a filename stem under `mcps/`.
 *
 * The name↔filename convention is the whole of an entity's identity (spec §3.3), so a name that does
 * not survive the round trip is refused here rather than written and rejected on the next read. A
 * leading dot is refused with the path separators: parsing would find such a file, but a server
 * nobody can see in a directory listing is not a name anyone meant to give.
 *
 * @throws {AmbitError} exit 2, naming the directory the entity would have gone in.
 */
function assertMcpName(name: string): void {
  const usable =
    name.trim() !== "" && !name.includes("/") && !name.includes("\\") && !name.startsWith(".");
  if (usable) return;

  throw configError(`invalid MCP name "${name}" ${at(MCPS_DIRNAME, undefined)}`, [
    `a server's name is the stem of its file under ${MCPS_DIRNAME}/, so it holds no path separator and does not begin with a dot`,
    "name it like `close`",
  ]);
}

/** The error for a name this catalog already provides a server under (spec §6: a name conflict). */
function alreadyProvided(name: string, file: string): AmbitError {
  return resolutionError(`MCP server "${name}" already exists ${at(file, undefined)}`, [
    "a name means one thing, and this catalog already gave it to a server",
    "pick another name, or edit the entity that is there",
  ]);
}

/**
 * The error for a server this catalog does not provide.
 *
 * No "did you mean": a server name is not chosen from a registry the way a scope is, so a near miss
 * is as likely to be a different server as a typo — the same stance `catalog skill rm` takes. What
 * the reader gets instead is the rule that turns a filename into a name.
 */
function unknownMcp(name: string): AmbitError {
  return resolutionError(
    `unknown MCP server "${name}" ${at(mcpDocumentPath(name), undefined)}`,
    [
      "this catalog provides no server by that name",
      `a server's name is the stem of its file under ${MCPS_DIRNAME}/`,
    ],
  );
}

/** How a requirer reads in a refusal: what it is called, and where the `requires` entry is written. */
function requires(skill: CatalogSkill): string {
  return `skill "${skill.name}" requires it ${at(`${skill.path}/${SKILL_FILENAME}`, undefined)}`;
}

/** The error for removing a server a skill still requires (spec §6). */
function stillRequired(name: string, file: string, requirers: readonly string[]): AmbitError {
  return resolutionError(`MCP server "${name}" is still required ${at(file, undefined)}`, [
    ...requirers,
    `remove the \`${MCP_REQUIREMENT_PREFIX}${name}\` requirement from each of them first`,
  ]);
}

/**
 * Parses the catalog in `root`, which is also the check that it is one.
 *
 * The whole catalog rather than the one entity: `rm` is a question about who requires it, and `new`
 * is a question about what the catalog already provides. The same read `catalog scope` does.
 */
async function readCatalog(root: string): Promise<Catalog> {
  return parseCatalogDirectory(path.basename(root), `path:${root}`, root);
}

/**
 * The entity `name` refers to.
 *
 * @throws {AmbitError} exit 3 when the catalog provides no such server.
 */
function provided(catalog: Catalog, name: string): McpEntity {
  const entity = catalog.mcps.find((candidate) => candidate.name === name);
  if (entity === undefined) throw unknownMcp(name);
  return entity;
}

/**
 * The entity's document as ambit writes one.
 *
 * Every key ambit was given nothing for is left out rather than written empty: absent and empty mean
 * the same thing (spec §3.3), and the shorter file is the one a reader can see the point of. That
 * includes `scopes`, which this command is given no way to set.
 */
function renderMcp(name: string, transport: McpTransport, env: readonly string[]): string {
  return emitYaml({
    ...(env.length > 0 && { [ENV_KEY]: env }),
    [NAME_KEY]: name,
    [TRANSPORT_KEY]: transportValues(transport),
  });
}

/** The transport as §3.3 writes it: one kind key, holding that kind's fields and nothing else. */
function transportValues(transport: McpTransport): Readonly<Record<string, unknown>> {
  if (transport.kind === "stdio") {
    return {
      stdio: {
        command: transport.command,
        ...(transport.args.length > 0 && { args: transport.args }),
      },
    };
  }

  const headers = Object.keys(transport.headers);
  return {
    http: {
      url: transport.url,
      ...(headers.length > 0 && { headers: transport.headers }),
    },
  };
}

/**
 * Creates an MCP entity: one file, named for the server.
 *
 * @param root the catalog root, absolute.
 * @param name the server's name, which decides the filename.
 * @param options the one transport, the env vars, and `--dry-run`.
 * @throws {AmbitError} exit 2 for a name that cannot be a filename stem, a catalog that does not
 *   parse, or a write that fails; exit 3 for a name the catalog already provides or a result that
 *   would not validate — with nothing written.
 */
export async function newMcp(
  root: string,
  name: string,
  options: McpNewOptions,
): Promise<McpNewResult> {
  assertMcpName(name);

  const catalog = await readCatalog(root);
  if (catalog.mcps.some((candidate) => candidate.name === name)) {
    throw alreadyProvided(name, await mcpDocumentFile(root, name));
  }

  const text = renderMcp(name, options.transport, sortedUnique(options.env ?? []));
  const result = await applyCatalogEdit(root, [{ file: mcpDocumentPath(name), text }], options);

  return {
    created: {
      name,
      transport: options.transport.kind,
      target: mcpTarget(options.transport),
    },
    ...result,
  };
}

/**
 * Deletes an MCP entity's document.
 *
 * @param root the catalog root, absolute.
 * @param options `--dry-run`.
 * @throws {AmbitError} exit 2 for a catalog that does not parse or a removal that fails; exit 3 for a
 *   server the catalog does not provide or one a skill still requires — with nothing removed.
 */
export async function removeMcp(
  root: string,
  name: string,
  options: EditOptions = {},
): Promise<McpRemoveResult> {
  const catalog = await readCatalog(root);
  const entity = provided(catalog, name);
  const file = await mcpDocumentFile(root, entity.name);

  const requirement = `${MCP_REQUIREMENT_PREFIX}${entity.name}`;
  const requirers = catalog.skills.filter((skill) => skill.requires.includes(requirement));
  if (requirers.length > 0) throw stillRequired(entity.name, file, requirers.map(requires));

  const result = await applyCatalogEdit(root, [{ file, text: null }], options);
  return { removed: entity.name, ...result };
}
