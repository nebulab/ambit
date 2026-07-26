/**
 * A harness, described declaratively — and the one adapter that serves all of them.
 *
 * Everything about installing a bundle is the same for every agent tool: skills are directories that
 * are copied or symlinked, servers and hooks are entries merged into a config file ambit co-owns, and
 * all of them are planned before any is written. Only a handful of things actually differ, and they
 * are exactly the fields of a profile: whether the harness needs a link to the skills directory,
 * which files its servers and its hooks live in, which section of each, and what one server and one
 * hook look like there.
 *
 * So there is one implementation and five descriptions, rather than five implementations. A new
 * harness is a profile; if adding one required editing this file, the seam would be in the wrong place.
 */
import { cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AppliedArtifact,
  HarnessAdapter,
  HookSkipReason,
  PlannedArtifact,
  PlannedHarnessConfig,
  PlannedSkillDir,
  PlannedSkillsLink,
  ProjectPaths,
  SkippedHook,
} from "./adapter.js";
import type {
  ConfigEntry,
  DocumentFormat,
  DocumentShape,
  JsonObject,
} from "../model/documents/index.js";
import {
  arrayEntryKey,
  driverFor,
  managedKey,
  readDocumentText,
} from "../model/documents/index.js";
import { configError } from "../errors.js";
import type { MergedMcp, MergedSkill } from "../model/catalog.js";
import type { HookEntity, HookEvent } from "../model/hook-entity.js";
import type { Bundle } from "../resolution/resolve.js";
import type { ArtifactMode, State } from "../model/state.js";
import { ownedPaths } from "../model/state.js";

/**
 * The directory the shared skills layout lives under, project-relative.
 *
 * Named separately from {@link SHARED_SKILLS_DIR} because it is also the directory whose own
 * `.gitignore` lists what ambit installed there — see `project/gitignore.ts`. One constant, so
 * "which directory is ambit's" has one answer.
 */
export const SHARED_AGENTS_DIR = ".agents";

/**
 * Where every harness's skills are materialized, project-relative.
 *
 * One location for all of them, because three of the five read it natively and the other two are
 * happy to be pointed at it. The alternative — a directory per harness — would materialize the same
 * skill several times in one project and give a reader several copies to wonder about.
 */
export const SHARED_SKILLS_DIR = `${SHARED_AGENTS_DIR}/skills`;

/** Where a harness reads its MCP servers from. */
export interface McpLayout {
  /** Project-relative path to the config file. */
  readonly file: string;
  /** The top-level key holding one entry per server. */
  readonly section: string;
  /** How that file is parsed and written. */
  readonly format: DocumentFormat;
}

/**
 * Where a harness reads its hooks from.
 *
 * Three fields wider than {@link McpLayout}, because a hooks section is not a table keyed by name.
 * `shape` picks the driver, which the format cannot do on its own — `.mcp.json` and
 * `.claude/settings.json` are both JSON — `rootDefaults` names the keys a harness expects beside its
 * hooks in a file ambit may be the one to create, and `events` says how it spells them.
 */
export interface HookLayout {
  /** Project-relative path to the config file. */
  readonly file: string;
  /** The top-level key holding one array per event. */
  readonly section: string;
  /** How that file is parsed and written. */
  readonly format: DocumentFormat;
  /** How that section is laid out: `array` for every harness that expresses hooks at all. */
  readonly shape: DocumentShape;
  /**
   * Root keys the file should carry beside its hooks — Cursor's `version: 1`.
   *
   * `arraySectionDriver` seeds them only where the document lacks the key, so ambit adds one creating
   * the file and never overwrites a value someone else wrote. {@link planHookConfig} carries them onto
   * the artifact, and only a merge applies them: pruning takes entries out and adds no keys.
   */
  readonly rootDefaults?: JsonObject;
  /**
   * How this harness spells each event, where it does not spell it the way ambit does.
   *
   * Absent means Claude's PascalCase verbatim, which is what Claude, VS Code and Codex read. Cursor is
   * the one harness needing a map, and it belongs to the layout rather than to the renderer because it
   * names *which array* an entry joins — the same kind of statement as the file and the section.
   *
   * Total over {@link HookEvent} where it is declared, so widening the vocabulary is a type error
   * until every mapping harness has a spelling for the new event rather than a silently missing array.
   */
  readonly events?: Readonly<Record<HookEvent, string>>;
}

