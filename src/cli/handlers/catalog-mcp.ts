/**
 * `ambit catalog mcp new|rm` — the two MCP entity commands.
 *
 * One module, printing the two sections every authoring command prints: what the catalog now provides,
 * then which files that took — or, under `--dry-run`, the diff it withheld. The heading follows
 * `--dry-run` rather than `written`, as it does for the scope and skill commands.
 *
 * What is particular to this handler is the transport, and all of it lives here. `--stdio`/`--http` are
 * argv syntax, so turning them into the one {@link McpTransport} §3.3 allows is the boundary's job. Every
 * way that can fail is refused by {@link catalogMcpNewRule}, declared with the command and run by
 * Commander before dispatch — but by a rule rather than by `.conflicts()`, for the message: an error has
 * to name the offending file and the supported kinds, which
 * `error: option '--http <url>' cannot be used with option '--stdio <command>'` does not, and Commander
 * can say nothing at all about *neither* flag. Below this line the transport is a type that cannot name
 * zero or two kinds.
 *
 * Every flag that belongs to the other kind is refused rather than ignored: `--header` with `--stdio`
 * would otherwise be typed, accepted, and silently dropped, which is the one outcome worse than an
 * error. `rm` closes with nothing, deliberately: no project's `ambit.yml` can name a catalog's server —
 * §3.1's `mcps` declares one rather than selecting one — so there is nothing for its author to update.
 */
import type { McpEdit, McpSummary } from "../../authoring/mcp.js";
import { newMcp, removeMcp } from "../../authoring/mcp.js";
import { MCPS_DIRNAME } from "../../model/catalog.js";
import type { CommandContext, CommandHandler, CommandRule } from "../commands.js";
import {
  catalogDirOf,
  dryRunRequested,
  jsonRequested,
  optionList,
  positional,
} from "../commands.js";
import { changeKindOf, diffSection } from "../diff.js";
import { mcpDocumentPath } from "../../authoring/editor.js";
import type { AmbitError } from "../../errors.js";
import { ExitCode, at, configError } from "../../errors.js";
import type { McpTransport } from "../../model/mcp-entity.js";
import { MCP_TRANSPORT_KINDS } from "../../model/mcp-entity.js";
import { printSections, section } from "../output.js";
import { MCP_REQUIREMENT_PREFIX } from "../../resolution/resolve.js";

/** The first section's title: past tense for a run that happened, conditional for a preview. */
interface Heading {
  readonly done: string;
  readonly would: string;
}

const CREATED: Heading = { done: "created", would: "would create" };
const REMOVED: Heading = { done: "removed", would: "would remove" };

/** What separates a header's key from its value, as argv gives it. */
const HEADER_SEPARATOR = "=";

/** The two flags that name a transport, and the kind each of them means. */
const STDIO_FLAG = "stdio";
const HTTP_FLAG = "http";

/** How every transport refusal names what ambit understands. */
const SUPPORTED = `supported kinds: ${MCP_TRANSPORT_KINDS.join(", ")}`;

/** The one line every transport refusal ends on: the concrete next step every error requires. */
const GIVE_ONE = `give exactly one of \`--${STDIO_FLAG} <command>\` or \`--${HTTP_FLAG} <url>\``;

/** How `new` is invoked, for the messages that have to say so. */
const NEW_USAGE = `ambit catalog mcp new <name> --${STDIO_FLAG} <command>`;

/** What a command tells the reader, on top of the files it touched. */
interface Subject {
  readonly heading: Heading;
  /** The rows of the first section: the server this command was about. */
  readonly rows: readonly (readonly string[])[];
  /** The `--json` keys for the same thing, which are the command's own. */
  readonly json: Readonly<Record<string, unknown>>;
  /** A closing line, printed only for a run that wrote something. */
  readonly next?: string;
}

/**
 * The error for an invocation that names no transport, or two.
 *
 * Exit 2 — a malformed invocation, not a resolution problem — and it names the supported kinds for the
 * same reason parsing does: `transport` is the discriminator, so it must never be ambiguous.
 */
function transportRefusal(name: string, summary: string): AmbitError {
  return configError(`MCP server "${name}" ${summary} ${at(mcpDocumentPath(name), undefined)}`, [
    SUPPORTED,
    GIVE_ONE,
  ]);
}

/** The error for a flag belonging to the transport kind this invocation did not ask for. */
function flagBelongsElsewhere(flag: string, kind: string): AmbitError {
  return configError(`\`--${flag}\` belongs to the ${kind} transport ${at(MCPS_DIRNAME, undefined)}`, [
    `this invocation names a different kind, so \`--${flag}\` would be written nowhere`,
    `drop \`--${flag}\`, or name the ${kind} transport instead`,
  ]);
}

/** The error for a `--header` argv entry that is not a `key=value` pair. */
function badHeader(entry: string, reason: string): AmbitError {
  return configError(`cannot read \`--header ${entry}\` ${at(MCPS_DIRNAME, undefined)}`, [
    reason,
    `write it as \`--header <key>${HEADER_SEPARATOR}<value>\`, once per header`,
  ]);
}

/**
 * A flag's value, refusing a blank one.
 *
 * A transport whose command or url is empty parses and installs, and then names nothing — so it is
 * refused here rather than written.
 *
 * @throws {AmbitError} exit 2 when the flag was given an empty value.
 */
function flag(ctx: CommandContext, name: string, subject: string): string | undefined {
  const given = ctx.options[name];
  if (typeof given !== "string") return undefined;
  if (given.trim() !== "") return given;

  throw configError(`\`--${name}\` names no ${subject} ${at(MCPS_DIRNAME, undefined)}`, [
    "a transport has to say where the server is, or nothing can reach it",
    `give \`--${name} <${subject}>\` a value`,
  ]);
}

