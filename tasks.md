# Hooks support — carpaccio backlog

Execution plan for `plan.md` ([#14](https://github.com/nebulab/ambit/issues/14)), sliced into
independently shippable increments. `plan.md` stays the design authority: every task below cites the
section that justifies it and adds no decisions of its own.

## Loop protocol

One iteration = one task.

1. Read `plan.md` (the design) and this file. Pick the **first unchecked task**.
2. Implement only that task. Do not pull work forward from a later one, even when it looks adjacent —
   if the task genuinely cannot close without it, append a `> blocked:` note under the task and stop.
3. Run the gate: `npm run lint && npm run format:check && npm run typecheck && npm test`.
4. Commit with `hooks(N): <title>`, tick the checkbox, stop. The next iteration starts clean.

### Invariants after every task

- The five CI checks pass. A task is not done with a skipped or `.todo` test.
- `ambit install` twice leaves every written file byte-identical.
- No harness config file loses a byte ambit does not own. This is the issue's headline promise and it
  regresses silently — task 4 pins it, and it must stay pinned.
- Golden files are regenerated with `UPDATE_GOLDEN=1 npm test` and the **diff is read**, not accepted.
  A golden diff that surprises you is a bug in the task, not in the golden.

### Slicing rationale

`plan.md`'s own §Work breakdown is layered (model → resolution → driver → …), which means nothing
observable exists until step 4. This backlog re-cuts the same work vertically: tasks 1–4 walk a hook
from a declaration to a live `.claude/settings.json` through the thinnest possible path — inline
`hooks:` in `ambit.yml`, one harness, no scripts, no catalog — and every task after that widens one
dimension (harness, declaration surface, distribution, reporting) against a skeleton that already runs.

---

## 1. The hook entity

- [x] `src/model/hook-entity.ts`, pure, wired to nothing.

**Slice** — the vocabulary exists and rejects bad input. Nothing reads it yet.

**Do** — `HOOK_EVENTS`, `MATCHABLE_EVENTS`, `HookEntity`, `parseHookEntity`, mirroring
`src/model/mcp-entity.ts` and its error stance. Full validation now: unknown `event` → exit 2 listing
the supported set (`parseTransport`'s stance on an unknown kind); `matcher` on a non-matchable event →
exit 2; `command` required. `plan.md` §1.

**Skip** — the "does this name a file in the hook's directory" derivation. That needs a catalog
directory to look at, so `shipsScript` is task 7's. Take `command` as an opaque string here.

**Done when** — `test/model/hook-entity.test.ts` covers each field, each rejection, and the exact
error text for an unknown event.

## 2. `hooks:` in `ambit.yml`, visible in `resolve`

- [x] Config parsing plus a bundle that carries hooks.

**Slice** — a person can declare an inline hook and `ambit resolve --explain` lists it. Nothing is
written to a harness yet.

**Do** — `CONFIG_KEYS` gains `hooks`; `parseHooks` mirrors `parseMcps` (`config.ts:185`) including the
`nameTracker` duplicate check; `ProjectConfig.hooks`; `ConfigOrigin.hookLines`. Then `ItemKind` becomes
`"skill" | "mcp" | "hook"`, `Bundle.hooks`, `SelectionReasons.hooks`, the third `selectionReasons` call
in `resolveBundle` (`resolve.ts:627`), and `bundle.env` unions hook `env`. `plan.md` §3.

**Skip** — `hook.<name>` in `requires` (task 8). An inline hook is selected because it was declared,
which needs no graph.

**Done when** — additions to `test/model/config.test.ts` and `test/resolution/resolve.test.ts`;
`test/golden/resolve/*.json` regenerated, each bundle gaining an empty `hooks` list.

## 3. The array-section driver

- [x] `src/model/documents/json-array.ts` and its selection.

**Slice** — the load-bearing piece, pure and filesystem-free. `plan.md` §4 calls this the actual work
in the change; it gets its own task so it gets its own direct tests.

**Do** — the digest helper (SHA-256 of canonical JSON, first 12 hex), the managed key grammar
`hooks.<Event>@<digest>`, and the four `DocumentDriver` methods over `section.<Event>: [entries]`.
`sectionKeys` derives keys from the file alone by digesting each entry. `mergeSection` appends only
digests not already present. `removeKeys` returns `undefined` when nothing matched. Then `shape?:
"map" | "array"` on `PlannedHarnessConfig` and `OwnedArtifact`, `driverFor(format, shape)` (absent
reads as `"map"`), and `rootDefaults` applied only to root keys the document lacks.

**Do not** change the `DocumentDriver` interface. §4 is explicit that it already fits; if it appears
not to, that is a signal to re-read the section, not to widen the seam.

**Done when** — `test/model/documents/json-array.test.ts` proves, directly and without touching disk:
a foreign entry in the same event array survives a merge; survives a remove of ambit's entries; a
second merge of the same entries is a no-op; `removeKeys` with nothing to remove returns `undefined`;
`rootDefaults` does not overwrite an existing `version`.

## 4. `claude` + `vscode` end to end

- [x] Install, status, prune and clean an inline hook.

**Slice** — the walking skeleton closes. An inline hook declared in `ambit.yml` lands in
`.claude/settings.json`, and the issue's headline promise is demonstrable. One file serves both
harnesses; `vscode` reads Claude's file natively, so it costs a definitions entry and no renderer.

**Do** — `HarnessProfile.hooks?: HookLayout` and `hookConfig(hook, project)` for the shared Claude
file (`plan.md` §6), planning as a `PlannedHarnessConfig` with `shape: "array"`; install writing it;
`shape` recorded in state so prune and clean act from state alone; ownership per §5 — a pre-existing
entry whose digest matches one ambit would write is a conflict offering `--adopt`, every other entry is
invisible.

**Done when** — a named test asserts the whole §Verification headline case: a hand-written
`.claude/settings.json` holding a foreign `SessionStart` hook, a foreign `PostToolUse` hook, and
`permissions` + `model` keys survives `install`, a second `install`, `prune` and `clean`
byte-identically, and after `clean` still holds exactly what the user wrote. Plus: idempotence
(`status --check` exits 0 after two installs) and adoption (identical hand-written entry → exit 2
naming the key, project untouched; `--adopt` takes it over and a later `prune` removes it).

## 5. `cursor`

- [x] `.cursor/hooks.json`.

**Slice** — a second, differently-shaped harness. Cursor is where the neutral vocabulary earns itself.

**Do** — the layout from §Harness hook layouts, the PascalCase → camelCase event map, `matcher`
dropped, and `rootDefaults: {version: 1}` — added when ambit creates the file, never overwriting a
`version` someone else wrote.

**Done when** — an install test per event covering the map, a test that a hand-written `version: 2`
survives, and a test that a `matcher` on a `PreToolUse` hook is dropped rather than written through.

## 6. `codex`, and the harnesses that cannot

- [x] `.codex/hooks.json`, plus the skip paths.

**Slice** — every harness the change covers is covered, and the two that decline say so out loud.

**Do** — Codex on `.codex/hooks.json` (**not** `[hooks]` in `config.toml` — §Harness hook layouts
gives the reason, and the TOML driver refuses array-of-tables anyway), Claude-shaped. A hook selected
while `opencode` is configured is **skipped with a warning**, not an error, and the same path handles a
future event a harness cannot express.

**Done when** — install tests for Codex; a test that `opencode` + a selected hook warns and exits 0;
additions to `test/harness/definitions.test.ts`.

## 7. Catalog hooks

- [x] `hooks/<name>/HOOK.yml`.

**Slice** — hooks become distributable. Until now they only existed inline in one project's config.

**Do** — `HOOKS_DIRNAME`, `HOOK_FILENAME`, `findHookDirectories` beside `findSkillDirectories`
(`catalog.ts:413`) reusing `skillNameFromPath`, `CatalogHook` (`path`, `shipsScript`), `MergedHook`,
`Catalog.hooks` / `MergedCatalog.hooks` / `Shadowings.hooks`, the third loop in `mergeCatalogs`
(`catalog.ts:861`) and `mergeConfigEntities` (`catalog.ts:757`), and the hooks pass in
`parseCatalogDirectory` (`catalog.ts:571`). `shipsScript` is **derived** here — `command` names a file
the hook's directory actually holds — and a typo is exit 2 naming the directory's contents. `plan.md`
§2.

**Interim honesty** — materialization is task 9, so installing a script-shipping hook must fail with a
clear "not supported yet" rather than writing a command that will not run. Delete that guard in task 9.

**Done when** — `ambit dump-catalog` shows hooks; scope selection picks a hook up; a hook shadows by
catalog order like a skill; additions to `test/model/catalog.test.ts`.

## 8. `hook.<name>` in `requires`

- [x] The third requirement prefix.

**Slice** — a skill can pull its hook in, which is how a hook reaches a project without being named.

**Do** — `HOOK_REQUIREMENT_PREFIX = "hook."` beside `MCP_REQUIREMENT_PREFIX` (`resolve.ts:43`), the
third prefix branch in `closeOverRequires` (`resolve.ts:329`) — hooks are leaves and carry no `requires`
of their own, so no new graph — `ambit why hook.<name>` insisting on a hook where a bare name resolves
to a skill first, and the third counts/kinds in `validate.ts` (`VALIDATION_PROBLEM_KINDS:66`,
`ValidationCounts`). `plan.md` §3.

**Done when** — `test/resolution/{resolve,validate}.test.ts` cover a hook reached only through a
`requires`, an unknown `hook.<name>`, and `why` on both a hook and a bare name that is also a skill.

## 9. Shipped scripts

- [ ] Materialization to `.agents/hooks/<name>/`, and the five silent dispatch sites.

**Slice** — the thing dotagents cannot do at all: a hook that ships its own script.

**Do** — `SHARED_HOOKS_DIR`, `PlannedHookDir` joining `PlannedArtifact`/`PlannedPathArtifact`,
`hook-dir` in `ARTIFACT_KINDS`, and `applySkillDir` generalized to `PlannedSkillDir | PlannedHookDir`
rather than copied. `--copy`/`--link`, `modeOf`, `blockingAncestor` all come along unchanged. Only a
script-shipping hook plans a directory. `plan.md` §6.

Then §8's five sites, each of which **typechecks clean while doing the wrong thing**:

| Site                               | Fix                                                          |
| ---------------------------------- | ------------------------------------------------------------ |
| `prune.ts:69` `plannedPaths`       | add `hook-dir`, or the directory is deleted on every install |
| `status.ts:390` `compareArtifacts` | add a `hook-dir` branch reusing `skillVerdict`               |
| `profile.ts:293` `apply`           | branch, or take the widened `applySkillDir`                  |
| `gitignore.ts:204`                 | add `hook-dir`, or every copied script shows untracked       |
| `doctor.ts:392`                    | add `hook-dir`, or the mode check never reports it           |

Leave `planFor` (`install.ts:192`), `authorizePlan` (`ownership.ts:225`) and `pruneArtifacts`
(`prune.ts:284`) alone — §8 explains why each is already right.

**Done when** — a test per row. A passing typecheck says nothing about any of them, which is the whole
reason they are listed. Plus: the executable bit survives a `--copy` install, and `.agents/hooks/*`
lands in the volatile `.agents/.gitignore` block.

## 10. Per-harness command rewriting

- [ ] The command a shipped script is written as.

**Slice** — the materialized script is actually reachable from each harness.

**Do** — the §6 table: `${CLAUDE_PROJECT_DIR}/.agents/hooks/<name>/<cmd>` for `claude`/`vscode`,
project-relative for `cursor` and `codex`. Do **not** write Codex's suggested
`$(git rev-parse --show-toplevel)/…`; §6 gives the reason.

**Confirm while implementing** — both facts §6 flags as loosely documented: whether VS Code expands
`${CLAUDE_PROJECT_DIR}` reading Claude's file, and whether Cursor's relative-path resolution holds for
a hook under `.agents/` rather than `.cursor/`. Record what you found in the commit message. If either
turns out false, stop and note it here rather than inventing a workaround.

**Done when** — an install test per harness pinning the written command string.

## 11. Lock

- [ ] `Lock.hooks`.

**Do** — `LockHook` = `{catalog, path?, commit?, reason}` (`lock.ts:76`), with `path`/`commit` only
where the hook ships bytes; an inline hook is config values, which is `LockMcp`'s argument.

**Done when** — `test/project/lock.test.ts:167` updated: `emitYaml` sorts keys, so `hooks: {}` lands
between `catalogs:` and `mcps: {}` in the empty-lock literal.

## 12. `status`

- [ ] Hook rows, and the command surface pin.

**Do** — hook rows in `status`; `configVerdict` (`status.ts:312`) reporting `missing`/`modified` for a
hand-edited ambit entry whose digest no longer matches, and the next install pruning the stale digest
and writing the current one (§5).

**Done when** — a test for the hand-edit → `modified` → install-heals cycle, and the `SURFACES` rows in
`test/determinism.test.ts:145`.

## 13. `doctor`, `audit`, `tree`

- [ ] The remaining reports.

**Do** — `doctor` checks hook `env` vars through the existing `env` check and adds one **warning**
when `codex` is configured and hooks are selected (Codex needs `[features] codex_hooks = true`, which
is user-level config ambit must not write — a warning, not a failure, matching `doctor.ts:16-23`).
`audit.ts` gains `unreachable-hook` (`AUDIT_FINDING_KINDS:53`) and the count. `tree.ts` gains `hooks`
on `ScopeSelection:40` and in `selectionSize`.

**Done when** — `test/golden/catalog-tree.json` regenerated (every node's counts change — read the
diff), plus tests for the doctor warning and the audit finding.

> note (task 8): `audit`'s dead-scope rule already counts hook declarations, through a local
> `scopesHooksDeclare` in `audit.ts` — a scope only a hook declared read as unused, which was live the
> moment catalog hooks parsed. Once `ScopeSelection` carries `hooks`, fold that back into
> `selectionSize` and delete the helper, so one function answers "what does this scope select?" again.

## 14. Authoring

- [ ] `ambit catalog hook new|rm` and `catalog annotate hook.<name>`.

**Do** — `src/authoring/hook.ts` modelled on `authoring/skill.ts` (a directory) rather than
`authoring/mcp.ts` (a file): `newHook` writes `HOOK.yml` through `emitYaml`; `removeHook` refuses while
any skill requires `hook.<name>`, naming every requirer. `hookDirectoryPath` / `hookDocumentPath` in
`editor.ts` beside `skillDirectoryPath` (`editor.ts:150`). `COMMAND_SPECS` (`commands.ts:101`) gains a
`hook` group under `catalog`; `HANDLERS` (`program.ts:48`) gains the two commands; `src/index.ts`
exports the new symbols explicitly. `catalog init` scaffolds `hooks/.gitkeep` beside `mcps/.gitkeep`.

**Done when** — `test/authoring/catalog-hook.test.ts`, an update to `test/authoring/catalog-init.test.ts`,
the `catalog annotate` subject test, and the new `SURFACES` rows.

## 15. Fixture catalog

- [ ] Hooks in `scripts/fixture-catalog.ts`.

**Do** — three hooks: one inline, one shipping a script, one reachable only through a skill's
`requires`. Update `FIXTURE_CATALOG_FILES` and `test/fixture-catalog.test.ts`.

**Done when** — `test/dotagents.test.ts` still passes untouched. It asserts dotagents installs exactly
`parseCatalogDirectory`'s skill set from the fixture, so it now doubles as proof that `hooks/` is
additive and that no hook leaks into `catalog.skills`.

## 16. README

- [ ] Document hooks.

**Do** — the concepts table, the `HOOK.yml` file format, the resolution steps, the CLI reference. Drop
`(soon)` from `README.md:3`. House style: the README was tightened deliberately in recent commits —
match what is there rather than expanding it.

## 17. Verification gate

- [ ] The checks that are not a unit test.

**Do** — `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build` on
Node 20 and 22. Re-read every golden diff accumulated across the backlog in one pass. Then the manual
end-to-end `plan.md` §Verification asks for and does not put in the suite: install a fixture hook into
a scratch project, run Claude Code in it, confirm the hook fires. Report the result — this one is
observed, not asserted.
