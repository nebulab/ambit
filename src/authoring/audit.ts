/**
 * The catalog audit: `ambit catalog audit`.
 *
 * `validate` asks whether a catalog is *correct* — every declared scope registered, every `requires`
 * resolvable, no cycles, no shadowed names — and a catalog can pass all of it while a third of its
 * contents is unreachable. Nothing in a single file shows that: a skill declaring no scope is
 * perfectly legal (`requires` goes the other way round), a registered scope nothing declares
 * is legal too, and the only way to tell either from a deliberate one is to read the whole directory
 * at once. So this command answers the other question — is any of this dead weight? — and the split
 * is deliberate: **a finding here is a smell, never a problem there**. Audit reports nothing about
 * validity and validate reports nothing about reachability, which is also why this command exits 0
 * unless asked to care (`--check`).
 *
 * Three classes, and each one is somebody's actual mistake:
 *
 * - **A registered scope that selects nothing.** It is offered by every picker that renders the
 *   registry (`ambit scopes`) and holding it does nothing at all.
 * - **A skill nothing can reach.** No registered scope of its own, and nothing reachable requires it,
 *   so no profile can select it — instructions somebody still maintains believing they are in use.
 * - **An MCP server nothing can reach**, which is the same finding one namespace over: a server is
 *   reached by a scope of its own or by a skill requiring `mcp: <name>`, and by nothing else.
 * - **A hook nothing can reach**, the same finding again: a scope of its own, or a skill requiring
 *   `hook: <name>`. A hook carries no `requires` of its own, so it is always a leaf of the
 *   closure — which makes it the one namespace where "unreachable" is decided in a single step.
 *
 * Two decisions inside that a later change must not quietly reverse.
 *
 * **Reachability is transitive**, closed over `requires` from the items a scope can select — the same
 * closure `resolveBundle` walks. A one-step rule would call a skill reachable because an unreachable
 * skill requires it, which is precisely the pair nobody can select. **And a scope counts what its
 * subtree selects, not what declares it** (a held scope selects every scope beneath it), so
 * a registered parent nothing declares directly is *not* dead — holding it reaches its children.
 * {@link buildScopeTree} already answers that question, and reusing it is what keeps the two reports
 * from disagreeing about what a scope selects.
 *
 * Like `catalog tree`, this reads and refuses nothing beyond parsing: a dangling `requires` is an edge
 * that reaches nothing here rather than an error, because the catalog someone runs an audit against is
 * often the one they are in the middle of fixing.
 */
import path from "node:path";

import type { Catalog, CatalogHook, CatalogSkill } from "../model/catalog.js";
import {
  HOOK_FILENAME,
  SCOPES_FILENAME,
  SKILL_FILENAME,
  parseCatalogDirectory,
} from "../model/catalog.js";
import { buildScopeTree, flattenScopeTree, selectionSize } from "./tree.js";
import { at } from "../errors.js";
import { formatRequirement } from "../model/requirement.js";

/**
 * What kind of finding a report entry is, so `--json` can be filtered without parsing prose.
 *
 * A declared order rather than an alphabetical one, and it is also the report order: the registry
 * first, then the three namespaces it selects, exactly as `ambit dump-catalog` and `catalog validate`
 * present a
 * catalog. A fixed order is all determinism needs.
 */
export const AUDIT_FINDING_KINDS = [
  "dead-scope",
  "unreachable-skill",
  "unreachable-mcp",
  "unreachable-hook",
] as const;

export type AuditFindingKind = (typeof AUDIT_FINDING_KINDS)[number];

/**
 * One finding, in the shape required of an error — because that is what it would have been
 * had this been a refusal: the offending identifier, the file it is written in, and one concrete next
 * step last.
 */
export interface AuditFinding {
  readonly kind: AuditFindingKind;
  /** The summary: the offending identifier, and the file it is written in. */
  readonly message: string;
  /** The remaining lines, ending in one concrete next step. */
  readonly detail: readonly string[];
}

/** What the audit looked at, so a clean report says so rather than saying nothing. */
export interface AuditCounts {
  readonly hooks: number;
  readonly mcps: number;
  readonly scopes: number;
  readonly skills: number;
}

export interface AuditReport {
  readonly audited: AuditCounts;
  /** Every finding, grouped by kind in {@link AUDIT_FINDING_KINDS} order, each group in name order. */
  readonly findings: readonly AuditFinding[];
}

/**
 * Whether the catalog carries no dead weight: no findings of any kind.
 *
 * Named for the audit's own verdict rather than reusing `status`'s `isClean` or `validate`'s
 * `isValid`: three commands, three questions, and a shared name would invite a caller to ask one of
 * them for the other's answer.
 */
