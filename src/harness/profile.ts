/**
 * A harness, described declaratively — and the one adapter that serves all of them.
 *
 * Installing a bundle works the same way for every agent tool: skills, and the scripts hooks ship,
 * are directories that get copied or symlinked; servers and hooks are entries merged into a config
 * file ambit co-owns; everything is planned before anything is written. What differs per harness is
 * exactly the fields of a profile: whether it needs a link to the skills directory, which files its
 * servers and hooks live in, which section of each, and what one server and one hook look like there.
 *
 * So there is one implementation and five descriptions, not five implementations. A new harness is a
 * profile; adding one should not require editing this file.
 */
import { cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AppliedArtifact,
  HarnessAdapter,
  HookSkipReason,
  PlannedArtifact,
  PlannedCatalogDir,
  PlannedHarnessConfig,
  PlannedHookDir,
  PlannedPluginDir,
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
import { isCatalogDir } from "./adapter.js";
import {
  arrayEntryKey,
  driverFor,
  managedKey,
  readDocumentText,
} from "../model/documents/index.js";
import { configError } from "../errors.js";
import type { MergedHook, MergedMcp, MergedPlugin, MergedSkill } from "../model/catalog.js";
import type { HookEntity, HookEvent } from "../model/hook-entity.js";
import type { Bundle } from "../resolution/resolve.js";
import type { ArtifactMode, State } from "../model/state.js";
import { ownedPaths } from "../model/state.js";

/**
 * The directory the shared skills layout lives under, project-relative.
 *
 * Named separately from {@link SHARED_SKILLS_DIR} because it is also the directory whose own
 * `.gitignore` lists what ambit installed there (see `project/gitignore.ts`).
 */
export const SHARED_AGENTS_DIR = ".agents";

/**
 * Where every harness's skills are materialized, project-relative.
 *
 * One location for all of them: three of the five harnesses read it natively, and the other two are
 * pointed at it with a link. A directory per harness would materialize the same skill several times
 * in one project.
 *
 * Also where a Claude Code plugin lands, per {@link HarnessProfile.pluginsDir} — which is why a
 * skill and a plugin cannot share a name (`assertSkillsAndPluginsApart`, `resolution/resolve.ts`).
 */
export const SHARED_SKILLS_DIR = `${SHARED_AGENTS_DIR}/skills`;

/**
 * Where the script a hook ships is materialized, project-relative.
 *
 * Beside the skills directory for the same reason: one location for however many harnesses read it,
 * under the directory whose `.gitignore` lists what ambit put there.
 */
export const SHARED_HOOKS_DIR = `${SHARED_AGENTS_DIR}/hooks`;

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
 * `shape` picks the driver, since format alone cannot (`.mcp.json` and `.claude/settings.json` are
 * both JSON). `rootDefaults` names the keys a harness expects beside its hooks in a file ambit may
 * create. `events` says how the harness spells each event.
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
   * `arraySectionDriver` seeds them only where the document lacks the key, so ambit adds one when
   * creating the file and never overwrites a value someone else wrote. Only a merge applies them:
   * pruning takes entries out and adds no keys.
   */
  readonly rootDefaults?: JsonObject;
  /**
   * How this harness spells each event, where it differs from ambit's own spelling.
   *
   * Absent means Claude's PascalCase verbatim, which is what Claude, VS Code, and Codex read. Cursor
   * is the one harness needing a map. It lives on the layout, not the renderer, because it names
   * which array an entry joins.
   *
   * Total over {@link HookEvent} where declared, so widening the vocabulary is a type error until
   * every mapping harness has a spelling for the new event.
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
  /**
   * Where this harness reads a Claude Code plugin from, project-relative. Absent means it loads none.
   *
   * The one decision this feature turns on, stated here once. A harness that names a directory reads
   * anything in it holding `.claude-plugin/plugin.json` as a plugin rather than as a skill, so a
   * selected plugin installs by putting the directory there and nothing else: no marketplace to
   * register, and no entry added to a config file the user also writes.
   *
   * Claude Code alone names one today, and it names {@link SHARED_SKILLS_DIR} — its own skills
   * directory, which `skillsLink` already points there. Cursor reads that same link but implements
   * none of the plugin format, and the three harnesses reading the shared directory natively read
   * everything in it as a skill.
   *
   * A path rather than a flag, to match every other field here: where a harness reads a thing is the
   * kind of fact a profile states. Claude moving its lookup, or a second harness reading plugins from
   * somewhere else, is then a data edit in `definitions.ts` rather than a branch in the planner.
   */
  readonly pluginsDir?: string;
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
   * the renderer says what one hook looks like inside it. A profile carries both or neither.
   */
  readonly hooks?: HookLayout;
  /**
   * One hook, in this harness's own shape — the counterpart of {@link HarnessProfile.serverConfig}.
   *
   * Turns a neutral `PreToolUse` into whatever this harness spells it, decides what a `matcher` or
   * `timeout` turns into, and, for a hook that ships a script, decides how the materialized path is
   * spelled: a documented placeholder where the harness has one, project-relative where it does not
   * (`harness/definitions.ts`).
   *
   * Takes the {@link MergedHook} because that is what the planner holds. The rewrite only needs
   * `type` (whether `command` is a path to rewrite or a command line to leave as written) and `name`
   * (the directory the script was materialized under).
   */
  hookConfig?(hook: MergedHook, project: ProjectPaths): unknown;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Which mode one materialized directory is written in.
 *
 * A source pinned to a commit is immutable and gets copied; a source without one is a working
 * directory and gets linked. `commit` is absent exactly for a `path:` source, so no second notion of
 * "is this local" is needed.
 *
 * Takes the one field it reads rather than `MergedSkill`, because a hook that ships a script answers
 * the same question the same way.
 */
function modeOf(item: { readonly commit?: string }, project: ProjectPaths): ArtifactMode {
  if (project.mode !== undefined) return project.mode;
  return item.commit === undefined ? "link" : "copy";
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
 * One plugin's directory, under the directory the harness reads plugins from.
 *
 * Only called for a profile that names one ({@link HarnessProfile.pluginsDir}), so the guard is at the
 * call site rather than here: it is one answer for the whole bundle, not a question per plugin.
 */
function planPlugin(
  pluginsDir: string,
  plugin: MergedPlugin,
  project: ProjectPaths,
): PlannedPluginDir {
  const relative = `${pluginsDir}/${plugin.name}`;
  return {
    kind: "plugin-dir",
    path: relative,
    target: path.join(project.root, relative),
    source: path.join(plugin.catalogRoot, plugin.path),
    mode: modeOf(plugin, project),
    name: plugin.name,
  };
}

/**
 * The link, or nothing.
 *
 * Nothing for a harness that reads the shared directory natively, and nothing when this harness put
 * nothing there: a project that selected no skills and no plugins should not acquire a skills
 * directory or a link to one.
 *
 * `landed` is what the plan already decided rather than a second reading of the bundle, so the link
 * and the directories it points at cannot disagree about whether anything is there.
 */
function planSkillsLink(
  profile: HarnessProfile,
  landed: readonly PlannedCatalogDir[],
  project: ProjectPaths,
): PlannedSkillsLink | undefined {
  if (profile.skillsLink === undefined || landed.length === 0) return undefined;
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
 * A bundle with no MCPs plans no artifact rather than an empty section, so a project that never uses
 * servers does not acquire a config file it did not ask for.
 */
function planMcpConfig(
  profile: HarnessProfile,
  mcps: readonly MergedMcp[],
  project: ProjectPaths,
): PlannedHarnessConfig | undefined {
  if (mcps.length === 0) return undefined;

  // `mcps` arrives sorted by name, so the entries, and the managed keys state records, are too.
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
 * The single predicate behind both halves of the answer: {@link planHookConfig} writes what this
 * names, and {@link skippedHooks} reports what it does not. "Installed" and "skipped" partition the
 * bundle's hooks from the same fields rather than being computed twice.
 *
 * The `events` lookup is widened to a partial map on purpose. {@link HookLayout.events} is total over
 * {@link HookEvent} by type, so a miss is unreachable today but becomes reachable once the vocabulary
 * grows. The type error at the declaration is the first line of defence, not the only one: a hook
 * silently landing in an array named the Claude way would be worse than a skip.
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
 * Pure, and separate from the plan: nothing is written for these, they are only reported, and the run
 * succeeds. A harness that expresses no hooks at all reports every hook in the bundle; one that
 * expresses them reports only the events it has no spelling for.
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
 * The directory one hook's script is materialized from, or nothing.
 *
 * Nothing for two cases: a hook whose `command` is a command line (most of them), and a hook this
 * harness cannot express at all. Both use the same predicate {@link planHookConfig} and
 * {@link skippedHooks} partition the bundle with, so a script is never installed for a harness that
 * skipped the hook. A project on opencode alone acquires no `.agents/hooks` at all.
 *
 * `type` is the whole test: every hook comes out of a catalog directory, so `catalogRoot` and `path`
 * are always there to build the source from. A `command` hook lacks bytes, not a location for them.
 */
function planHookDir(
  profile: HarnessProfile,
  hook: MergedHook,
  project: ProjectPaths,
): PlannedHookDir | undefined {
  if (hook.type !== "script") return undefined;
  if (hookArrayFor(profile, hook) === undefined) return undefined;

  const relative = `${SHARED_HOOKS_DIR}/${hook.name}`;
  return {
    kind: "hook-dir",
    path: relative,
    target: path.join(project.root, relative),
    source: path.join(hook.catalogRoot, hook.path),
    mode: modeOf(hook, project),
    name: hook.name,
  };
}

/**
 * The hooks config artifact, or nothing.
 *
 * Nothing for a harness with no hook mechanism, and nothing for a bundle that selected no hooks, for
 * the same reason as {@link planMcpConfig}: a project that declares no hooks should not acquire a
 * settings file it never asked for. Also nothing when this harness must skip every hook in the
 * bundle, since the file would hold an empty section nobody asked for.
 *
 * The key is the entry's own content digest, since an event's array carries no name to key on. The
 * value is rendered once, and both the key and the entry are read off that one rendering, so the
 * digest always names the bytes actually written.
 *
 * The key also carries the event as this harness spells it: it must name the array the entry actually
 * sits in, or `sectionKeys` reading the file back would not recognize what ambit wrote, and every
 * install would append the hook again.
 */
function planHookConfig(
  profile: HarnessProfile,
  hooks: readonly MergedHook[],
  project: ProjectPaths,
): PlannedHarnessConfig | undefined {
  const layout = profile.hooks;
  const render = profile.hookConfig;
  if (layout === undefined || render === undefined) return undefined;

  // `hooks` arrives sorted by name, so the entries, and the managed keys state records, are too.
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
 * survives the tree being moved, and it keeps a machine-specific absolute path out of the working
 * copy. `readlink` then shows a reader the same thing `ambit status` compares.
 *
 * @throws {AmbitError} exit 2 when the link cannot be created — something already at the target, which
 *   every install path has already refused or removed, or a filesystem that will not make symlinks.
 */
async function link(from: string, at: string, label: string, hint: string): Promise<void> {
  const relative = path.relative(path.dirname(at), from);
  try {
    // `dir` is what Windows needs to make a directory link; POSIX ignores it.
    await symlink(relative, at, "dir");
  } catch (error) {
    throw configError(`cannot symlink ${label}`, [
      error instanceof Error ? error.message : String(error),
      hint,
    ]);
  }
}

/**
 * Writes one directory out of a catalog — a skill's, a hook's shipped script, or a plugin's — in the
 * mode the plan chose.
 *
 * One function over all three, since each is materialized under exactly the same rules: everything
 * below is a statement about a directory ambit owns, not about what it holds.
 *
 * An owned target is removed before being rewritten, so a skill that lost a file upstream does not
 * keep a stale copy of it, and a directory whose mode changed between runs becomes the other thing
 * rather than a copy sitting on top of a link. An unowned target is copied over rather than replaced —
 * a case an install never reaches, since ownership enforcement has already refused it or adopted it.
 * It stays a merge anyway: `apply` called directly, with a state that claims nothing, must not delete
 * a stranger's directory.
 *
 * `cp` preserves each file's mode, so a hook script arrives executable if the catalog ships it that
 * way. A linked directory has no bytes of its own and needs nothing.
 *
 * `dereference` resolves symlinks inside the tree into the bytes they point at. Without it Node
 * copies the link and rewrites its target to an absolute path, which for a catalog fetched into the
 * machine's cache means the project acquires a link into `~/.cache`: machine-specific, and dangling
 * the moment the cache is cleared. Catalogs do compose this way — a plugin's `skills/` is often
 * symlinks into the catalog's own top-level `skills/`, so the same skill has one source — and a copy
 * of such a directory has to be the bytes.
 *
 * @throws {AmbitError} exit 2 when the copy fails. Dereferencing is what makes this reachable: a link
 *   the catalog ships that points at nothing, or at itself, is a file `cp` can no longer just copy,
 *   and the catalog is the only place it can be fixed.
 */
async function applyCatalogDir(
  artifact: PlannedCatalogDir,
  owned: ReadonlySet<string>,
): Promise<AppliedArtifact> {
  if (owned.has(artifact.path)) {
    // `recursive` removes a directory; a symlink is unlinked without following it, so the link's
    // source is never deleted.
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
    try {
      await cp(artifact.source, artifact.target, { recursive: true, dereference: true });
    } catch (error) {
      throw configError(`cannot copy ${artifact.path}`, [
        error instanceof Error ? error.message : String(error),
        `"${artifact.name}" is copied with its symlinks resolved, so one pointing at nothing is a file that cannot be read`,
        "correct the link in the catalog, or remove it",
      ]);
    }
  }

  return { path: artifact.path, kind: artifact.kind, mode: artifact.mode };
}

/**
 * Points a harness's skills directory at the shared one.
 *
 * The shared directory is created first even when the bundle is empty: a link to a directory that
 * does not exist is a dangling link, and a harness reading one reports a broken install rather than
 * an empty one.
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
 * Read-modify-write rather than a plain write, whether or not the file is owned: ambit owns keys
 * here, not the document, so a hand-maintained config is a normal input rather than a conflict.
 *
 * The only site that passes `rootDefaults`, since it is the only one writing a document rather than
 * reading or emptying one. Prune, clean, and status all build their driver from state, which records
 * the shape and no defaults.
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
      const skills = bundle.skills.map((skill) => planSkill(skill, project));
      // `flatMap` because most hooks plan none: a hook with no script is just a command line, which
      // is the config artifact's business.
      const hookDirs = bundle.hooks.flatMap((hook) => {
        const dir = planHookDir(profile, hook, project);
        return dir === undefined ? [] : [dir];
      });
      // Gated once for the whole bundle, since whether this harness loads a plugin at all is one
      // answer, not a question per plugin.
      const pluginsDir = profile.pluginsDir;
      const plugins =
        pluginsDir === undefined
          ? []
          : bundle.plugins.map((plugin) => planPlugin(pluginsDir, plugin, project));

      const skillsLink = planSkillsLink(profile, [...skills, ...plugins], project);
      const mcpConfig = planMcpConfig(profile, bundle.mcps, project);
      const hookConfig = planHookConfig(profile, bundle.hooks, project);
      return [
        // Directories before configs.
        ...skills,
        ...hookDirs,
        ...plugins,
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
        // Both directory kinds are named explicitly rather than left to a trailing `else`: falling
        // through to `applyHarnessConfig` would try to merge a section into a directory.
        if (isCatalogDir(artifact)) applied.push(await applyCatalogDir(artifact, owned));
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
 * Makes replacing an old-layout `.claude/skills` safe: if ambit created everything inside it, turning
 * it into a link to the shared directory loses nothing. A single unowned entry — one hand-written
 * skill — makes the answer no.
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
