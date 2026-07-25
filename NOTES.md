# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A10 — MCP selection and `.mcp.json`** (the tip of `main`).

## Constraints later tasks inherit

- **`PlannedArtifact` is now a union**: `PlannedSkillDir | PlannedHarnessConfig`. Anything reading
  `artifact.mode` or `artifact.source` must narrow on `kind` first. `claudeAdapter.plan` emits the
  skill dirs (sorted) followed by at most one `.mcp.json` artifact, and `applyPlan` switches on
  `kind`.
- **`ProjectPaths` gained `env`** (`Readonly<Record<string, string | undefined>>`). `installProject`
  passes `process.env` once, so `plan` stays a pure function of its arguments and a test can pin
  `${VAR}` interpolation without touching the real environment. Every `claudeAdapter.plan` call site
  must supply it.
- **`.mcp.json` is co-owned, so ambit owns keys and not the file.** `src/harness-config.ts` reads the
  document, replaces only `mcpServers.<name>`, and writes everything else back with existing keys in
  their original position (new ones appended in entry order). **A17's ownership check must be
  per-key for `harness-config`** — an unowned `.mcp.json` is a normal input, not a conflict — and
  **A18's pruning removes managed keys from the section, not the file.**
- A bundle with no MCPs plans **no** `.mcp.json` artifact at all, so a project that uses no servers
  never acquires the file. A18 therefore cannot rely on the artifact being planned to know it must
  prune: it has to work from `prior` state.
- `${VAR}` in http `headers` is interpolated at install (spec §5). A variable that is not set leaves
  its placeholder in the file rather than emptying the value; **A24's `doctor` is what reports it**.
  Nothing warns today, because `apply` has no io channel.
- Server shape written for the harness: stdio → `command` (+ `args` when non-empty, no `type`);
  http → `type: "http"`, `url`, `headers` (sorted by name, omitted when empty). The entity's `env`
  list is a declaration for `doctor` and is deliberately **not** written into `.mcp.json`.
- **`closeOverRequires(skills, mcps, merged): Selection`** in `src/resolve.ts` is the only place
  `requires` is walked. It takes the roots as arguments so **A11** can add explicit `skills`/`mcps`
  entries to the seed lists instead of teaching the walk about config. Its result lists are
  `merged.*.filter(...)`, so they stay in name order — `resolve --json` golden files depend on it.
- Only skills carry `requires` (spec §3.3 gives MCP entities no such key), so the graph is
  skill → skill with MCP entities as leaves. `mcp.`-prefixed targets resolve against MCP names with
  the prefix stripped; everything else against skill names.
- Cycle detection inside `closeOverRequires` **throws on the first cycle it meets**; **A23's
  `validate` needs a multi-problem variant**, as it does for unknown scopes.
- `resolve` hard-validates the **closure only** (spec §4 validation split): a skill nothing selects
  may carry a dangling `requires` and resolution still exits 0. A23 is what rejects it catalog-wide.
- **`ProjectConfig` carries `origin: ConfigOrigin { file, scopeLines }`.** Later post-parse errors —
  A11's unresolvable explicit skill, A15's conflicting descriptions — should extend `ConfigOrigin`
  the same way (`skillLines`, …) rather than re-reading the document.
- **`at(file, line)` lives in `src/errors.ts`** (degrades to `(file)`). Errors about a *catalog* file
  cite the catalog-relative path (`skills/…/SKILL.md`); errors about a project file cite the
  project-relative one (`.mcp.json`), since absolute roots are machine-specific.
- **`assertScopesRegistered(config, registered)`** runs first inside `resolveBundle`, so `install` is
  guarded too. Suggestion policy: exact Levenshtein, threshold `max(2, floor(len/3))`, ties broken by
  the registry's sorted order. Holding an unregistered *parent* is an unknown scope.
- **`MergedSkill.catalogRoot` (absolute) must stay out of every output surface.**
- **`Bundle.scopes` reports the held scopes as configured, not the expansion.** A12's
  `--explain`/`why` must derive the chain from `config.scopes` plus the registry, and the
  `required-by` edges from each skill's `requires`.

## Deliberate omissions, and who owns them

- `apply` removes a target only when `prior` state already owns it; nothing removes managed keys from
  `.mcp.json` yet. Refusing unowned targets and `--adopt` are **A17**; pruning is **A18**.
- No `.gitignore` handling at all — **A21**. `.mcp.json` is a committed file, so only `.ambit/` and
  copied skills belong in that block.
- Unimplemented flags throw exit 1 "not implemented yet" from an `UNIMPLEMENTED` map in
  `src/handlers/install.ts` (`--dry-run`, `--frozen`, `--adopt`, `--copy`, `--link`) and from the
  handler itself for `resolve --explain`. **When your task implements one, delete its entry from that
  map — and `test/install.test.ts` has a loop asserting all five, so remove the matching case too.**

## Traps

- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. One selection change touches several at once; regenerate with
  `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- `test/install.test.ts`'s default profile is `[core, function.engineering]`, which selects the
  `scoped` http server — so it writes `.mcp.json` too. Its state, `--json`, and padded-text
  assertions all list four artifacts; adding a fifth shifts the column widths.
- That file stubs `SCOPED_API_KEY` to `undefined` in `beforeEach` (`vi.stubEnv`) because the fixture
  interpolates it into a header. Any new test that installs and asserts file contents needs the same
  discipline.
- The fixture catalog must stay cycle-free and dangling-free: `validate` (A23) will be run against
  it, and every golden profile resolves it. Tests that need extra catalog shapes write them into the
  per-test copy (`writeSkill` in `test/resolve.test.ts`, `writeCatalogFile` in
  `test/install.test.ts`) rather than into `scripts/fixture-catalog.ts`.
- The text output of `resolve`, `catalog`, and `install` is asserted with exact column padding, built
  by `src/output.ts`.
- Whole-object `toEqual` assertions on `ProjectConfig` in `test/config.test.ts` must be updated
  whenever the config type gains a field.