export function isTidy(report: AuditReport): boolean {
  return report.findings.length === 0;
}

function finding(kind: AuditFindingKind, message: string, detail: readonly string[]): AuditFinding {
  return { kind, message, detail };
}

/** Where a skill's annotations are written, from the path the catalog derived its name from. */
function skillDocumentOf(skill: CatalogSkill): string {
  return `${skill.path}/${SKILL_FILENAME}`;
}

/** Where a hook is declared, the same way — a directory holding one document. */
function hookDocumentOf(hook: CatalogHook): string {
  return `${hook.path}/${HOOK_FILENAME}`;
}

/** What a scope declaration can reach: the scopes some `scopes.yml` actually registers. */
function registeredScopes(catalog: Catalog): ReadonlySet<string> {
  return new Set(catalog.scopes.map((definition) => definition.name));
}

/** Whether a scope selection can ever match, which needs one of its scopes to be registered. */
function selectableBy(scopes: readonly string[], registered: ReadonlySet<string>): boolean {
  return scopes.some((scope) => registered.has(scope));
}

/** What some profile could select, closed over `requires` — see the module comment. */
interface Reachable {
  readonly skills: ReadonlySet<string>;
  readonly mcps: ReadonlySet<string>;
  readonly hooks: ReadonlySet<string>;
}

/**
 * Everything a profile could reach: what a registered scope selects, plus everything that selection
 * requires, to fixpoint.
 *
 * A `requires` entry naming something the catalog does not provide reaches nothing and is otherwise
 * ignored — that dangling edge is `validate`'s finding, and reporting it again as an unreachable item
 * would be the duplication this command exists apart from. A cycle terminates on the visited set, so
 * a catalog `validate` would refuse still audits.
 */
function reachableItems(catalog: Catalog): Reachable {
  const registered = registeredScopes(catalog);
  const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
  const skills = new Set<string>();
  const mcps = new Set<string>();
  const hooks = new Set<string>();

  const follow = (skill: CatalogSkill): void => {
    if (skills.has(skill.name)) return;
    skills.add(skill.name);

    // The entry's own `kind`, which is what the closure `resolveBundle` walks reads too — so what a
    // requirement names cannot differ between the two, and a fourth namespace is a type error.
    for (const target of skill.requires) {
      switch (target.kind) {
        case "mcp":
          mcps.add(target.name);
          break;
        case "hook":
          hooks.add(target.name);
          break;
        case "skill": {
          const required = byName.get(target.name);
          if (required !== undefined) follow(required);
          break;
        }
      }
    }
  };

  for (const skill of catalog.skills) {
    if (selectableBy(skill.scopes, registered)) follow(skill);
  }
  for (const mcp of catalog.mcps) {
    if (selectableBy(mcp.scopes, registered)) mcps.add(mcp.name);
  }
  for (const hook of catalog.hooks) {
    if (selectableBy(hook.scopes, registered)) hooks.add(hook.name);
  }

  return { skills, mcps, hooks };
}

/**
 * Registered scopes that select nothing, in registry order.
 *
 * The count comes from {@link buildScopeTree}, so "selects" here means exactly what it means in
 * `catalog tree` and in `expandHeldScopes`: this scope's own declarers plus every registered
 * descendant's, across all three namespaces. A parent nothing declares directly is therefore only
 * reported when its whole subtree is empty too — and a scope only a hook declares is not reported at
 * all, which would otherwise advise someone to unregister the scope their hook is selected by.
 */
function deadScopeFindings(catalog: Catalog): readonly AuditFinding[] {
  const selected = new Map(
    flattenScopeTree(buildScopeTree(catalog)).map(({ node }) => [
      node.name,
      selectionSize(node.direct) + selectionSize(node.inherited),
    ]),
  );

  return catalog.scopes
    .filter((definition) => (selected.get(definition.name) ?? 0) === 0)
    .map((definition) =>
      finding("dead-scope", `unused scope "${definition.name}" ${at(SCOPES_FILENAME, undefined)}`, [
        "no skill, MCP server or hook declares it, and nothing registered beneath it does either",
        "holding it selects nothing, so every picker rendering this registry offers a choice with no effect",
        `declare it with \`ambit catalog annotate <kind>:<name> --add-scope ${definition.name}\`, or unregister it with \`ambit catalog scope rm ${definition.name}\``,
      ]),
    );
}

