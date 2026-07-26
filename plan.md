# Add hooks support to ambit

## Context

[nebulab/ambit#14](https://github.com/nebulab/ambit/issues/14): _"Adding support for hooks would achieve
near-feature parity with dotagents. In addition, we want to make sure that hooks managed outside ambit
survive installs, unlike what happens with dotagents which clears everything."_

ambit already resolves **skills** and **MCP servers** from a scoped catalog into each harness's native
layout. Hooks are the third capability every harness loads, and `README.md:3` has promised them since
the first commit while nothing in `src/` implements them. This change makes hooks a first-class third
namespace.

The second sentence of the issue is the harder half, and it names a real defect in the tool ambit
replaces. dotagents keeps **no ownership record for hooks**. One `[[hooks]]` entry in `agents.toml` and
`reconcileHookConfigs` replaces the _entire_ `hooks` root of `.claude/settings.json` wholesale — a
hand-written `SessionStart` hook is destroyed, and there is a test asserting that clobber is
intentional. Zero entries and it touches nothing. There is no middle ground, and deleting a declaration
orphans the generated hook forever; dotagents' own `HookReconcileResult.removed[]` is dead code, because
without markers it cannot know what to remove. Its MCP writer _does_ merge safely per server name —
hooks cannot, because every harness's hook root is `event → array` and arrays have no identity key.

**That array-identity problem is the actual work in this change**, not the schema. ambit's
`DocumentDriver` (`src/model/documents/format.ts:72`) owns `section.key` over a name-keyed map; hooks
need `section.event → [entries]`.

## Decisions

| Question            | Decision                                                                                                                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity fidelity     | Neutral vocabulary, wider than dotagents' four events. Claude's PascalCase names as the lingua franca — Codex and VS Code use them verbatim, only Cursor needs a map. Admit only events with a real mapping in 2+ harnesses.                                                                                                     |
| Catalog layout      | Always a directory: `hooks/<name>/HOOK.yml`, name derived from the path under `hooks/` with `/` → `.`, exactly like `skills/<name>/SKILL.md`. An inline-command hook is a directory holding only its `HOOK.yml`.                                                                                                                 |
| Script distribution | Both. A bare `command` string, **or** a script shipped in the hook's own directory, materialized to `.agents/hooks/<name>/` the way a skill is materialized to `.agents/skills/<name>/`. This is what makes a hook a distributable dependency rather than a string each consumer commits — something dotagents cannot do at all. |
| Coexistence         | Content digest recorded in `.ambit/state.json`. Install removes exactly the entries whose digest state claims, then appends the current rendering. Every other entry in the array is left byte-identical, and the written file stays 100% harness-native.                                                                        |
| Harness coverage    | `claude` + `codex` + `cursor`, and `vscode` onto `.claude/settings.json` (which VS Code reads natively). `opencode` skipped — it has no declarative hook mechanism, only TypeScript plugins.                                                                                                                                     |
| Surface             | Full mirror of the MCP-entity surface: `hooks:` in `ambit.yml`, `hook.<name>` in `requires`, a `hooks:` lock section, rows in every report, and `ambit catalog hook new                                                                                                                                                          | rm`+`catalog annotate hook.<name>`. |

### Harness hook layouts, as of July 2026

Verified against each vendor's current docs. dotagents' own table is out of date here: it predates Codex
hooks, which shipped in v0.114 (March 2026).

| harness    | file                    | section | format | shape                                                                                  |
| ---------- | ----------------------- | ------- | ------ | -------------------------------------------------------------------------------------- |
| `claude`   | `.claude/settings.json` | `hooks` | json   | `hooks.<Event>[]` of `{matcher?, hooks: [{type, command, timeout?}]}`                  |
| `vscode`   | `.claude/settings.json` | `hooks` | json   | reads Claude's file natively; ignores `matcher`. Written once, shared with `claude`.   |
| `cursor`   | `.cursor/hooks.json`    | `hooks` | json   | `{version: 1, hooks: {<camelEvent>: [{command, type?, timeout?}]}}`; `matcher` dropped |
| `codex`    | `.codex/hooks.json`     | `hooks` | json   | Claude-shaped. Experimental, gated behind `[features] codex_hooks = true`.             |
| `opencode` | —                       | —       | —      | no declarative hooks                                                                   |

**Codex uses `.codex/hooks.json`, not `[hooks]` in `.codex/config.toml`.** Codex reads both, but a TOML
`[hooks]` table is an array-of-tables (`[[hooks.PreToolUse]]`), and the TOML driver
(`src/model/documents/toml.ts`) splices _named-table_ spans and explicitly refuses array-of-tables
shapes. Using the JSON file keeps every hooks target on one driver — **all three files are JSON, so
exactly one new driver is needed.**

Every harness pairing already has a precedent in the tree: `claude` and `vscode` sharing
`.claude/settings.json` is the same relationship as `claude` and `cursor` sharing
`CLAUDE_SKILLS_LINK` (`src/harness/definitions.ts:25`).

## Design

### 1. The hook entity — `src/model/hook-entity.ts` (new)

Mirrors `src/model/mcp-entity.ts`, and is shared by both surfaces that can declare a hook
(`hooks/<name>/HOOK.yml` in a catalog, and inline `hooks:` entries in `ambit.yml`) the way
`parseMcpEntity` is.

```yaml
# hooks/block-rm/HOOK.yml
name: block-rm
description: Refuses a destructive rm before it runs
scopes: [function.engineering]
event: PreToolUse
matcher: Bash
command: hook.sh # relative to the hook's own directory → materialized
timeout: 30
env: [SOME_TOKEN]
```

| Key           | Type     | Required | Notes                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string   | yes      | Must equal the name derived from the path under `hooks/`, same rule and same error as a skill (`parseSkill`, `src/model/catalog.ts:464`).                                                                                                                                                                                                                                                                |
| `description` | string   | no       | Carried into reports, like `CatalogSkill.description`.                                                                                                                                                                                                                                                                                                                                                   |
| `scopes`      | string[] | no       | Same semantics as skills and MCP entities. Empty means reachable only via `requires` or an explicit listing.                                                                                                                                                                                                                                                                                             |
| `event`       | string   | yes      | One of `HOOK_EVENTS`. An unknown value is exit 2, listing the supported set — the stance `parseTransport` takes on an unknown transport kind.                                                                                                                                                                                                                                                            |
| `matcher`     | string   | no       | Tool-name filter. Only meaningful for `PreToolUse`/`PostToolUse`; declaring it on another event is exit 2, since a value that is silently dropped is worse than a refusal.                                                                                                                                                                                                                               |
| `command`     | string   | yes      | Either a bare command line (`npx prettier --write`), or a path to a file inside the hook's own directory.                                                                                                                                                                                                                                                                                                |
| `timeout`     | int      | no       | Seconds. Rendered where the harness has a field for it.                                                                                                                                                                                                                                                                                                                                                  |
| `env`         | string[] | no       | Vars the hook needs, for `doctor` to check. **No `${VAR}` translation is done on `command`** — unlike MCP transports, where ambit rewrites references into each harness's own syntax. A hook command is executed by a shell the harness spawns, so `${VAR}` already means the right thing in the one place it can appear, and a translation would be ambit rewriting a shell fragment it does not parse. |

```ts
/** The events with a real mapping in two or more harnesses, in the order reports list them. */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionEnd",
] as const;

/** The events a `matcher` means anything for. */
export const MATCHABLE_EVENTS = ["PreToolUse", "PostToolUse"] as const;
```

Claude's PascalCase spellings are ambit's neutral vocabulary rather than a Claude detail: Codex and VS
Code use them verbatim, so only Cursor needs a map, and inventing a fourth spelling would leave every
harness needing one.

**Whether the hook ships a script is derived, not declared.** `command` names a file inside the hook's
directory → it ships a script; it does not → it is inline. The check is against what the catalog
actually holds, so a typo in a script name is exit 2 naming the directory's contents rather than a
command silently written through as inline.

### 2. Catalog parsing — `src/model/catalog.ts`

```ts
export const HOOKS_DIRNAME = "hooks";
export const HOOK_FILENAME = "HOOK.yml";
```

- `findHookDirectories(files)` alongside `findSkillDirectories` (`catalog.ts:413`) — the same recursive
  walk, keyed on `HOOK_FILENAME` instead of `SKILL_FILENAME`. Reuse `skillNameFromPath`
  (`catalog.ts:408`), renamed to `nameFromPath` or left as-is and called from both.
- `CatalogHook extends HookEntity` carrying `path` (the directory, catalog-relative) and
  `shipsScript: boolean`; `MergedHook` adds `catalog`, `commit?`, `catalogRoot` — the union of what
  `MergedSkill` needs (it materializes a directory) and what `MergedMcp` needs (it renders into a
  config).
- `Catalog.hooks`, `MergedCatalog.hooks`, `Shadowings.hooks`, and a third loop in `mergeCatalogs`
  (`catalog.ts:861`) and `mergeConfigEntities` (`catalog.ts:757`).
- `parseCatalogDirectory` (`catalog.ts:571`) gains a hooks pass beside the skills and MCP passes.

`hooks/` is additive and ignored by every other tool, so the dotagents compatibility promise
(`test/dotagents.test.ts`) is unaffected — but the test asserts the installed skill set equals
`parseCatalogDirectory`'s, so the fixture's new hooks must not leak into `catalog.skills`.

### 3. Config and resolution

- `CONFIG_KEYS` (`src/model/config.ts:31`) gains `hooks`; `parseHooks` mirrors `parseMcps`
  (`config.ts:185`) including the `nameTracker` duplicate check; `ProjectConfig.hooks` and
  `ConfigOrigin.hookLines`.
- `HOOK_REQUIREMENT_PREFIX = "hook."` in `src/resolution/resolve.ts`, beside
  `MCP_REQUIREMENT_PREFIX` (`resolve.ts:43`). Hooks are **leaves**: they carry no `requires` of their
  own, exactly like MCP entities, so `closeOverRequires` (`resolve.ts:329`) gains a third
  prefix branch and no new graph.
- `ItemKind` (`resolve.ts:52`) becomes `"skill" | "mcp" | "hook"`; `Bundle.hooks`,
  `SelectionReasons.hooks`, a third `selectionReasons` call in `resolveBundle` (`resolve.ts:627`), and
  `bundle.env` unions hook `env` too.
- `ambit why` resolves a bare name to a skill first, then falls back — `hook.<name>` insists on a hook,
  matching the documented `mcp.<name>` behaviour.

### 4. The array-section driver — the load-bearing piece

**The existing `DocumentDriver` interface does not change.** It already fits, because the digest can be
made the key:

> **Managed key grammar: `hooks.<Event>@<digest>`** — e.g. `hooks.PostToolUse@a1b2c3d4e5f6`, where
> `<digest>` is the first 12 hex characters of the SHA-256 of the canonical JSON of the entry ambit
> writes.

Why this works with no interface change:

- `managedKey("hooks", "PostToolUse@a1b2c3d4e5f6")` (`documents/format.ts:145`) →
  `hooks.PostToolUse@a1b2c3d4e5f6`.
- `splitManagedKey` (`src/project/prune.ts:102`) splits at the **first** dot → `["hooks",
"PostToolUse@a1b2c3d4e5f6"]`. Already correct, and already documented as splitting there because a key
  can contain dots.
- `sectionKeys(text, "hooks", file)` is **fully derivable from the file alone**: walk each event array,
  digest each entry, return `<Event>@<digest>` for each. Nothing needs a name the file does not carry.
- `entryMatches` — is an entry with this event and digest present?
- `mergeSection` — append each entry to its event array **only if its digest is not already there**,
  leaving every other entry byte-identical.
- `removeKeys` — drop the entries whose event and digest match, and return `undefined` when none
  matched, which is what keeps a no-op prune from rewriting the file.

So the new code is one driver, not a second interface. `src/model/documents/json-array.ts`, sharing
`parse`/`serialize` with `json.ts`.

**Selecting it.** `format` is `json` for all four targets, so the format cannot pick the driver.
`PlannedHarnessConfig` and `OwnedArtifact` gain a `shape?: "map" | "array"`, and `driverFor(format,
shape)` dispatches on both. `shape` is recorded in state for the same reason `format` is
(`src/model/state.ts:47-54`): prune and clean act from state alone and must not re-resolve the project
to find out how to edit a file. Absent reads as `"map"`, exactly as absent `format` reads as `json`.

**Cursor's `version: 1`.** `PlannedHarnessConfig.rootDefaults?: Readonly<Record<string, unknown>>`,
applied by the driver **only for root keys the document does not already have**. ambit adds `version: 1`
when it creates `.cursor/hooks.json` and never overwrites a `version: 2` someone else wrote — where
dotagents forces it back to `1` because it owns the whole document.

**The hook name is deliberately absent from the managed key.** The key is machine identity; the human
name lives in the `hooks` rows of `resolve --explain`, `why`, `ambit.lock` and `status`, which are keyed
by hook name because they are bundle items. Putting the name in the key would mean `sectionKeys` had to
return something it cannot read off the file, and normalizing the two forms at every comparison site is
a cost with no reader benefit.

**Digest determinism.** The digest is computed over the entry ambit renders, serialized with keys in a
fixed order — the order the profile's renderer builds them in, which is already the contract
`ConfigEntry.value` states (`documents/format.ts:28-35`). No timestamps, no paths outside the project,
no environment. Two people installing the same bundle get the same digests, which is the same property
the lock already depends on.

### 5. Ownership semantics

Unchanged in shape from the per-key story in `src/project/ownership.ts:181`:

- **A conflict is an entry already in the file whose digest matches one ambit would write, that state
  does not claim.** That is a user who hand-wrote the same hook ambit is about to install; refusing it
  and offering `--adopt` is exactly what `refuseKey` (`ownership.ts:149`) does for a colliding server
  name. On `--adopt`, ambit claims it and thereafter prunes it like its own.
- **Every other pre-existing entry is invisible to ambit and never a conflict.** It has a different
  digest, so it is not in `artifact.entries`, so `checkConfigKeys` never looks at it, so nothing
  removes it. This is the issue's requirement, and it falls out of the identity scheme rather than
  needing a rule.
- A hand-edited ambit entry no longer matches its recorded digest → `configVerdict`
  (`src/project/status.ts:312`) reports `missing`/`modified` rather than silently appending a duplicate,
  and the next install prunes the stale digest and writes the current one.

### 6. Materialization

- `SHARED_HOOKS_DIR = ".agents/hooks"` beside `SHARED_SKILLS_DIR` (`src/harness/profile.ts:49`).
- `PlannedHookDir` joins `PlannedArtifact` and `PlannedPathArtifact`
  (`src/harness/adapter.ts:101`, `:104`); `ARTIFACT_KINDS` (`src/model/state.ts:29`) gains `hook-dir`.
  It reuses `modeOf` (`profile.ts:94`), `applySkillDir`'s logic, `--copy`/`--link`, and the
  `blockingAncestor` check — the shape is identical to a skill directory, so `applySkillDir` and
  `applyHookDir` should be one function over `PlannedSkillDir | PlannedHookDir`.
  `fs.cp` preserves mode, so a script's executable bit survives a copy; a symlinked hook needs nothing.
- `gitignoreBlocks` (`src/project/gitignore.ts:199`) partitions by path and filters by kind — add
  `hook-dir` to that filter. `.agents/hooks/*` lands in the volatile `.agents/.gitignore` block for
  free, since it is under `.agents/`.
- Only a hook that ships a script plans a directory. An inline hook plans a config entry and nothing
  else.
- `HarnessProfile` (`src/harness/profile.ts:62`) gains `hooks?: HookLayout` (`{file, section, format,
shape, rootDefaults?}`) and `hookConfig(hook: MergedHook, project: ProjectPaths): unknown` — the
  per-harness renderer, the exact counterpart of `serverConfig`. Absent `hooks` means the harness has
  no mechanism, which is `opencode`.
- A hook whose event a configured harness cannot express is **skipped and reported**, not an error.
  With the eight-event set every harness covers all eight, so this path exists for the vocabulary
  growing rather than for today — but it is where the `opencode` warning is raised too.
- **Command rewriting.** For a hook that ships a script, `hookConfig` writes the materialized path the
  way that harness resolves one. This is genuinely per-harness — verified, not assumed — and maps onto
  the seam `translateRefs` (`src/harness/env.ts`) already establishes: one string, spelled the way each
  harness expands it.

  | harness            | written command                                    | why                                                                                                                                                                                                                                                                              |
  | ------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `claude`, `vscode` | `${CLAUDE_PROJECT_DIR}/.agents/hooks/<name>/<cmd>` | Documented placeholder, interpolated in `command`.                                                                                                                                                                                                                               |
  | `cursor`           | `.agents/hooks/<name>/<cmd>`                       | Project hooks run from the project root, and Cursor interpolates no placeholder in `command`.                                                                                                                                                                                    |
  | `codex`            | `.agents/hooks/<name>/<cmd>`                       | No placeholder exists; commands run with the session cwd. Codex's docs suggest `$(git rev-parse --show-toplevel)/…`, which ambit will **not** write — it assumes git and a POSIX shell, and embedding a subshell in a config file is the opposite of a value a reader can check. |

  The Codex and Cursor relative paths miss if a session's cwd is not the project root. That is the
  harness's own limitation, is what a person writing the hook by hand would hit too, and `doctor` is the
  place to say so if it turns out to bite.

  Two facts to confirm while implementing, because both are documented loosely: whether VS Code expands
  `${CLAUDE_PROJECT_DIR}` when it reads Claude's file, and whether Cursor's relative-path resolution
  holds for a hook under `.agents/` rather than `.cursor/`.

### 7. Lock, reports, authoring

- `Lock.hooks: Record<string, LockHook>` (`src/project/lock.ts:76`) — `{catalog, path?, commit?,
reason}`. `path`/`commit` only where the hook ships a script, since only then does it have bytes; an
  inline hook is config values, which is `LockMcp`'s argument (`lock.ts:55-61`).
- Third counts/kinds in `validate.ts` (`VALIDATION_PROBLEM_KINDS:66`, `ValidationCounts`),
  `audit.ts` (`AUDIT_FINDING_KINDS:53` gains `unreachable-hook`, `AuditCounts`), and `tree.ts`
  (`ScopeSelection:40` gains `hooks`, `selectionSize`).
- `doctor` checks hook `env` vars through the existing `env` check, and adds one **warning** when
  `codex` is configured and hooks are selected: Codex hooks need `[features] codex_hooks = true`, which
  is user-level config ambit must not write. Warning, not failure — the same stance the module takes on
  materialization mode (`src/project/doctor.ts:16-23`).
- `src/authoring/editor.ts`: `hookDirectoryPath(name)` and `hookDocumentPath(name)` beside
  `skillDirectoryPath` (`editor.ts:150`). `isParsedFile` already accepts `HOOK.yml` via
  `PARSED_EXTENSIONS`, and `CatalogTreeChange` already handles a directory that carries opaque bytes —
  which a hook's script is.
- `src/authoring/hook.ts`, modelled on `authoring/skill.ts` (a directory) rather than
  `authoring/mcp.ts` (a file): `newHook` writes `HOOK.yml` through `emitYaml`, `removeHook` refuses
  while any skill requires `hook.<name>`, naming every requirer. `catalog annotate` gains the
  `hook.<name>` subject.
- `COMMAND_SPECS` (`src/cli/commands.ts:101`) gains a `hook` group under `catalog`; `HANDLERS`
  (`src/cli/program.ts:48`) gains `catalog hook new` / `catalog hook rm`; `src/index.ts` exports the new
  symbols explicitly, as that barrel does.

### 8. The kind-dispatch sites that fail silently

`ARTIFACT_KINDS` gaining `hook-dir` is a type error at every exhaustive site, which is the easy half.
The dangerous half is the `else` / `!== "harness-config"` / `continue` branches, where a new kind is
silently routed into the wrong arm and **typechecks clean**. These five are the whole risk surface of
this change:

| Site                                           | What goes wrong                                                                                                                          | Fix                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `src/project/prune.ts:69` `plannedPaths`       | Filters to `skill-dir`/`skills-link`, so a still-planned hook directory looks stale and **is deleted on every install**, then rewritten. | Add `hook-dir`.                                                           |
| `src/project/status.ts:390` `compareArtifacts` | Falls past the two path branches into the config branch, handing a `PlannedHookDir` to `configVerdict`.                                  | Add a `hook-dir` branch (reuse `skillVerdict`).                           |
| `src/harness/profile.ts:293` `apply`           | The trailing `else` sends a hook directory to `applyHarnessConfig`.                                                                      | Branch, or make `applySkillDir` take `PlannedSkillDir \| PlannedHookDir`. |
| `src/project/gitignore.ts:204`                 | `continue` skips any other kind, so `.agents/hooks/*` is never ignored and every copied script shows as untracked.                       | Add `hook-dir`.                                                           |
| `src/project/doctor.ts:392`                    | The mode check counts only `skill-dir`, so a hook directory's copy/link mode is never reported.                                          | Add `hook-dir`.                                                           |

Three sites are already correct by construction and should be left alone: `planFor`
(`install.ts:192`) dedupes path artifacts across adapters, which is what a shared `.agents/hooks/<name>`
wants; `authorizePlan` (`ownership.ts:225`) and `pruneArtifacts` (`prune.ts:284`) both treat
"not `harness-config`" as "owned as a path", which is exactly right for a hook directory.

Worth a test each, since a passing typecheck says nothing about any of them.

## Work breakdown

Each phase keeps `npm test && npm run typecheck && npm run lint` green.

1. **Model.** `src/model/hook-entity.ts`, catalog parsing (`HOOKS_DIRNAME`, the walk, `CatalogHook`,
   `MergedHook`, merge and shadowing), `ambit.yml`'s `hooks:` key. Hooks appear in `dump-catalog` and
   nowhere else yet. Tests: `test/model/hook-entity.test.ts`, additions to
   `test/model/{catalog,config}.test.ts`.
2. **Resolution.** `HOOK_REQUIREMENT_PREFIX`, `ItemKind`, `Bundle.hooks`, reasons, `validate`, `why`.
   Golden files under `test/golden/resolve/` are regenerated with `UPDATE_GOLDEN=1 npm test` — read the
   diff.
3. **The array driver.** `src/model/documents/json-array.ts`, the digest helper, `shape` on
   `PlannedHarnessConfig`/`OwnedArtifact`, `driverFor(format, shape)`, `rootDefaults`. Pure and
   filesystem-free, so it is testable on its own: `test/model/documents/json-array.test.ts` is where the
   coexistence promise gets its direct tests — a foreign entry in the same event array survives a
   merge, a remove, and a full install/prune cycle byte-for-byte.
4. **Harness + install.** `HookLayout`, `hookConfig` for the four profiles, `PlannedHookDir`,
   `hook-dir` in `ARTIFACT_KINDS` and the gitignore filter, the `opencode` warning.
5. **Reports.** Lock section, `status`, `doctor`, `audit`, `tree`, and the `SURFACES` rows in
   `test/determinism.test.ts:145` — its header states that adding a command means adding a row, and
   that is the whole of extending it.
6. **Authoring.** `src/authoring/hook.ts`, `catalog hook new|rm`, `catalog annotate hook.<name>`,
   `catalog init` scaffolding a `hooks/.gitkeep` beside `mcps/.gitkeep`.
7. **Fixture + README.** Add hooks to `scripts/fixture-catalog.ts` — one inline, one shipping a script,
   one reachable only through a skill's `requires` — then document hooks in `README.md`: the concepts
   table, the `HOOK.yml` file format, the resolution steps, and the CLI reference. Drop "(soon)" from
   `README.md:3`.

## Existing tests that will need updating

Not incidental churn — each one is a surface pinned on purpose, so each diff should be read.

- `test/golden/resolve/*.json` (6 files) — every bundle gains a `hooks` list. `UPDATE_GOLDEN=1 npm test`.
- `test/golden/catalog-tree.json` — `ScopeSelection` gains `hooks`, so every node's counts change.
- `test/project/lock.test.ts:167` — pins the empty lock as literal text. `emitYaml` sorts keys, so
  `hooks: {}` lands between `catalogs:` and `mcps: {}`.
- `test/determinism.test.ts:145` `SURFACES` — the file's header states that adding a command means
  adding a row, and that is the whole of extending it.
- `test/dotagents.test.ts` — asserts dotagents installs exactly `parseCatalogDirectory`'s skill set from
  the fixture. Once the fixture holds hooks, this proves `hooks/` is additive and ignored, which is
  worth having; it fails if a hook ever leaks into `catalog.skills`.
- `scripts/fixture-catalog.ts` `FIXTURE_CATALOG_FILES` — and `test/fixture-catalog.test.ts` with it.

## Verification

- `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build` — the five
  checks CI runs, on Node 20 and 22.
- `UPDATE_GOLDEN=1 npm test`, then **read the golden diff** rather than accepting it.
- **The issue's headline claim, tested directly.** In a temp project, hand-write a `.claude/settings.json`
  holding a `SessionStart` hook and a `PostToolUse` hook ambit does not know about, plus `permissions`
  and `model` keys. Then `ambit install`, `ambit install` again, `ambit prune`, and `ambit clean`. Assert
  after each: every foreign entry and every sibling key is byte-identical, and after `clean` the file
  still exists holding exactly what the user wrote. This is the case dotagents fails, so it deserves a
  named test rather than a line in a larger one.
- **Idempotence.** `ambit install` twice leaves the four config files byte-identical; `ambit status
--check` exits 0.
- **Adoption.** Hand-write an entry identical to one ambit would install → `install` exits 2 naming the
  key, project untouched; `install --adopt` takes it over and a later `prune` removes it.
- **End-to-end against a real harness.** Install a fixture hook into a scratch project, run Claude Code
  in it, and confirm the hook fires — the hooks equivalent of what `test/dotagents.test.ts` does for
  skills. Manual, not in the suite.