/**
 * `--header k=v` entries as the document's `headers` mapping.
 *
 * Split at the *first* separator, so a value may hold one — `Authorization=Bearer a=b` is one header.
 * A repeated key is refused rather than overwritten: one of the two was typed and would vanish.
 *
 * @throws {AmbitError} exit 2 for an entry with no separator, an empty key, or a repeated key.
 */
function headersOf(entries: readonly string[]): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};

  for (const entry of entries) {
    const separator = entry.indexOf(HEADER_SEPARATOR);
    if (separator === -1) throw badHeader(entry, `it holds no \`${HEADER_SEPARATOR}\``);

    const key = entry.slice(0, separator);
    if (key.trim() === "") throw badHeader(entry, "it names no header");
    if (key in headers) throw badHeader(entry, `\`${key}\` was already given a value`);

    headers[key] = entry.slice(separator + HEADER_SEPARATOR.length);
  }

  return headers;
}

/**
 * The one transport this invocation declares.
 *
 * @throws {AmbitError} exit 2 when neither or both kinds are named, when a flag belonging to the other
 *   kind is given, or when a `--header` entry cannot be read.
 */
function transportOf(ctx: CommandContext, name: string): McpTransport {
  const command = flag(ctx, STDIO_FLAG, "command");
  const url = flag(ctx, HTTP_FLAG, "url");
  const args = optionList(ctx, "arg");
  const headers = optionList(ctx, "header");

  if (command !== undefined && url !== undefined) {
    throw transportRefusal(name, "names two transports");
  }

  if (command !== undefined) {
    if (headers !== undefined) throw flagBelongsElsewhere("header", HTTP_FLAG);
    // Not sorted: these are a program's positional arguments, so the order given is the order meant.
    return { kind: "stdio", command, args: args ?? [] };
  }

  if (url !== undefined) {
    if (args !== undefined) throw flagBelongsElsewhere("arg", STDIO_FLAG);
    return { kind: "http", url, headers: headersOf(headers ?? []) };
  }

  throw transportRefusal(name, "names no transport");
}

/**
 * `new`'s flag rule: exactly one transport, and no flag belonging to the kind it did not name (spec
 * §3.3).
 *
 * The same pure read of argv the handler makes, run once more and for its refusals alone. Reading it
 * twice is what keeps the rule declarable with the command *and* the transport built where it is used —
 * cheaper, and far plainer, than carrying a hook's result into an action.
 *
 * @throws {AmbitError} exit 2 when neither or both kinds are named, when a flag belonging to the other
 *   kind is given, or when a `--header` entry cannot be read.
 */
export const catalogMcpNewRule: CommandRule = (ctx) => {
  transportOf(ctx, positional(ctx, 0, NEW_USAGE));
};

/** Keys in one order, so the emitted JSON is byte-stable (`keyed` in `src/cli/output.ts`). */
function toJson(subject: Subject, result: McpEdit): Readonly<Record<string, unknown>> {
  return {
    ...subject.json,
    files: result.changes.map((change) => ({ file: change.file, text: change.text })),
    written: result.written,
  };
}

/** Every file the edit touched, with what happened to it. An entity is a file; no tree moves. */
function fileRows(result: McpEdit): readonly (readonly string[])[] {
  return result.changes.map((change) => [change.file, changeKindOf(change)]);
}

function toText(subject: Subject, result: McpEdit, dryRun: boolean): readonly string[] {
  return [
    ...section(dryRun ? subject.heading.would : subject.heading.done, subject.rows),
    ...(dryRun ? diffSection("diff", result.changes) : section("files", fileRows(result))),
    ...(subject.next !== undefined && result.written ? [subject.next, ""] : []),
  ];
}

/** The one output path both commands take. */
function report(ctx: CommandContext, subject: Subject, result: McpEdit): ExitCode {
  if (jsonRequested(ctx)) ctx.stdout(JSON.stringify(toJson(subject, result), null, 2));
  else printSections(toText(subject, result, dryRunRequested(ctx)), ctx.stdout);

  return ExitCode.Success;
}

/**
 * What a new server leaves for its author to do.
 *
 * `mcp new` is given no way to declare a scope, so what it writes is selected by nothing yet — and a
 * server nothing reaches is a server that is never installed.
 *
 * Both halves name `catalog annotate`, which postdates this line: it is what gives an entity a scope and
 * what gives a skill the requirement, so neither half sends the reader to a file to hand-edit.
 */
function newNextStep(created: McpSummary): string {
  const target = `${MCP_REQUIREMENT_PREFIX}${created.name}`;
  return `next: nothing selects it yet — run \`ambit catalog annotate ${target} --add-scope <scope>\`, or \`ambit catalog annotate <skill> --add-requires ${target}\``;
}

export const catalogMcpNewHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, NEW_USAGE);
  const transport = transportOf(ctx, name);
  const env = optionList(ctx, "env");

  const result = await newMcp(catalogDirOf(ctx), name, {
    transport,
    dryRun: dryRunRequested(ctx),
    ...(env !== undefined && { env }),
  });

  return report(
    ctx,
    {
      heading: CREATED,
      rows: [[result.created.name, result.created.transport, result.created.target]],
      json: {
        created: {
          name: result.created.name,
          target: result.created.target,
          transport: result.created.transport,
        },
      },
      next: newNextStep(result.created),
    },
    result,
  );
};

export const catalogMcpRemoveHandler: CommandHandler = async (ctx) => {
  const name = positional(ctx, 0, "ambit catalog mcp rm <name>");

  const result = await removeMcp(catalogDirOf(ctx), name, { dryRun: dryRunRequested(ctx) });

  return report(
    ctx,
    { heading: REMOVED, rows: [[result.removed]], json: { removed: result.removed } },
    result,
  );
};