/** Skills no profile can select, in name order. */
function unreachableSkillFindings(catalog: Catalog, reachable: Reachable): readonly AuditFinding[] {
  return catalog.skills
    .filter((skill) => !reachable.skills.has(skill.name))
    .map((skill) =>
      finding(
        "unreachable-skill",
        `unreachable skill "${skill.name}" ${at(skillDocumentOf(skill), undefined)}`,
        [
          "it declares no registered scope, and nothing reachable requires it",
          "no profile can select it, so nothing it says ever reaches an agent",
          `give it a scope with \`ambit catalog annotate ${formatRequirement({ kind: "skill", name: skill.name })} --add-scope <scope>\`, or remove it with \`ambit catalog skill rm ${skill.name}\``,
        ],
      ),
    );
}

/** MCP servers no profile can select, in name order. */
function unreachableMcpFindings(catalog: Catalog, reachable: Reachable): readonly AuditFinding[] {
  return catalog.mcps
    .filter((mcp) => !reachable.mcps.has(mcp.name))
    .map((mcp) =>
      finding(
        "unreachable-mcp",
        // `mcp.file` rather than `mcps/<name>.yml`: parsing already knows which §3.3 extension the
        // entity actually carries, and a finding has to name a file the reader can open.
        `unreachable MCP server "${mcp.name}" ${at(mcp.file, undefined)}`,
        [
          `no registered scope selects it, and nothing reachable requires \`${formatRequirement({ kind: "mcp", name: mcp.name })}\``,
          "no profile can select it, so nothing ever starts the server",
          `give it a scope with \`ambit catalog annotate ${formatRequirement({ kind: "mcp", name: mcp.name })} --add-scope <scope>\`, or remove it with \`ambit catalog mcp rm ${mcp.name}\``,
        ],
      ),
    );
}

/** Hooks no profile can select, in name order. */
function unreachableHookFindings(catalog: Catalog, reachable: Reachable): readonly AuditFinding[] {
  return catalog.hooks
    .filter((hook) => !reachable.hooks.has(hook.name))
    .map((hook) =>
      finding(
        "unreachable-hook",
        // The directory plus `HOOK.yml`, which is the only spelling a hook document has — the same
        // file `catalog validate` cites, since a finding has to name a file the reader can open.
        `unreachable hook "${hook.name}" ${at(hookDocumentOf(hook), undefined)}`,
        [
          `no registered scope selects it, and nothing reachable requires \`${formatRequirement({ kind: "hook", name: hook.name })}\``,
          "no profile can select it, so no harness is ever configured to run it",
          `give it a scope with \`ambit catalog annotate ${formatRequirement({ kind: "hook", name: hook.name })} --add-scope <scope>\`, or remove it with \`ambit catalog hook rm ${hook.name}\``,
        ],
      ),
    );
}

/**
 * Audits a parsed catalog.
 *
 * Pure, and a function of the catalog's contents alone: `parseCatalogDirectory` hands back scopes,
 * skills, and entities in name order, every finding list is built by walking one of those three, and
 * nothing here reads the filesystem or the clock — so two runs against one catalog produce identical
 * reports whatever order the directory was read in. That includes the file a finding
 * cites, which parsing carries as data (`CatalogMcp.file`) rather than leaving the caller to supply.
 */
export function auditCatalog(catalog: Catalog): AuditReport {
  const reachable = reachableItems(catalog);

  return {
    audited: {
      hooks: catalog.hooks.length,
      mcps: catalog.mcps.length,
      scopes: catalog.scopes.length,
      skills: catalog.skills.length,
    },
    findings: [
      ...deadScopeFindings(catalog),
      ...unreachableSkillFindings(catalog, reachable),
      ...unreachableMcpFindings(catalog, reachable),
      ...unreachableHookFindings(catalog, reachable),
    ],
  };
}

/**
 * Audits one catalog directory on its own terms — the mirror of `ambit catalog validate`.
 *
 * Nothing about a project is read: no `ambit.yml`, no other catalog, no cache. A catalog is not a
 * project, and reachability is a question about one directory anyway — an item a *project*
 * lists explicitly is reachable by nothing this catalog says.
 *
 * @param root the catalog root, absolute. Its basename names the catalog in a parse error; neither it
 *   nor the synthesized `source` reaches the report, which is what keeps the output free of machine
 *   paths.
 * @throws {AmbitError} exit 2 when the directory is not a catalog, or does not parse.
 */
export async function auditCatalogDirectory(root: string): Promise<AuditReport> {
  return auditCatalog(await parseCatalogDirectory(path.basename(root), `path:${root}`, root));
}