/** One agent tool's layout. */
export interface HarnessProfile {
  /** The name `ambit.yml`'s `harnesses` uses. */
  readonly name: string;
  /**
   * A directory to symlink at {@link SHARED_SKILLS_DIR}, for a harness that does not read it natively.
   *
   * Absent means the harness already looks in the shared location and needs nothing.
   */
  readonly skillsLink?: string;
  readonly mcp: McpLayout;
  /**
   * One server, in this harness's own shape.
   *
   * The only genuinely harness-specific knowledge in the install path: that `http` means
   * `type`/`url`/`headers` here and `type: "remote"` there, and how each spells a reference to an
   * environment variable.
   */
  serverConfig(mcp: MergedMcp): unknown;
  /**
   * Where this harness's hooks live, or absent for one with no declarative hook mechanism.
   *
   * Declared together with {@link HarnessProfile.hookConfig}: the layout says which file and section,
   * the renderer says what one hook looks like inside it, and neither is usable without the other, so
   * a profile carries both or neither.
   */
  readonly hooks?: HookLayout;
  /**
   * One hook, in this harness's own shape — the exact counterpart of
   * {@link HarnessProfile.serverConfig}.
   *
   * The one place a neutral `PreToolUse` becomes whatever this harness spells it, and the one place
   * that decides what a `matcher` or a `timeout` turns into. `project` is what a hook shipping its own
   * script needs to write a path the harness can resolve.
   */
  hookConfig?(hook: HookEntity, project: ProjectPaths): unknown;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which mode one skill is materialized in.
 *
 * A commit is the signal, because it is exactly the question the mode turns on: a source pinned to
 * one is immutable and gets copied, and a source without one is a working directory whose current
 * contents are the answer, so it gets linked. `MergedSkill.commit` is absent precisely for a `path:`
 * source, so this needs no second notion of "is this local".
 */
function modeOf(skill: MergedSkill, project: ProjectPaths): ArtifactMode {
  if (project.mode !== undefined) return project.mode;
  return skill.commit === undefined ? "link" : "copy";
}

function planSkill(skill: MergedSkill, project: ProjectPaths): PlannedSkillDir {
  const relative = `${SHARED_SKILLS_DIR}/${skill.name}`;
  return {
    kind: "skill-dir",
    path: relative,
    target: path.join(project.root, relative),
    source: path.join(skill.catalogRoot, skill.path),
    mode: modeOf(skill, project),
    name: skill.name,
  };
}

/**
 * The link, or nothing.
 *
 * Nothing for a harness that reads the shared directory natively — and nothing for an empty bundle
 * either, because a project that selected no skills should acquire no skills directory and no link
 * pointing at one. An install with nothing to install writes nothing at all.
 */
function planSkillsLink(
  profile: HarnessProfile,
  skills: readonly MergedSkill[],
  project: ProjectPaths,
): PlannedSkillsLink | undefined {
  if (profile.skillsLink === undefined || skills.length === 0) return undefined;
  return {
    kind: "skills-link",
    path: profile.skillsLink,
    target: path.join(project.root, profile.skillsLink),
    source: path.join(project.root, SHARED_SKILLS_DIR),
    mode: "link",
  };
}

/**
 * The MCP config artifact, or nothing when the bundle selected no servers.
 *
 * A bundle with no MCPs plans no artifact at all rather than an empty section, so a project that
 * never uses servers does not acquire a config file it did not ask for.
 */
function planMcpConfig(
  profile: HarnessProfile,
  mcps: readonly MergedMcp[],
  project: ProjectPaths,
): PlannedHarnessConfig | undefined {
  if (mcps.length === 0) return undefined;

  // `mcps` arrives sorted by name, so the entries — and the managed keys state records — are too.
  const entries: readonly ConfigEntry[] = mcps.map((mcp) => ({
    key: mcp.name,
    value: profile.serverConfig(mcp),
  }));

  return {
    kind: "harness-config",
    path: profile.mcp.file,
    target: path.join(project.root, profile.mcp.file),
    section: profile.mcp.section,
    format: profile.mcp.format,
    entries,
    managedKeys: entries.map((entry) => managedKey(profile.mcp.section, entry.key)),
  };
}

/**
 * Which array in this harness's file one hook joins, or `undefined` for a hook it cannot express.
 *
 * The single predicate behind both halves of the answer — {@link planHookConfig} writes what this names
 * and {@link skippedHooks} reports what it does not — so "installed" and "skipped" partition the
 * bundle's hooks rather than being computed twice from the same fields.
 *
 * The `events` lookup is widened to a partial map on purpose. {@link HookLayout.events} is total over
 * {@link HookEvent} by type, so a miss is unreachable today; it becomes reachable the moment the
 * vocabulary grows, and the type error at the declaration is the *first* line of defence rather than the
 * only one. A hook silently landing in an array named the Claude way would be far worse than a skip.
 */
function hookArrayFor(profile: HarnessProfile, hook: HookEntity): string | undefined {
  const layout = profile.hooks;
  if (layout === undefined || profile.hookConfig === undefined) return undefined;

  const events: Readonly<Record<string, string | undefined>> | undefined = layout.events;
  return events === undefined ? hook.event : events[hook.event];
}

/**
 * The hooks one harness was handed and cannot write.
 *
 * Pure, and separate from the plan because nothing is written for these: they are reported, and the run
 * succeeds. A harness that expresses no hooks at all accounts for every hook in the bundle; one that
 * expresses them accounts only for the events it has no spelling for.
 */
export function skippedHooks(
  profile: HarnessProfile,
  hooks: readonly HookEntity[],
): readonly SkippedHook[] {
  const reason: HookSkipReason = profile.hooks === undefined ? "no-mechanism" : "no-event";
  return hooks
    .filter((hook) => hookArrayFor(profile, hook) === undefined)
    .map((hook) => ({ harness: profile.name, hook: hook.name, event: hook.event, reason }));
}

/**
 * The hooks config artifact, or nothing.
 *
 * Nothing for a harness with no hook mechanism, and nothing for a bundle that selected no hooks — the
 * argument {@link planMcpConfig} makes: a project that declares no hooks should not acquire a settings
 * file it never asked for. Nothing, too, for a bundle whose every hook this harness must skip: the file
 * would hold an empty section nobody asked for.
 *
 * The key is the entry's own content digest, because an event's array carries no name to key on. So
 * the value is rendered once and both the key and the entry are read off that one rendering: a digest
 * of anything other than the bytes being written would name an entry nothing can find again.
 *
 * Its other half is the event *as this harness spells it*, and for the same reason: the key has to name
 * the array the entry actually sits in, or `sectionKeys` reading the file back would not recognize what
 * ambit just wrote and every install would append the hook again.
 */
function planHookConfig(
  profile: HarnessProfile,
  hooks: readonly HookEntity[],
  project: ProjectPaths,
): PlannedHarnessConfig | undefined {
  const layout = profile.hooks;
  const render = profile.hookConfig;
  if (layout === undefined || render === undefined) return undefined;

  // `hooks` arrives sorted by name, so the entries — and the managed keys state records — are too.
  const entries: readonly ConfigEntry[] = hooks.flatMap((hook) => {
    const event = hookArrayFor(profile, hook);
    if (event === undefined) return [];
    const value = render(hook, project);
    return [{ key: arrayEntryKey(event, value), value }];
  });
  if (entries.length === 0) return undefined;

  return {
    kind: "harness-config",
    path: layout.file,
    target: path.join(project.root, layout.file),
    section: layout.section,
    format: layout.format,
    shape: layout.shape,
    ...(layout.rootDefaults !== undefined && { rootDefaults: layout.rootDefaults }),
    entries,
    managedKeys: entries.map((entry) => managedKey(layout.section, entry.key)),
  };
}

/**
 * Writes a relative symlink.
 *
 * Relative, because a project and the catalog it points at are often one checkout: a relative link
 * survives that tree being moved, and it keeps a machine-specific absolute path out of the working
 * copy. `readlink` then shows a reader the same thing `ambit status` compares.
 *
 * @throws {AmbitError} exit 2 when the link cannot be created — something already at the target, which
 *   every install path has already refused or removed, or a filesystem that will not make symlinks.
 */
async function link(from: string, at: string, label: string, hint: string): Promise<void> {
  const relative = path.relative(path.dirname(at), from);
  try {
    // The `dir` type is what Windows needs to make a directory link; POSIX ignores it.
    await symlink(relative, at, "dir");
  } catch (error) {
    throw configError(`cannot symlink ${label}`, [
      error instanceof Error ? error.message : String(error),
      hint,
    ]);
  }
}

/**
 * Writes one skill directory, in the mode the plan chose.
 *
 * An owned target is removed before being rewritten, so a skill that lost a file upstream does not
 * keep a stale copy of it — and so a skill whose mode changed between runs becomes the other thing
 * rather than a copy sitting on top of a link. An unowned one is copied *over* rather than replaced —
 * a case an install never reaches, since ownership enforcement has already refused it or adopted it.
 * Keeping it a merge is deliberate anyway: `apply` called directly, with a state that claims nothing,
 * must not be able to delete a stranger's directory.
 */
async function applySkillDir(
  artifact: PlannedSkillDir,
  owned: ReadonlySet<string>,
): Promise<AppliedArtifact> {
  if (owned.has(artifact.path)) {
    // `recursive` removes a directory; a symlink is unlinked without following it, so the source a
    // previous link pointed at is never what gets deleted.
    await rm(artifact.target, { recursive: true, force: true });
  }
  await mkdir(path.dirname(artifact.target), { recursive: true });

  if (artifact.mode === "link") {
    await link(
      artifact.source,
      artifact.target,
      artifact.path,
      `move ${artifact.path} aside, or run \`ambit install --copy\` to copy "${artifact.name}" instead`,
    );
  } else {
    await cp(artifact.source, artifact.target, { recursive: true });
  }

  return { path: artifact.path, kind: artifact.kind, mode: artifact.mode };
}

/**
 * Points a harness's skills directory at the shared one.
 *
 * The shared directory is created first even when the bundle is empty: a link to a directory that does
 * not exist is a dangling link, and a harness reading one reports a broken install rather than an
 * empty one.
 */
async function applySkillsLink(
  artifact: PlannedSkillsLink,
  owned: ReadonlySet<string>,
): Promise<AppliedArtifact> {
  await mkdir(artifact.source, { recursive: true });
  if (owned.has(artifact.path)) await rm(artifact.target, { recursive: true, force: true });
  await mkdir(path.dirname(artifact.target), { recursive: true });

  await link(
    artifact.source,
    artifact.target,
    artifact.path,
    `move ${artifact.path} aside, so ambit can point it at ${SHARED_SKILLS_DIR}`,
  );

  return { path: artifact.path, kind: artifact.kind, mode: artifact.mode };
}

/**
 * Merges the planned entries into the harness's config file.
 *
 * Read-modify-write rather than a plain write, and it happens whether or not the file is owned: ambit
 * owns keys here, not the document, so a hand-maintained config is a normal input rather than a
 * conflict.
 *
 * The only site that passes `rootDefaults`, because it is the only one that *writes* a document rather
 * than reading or emptying one: prune, clean and status all build their driver from state, which
 * records the shape and no defaults.
 */
async function applyHarnessConfig(artifact: PlannedHarnessConfig): Promise<AppliedArtifact> {
  const driver = driverFor(artifact.format, artifact.shape, artifact.rootDefaults);
  const text = await readDocumentText(artifact.target, artifact.path);
  const merged = driver.mergeSection(text, artifact.section, artifact.entries, artifact.path);

  await mkdir(path.dirname(artifact.target), { recursive: true });
  await writeFile(artifact.target, merged, "utf8");

  return {
    path: artifact.path,
    kind: artifact.kind,
    format: artifact.format,
    ...(artifact.shape !== undefined && { shape: artifact.shape }),
    managedKeys: artifact.managedKeys,
  };
}

/** Builds the adapter for one profile. */
export function adapterFor(profile: HarnessProfile): HarnessAdapter {
  return {
    name: profile.name,

    /** Every list on the bundle is already sorted by name, so the plan is too. */
    plan: (bundle: Bundle, project: ProjectPaths): readonly PlannedArtifact[] => {
      const skillsLink = planSkillsLink(profile, bundle.skills, project);
      const mcpConfig = planMcpConfig(profile, bundle.mcps, project);
      const hookConfig = planHookConfig(profile, bundle.hooks, project);
      return [
        ...bundle.skills.map((skill) => planSkill(skill, project)),
        ...(skillsLink === undefined ? [] : [skillsLink]),
        ...(mcpConfig === undefined ? [] : [mcpConfig]),
        ...(hookConfig === undefined ? [] : [hookConfig]),
      ];
    },

    skips: (bundle: Bundle): readonly SkippedHook[] => skippedHooks(profile, bundle.hooks),

    apply: async (
      plan: readonly PlannedArtifact[],
      prior: State,
    ): Promise<readonly AppliedArtifact[]> => {
      const owned = ownedPaths(prior);
      const applied: AppliedArtifact[] = [];

      for (const artifact of plan) {
        if (artifact.kind === "skill-dir") applied.push(await applySkillDir(artifact, owned));
        else if (artifact.kind === "skills-link")
          applied.push(await applySkillsLink(artifact, owned));
        else applied.push(await applyHarnessConfig(artifact));
      }

      return applied;
    },
  };
}

/**
 * Whether every entry in a directory is a path ambit already owns.
 *
 * What makes replacing an old-layout `.claude/skills` safe: ambit created everything inside it, so the
 * container holds nothing of anyone else's, and turning it into a link to the shared directory loses
 * nothing. A single unowned entry — one hand-written skill — makes the answer no.
 */
export async function holdsOnlyOwned(
  target: string,
  relative: string,
  owned: ReadonlySet<string>,
): Promise<boolean> {
  let entries: readonly string[];
  try {
    entries = await readdir(target);
  } catch {
    return false;
  }
  return entries.every((entry) => owned.has(`${relative}/${entry}`));
}

export { compare };
