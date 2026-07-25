# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A09 — `requires` closure and cycles** (the tip of `main`).

## Constraints later tasks inherit

- **`closeOverRequires(skills, mcps, merged): Selection`** is exported from `src/resolve.ts` and is
  the only place `requires` is walked. It takes the roots as arguments precisely so **A11** can add
  explicit `skills`/`mcps` entries to the seed lists instead of teaching the walk about config. Its
  result lists are `merged.*.filter(...)`, so they stay in name order whatever order the walk
  discovered them in — keep that property, `resolve --json` golden files depend on it.
- Only skills carry `requires` (spec §3.3 gives MCP entities no such key), so the graph is
  skill → skill with MCP entities as leaves. `mcp.`-prefixed targets resolve against MCP names with
  the prefix stripped; everything else against skill names.
- Cycle detection is the colouring inside `closeOverRequires` (a `path` array for the current
  chain, a `closed` set for what has been followed through) and it **throws on the first cycle it
  meets**. **A23's `validate` needs a multi-problem variant** — as it does for unknown scopes.
- `resolve` hard-validates the **closure only** (spec §4 validation split): a skill nothing selects
  may carry a dangling `requires` and resolution still exits 0. `test/resolve.test.ts` pins that;
  A23 is what rejects it catalog-wide.
- **`ProjectConfig` carries `origin: ConfigOrigin { file, scopeLines }`.** Resolution runs after
  parsing, so no YAML node survives to cite; `origin` carries the config's filename (`ambit.yml`
  vs `ambit.yaml`) and the 1-based line of each held scope. Later post-parse errors — A11's
  unresolvable explicit skill, A15's conflicting descriptions — should extend `ConfigOrigin` the
  same way (`skillLines`, …) rather than re-reading the document.
- **`at(file, line)` lives in `src/errors.ts`** (degrades to `(file)`), not in `yaml.ts`. Any
  module raising a positioned error uses it. Deliberately not re-exported from `src/index.ts`.
  Errors raised about a *catalog* file cite the catalog-relative path (`skills/…/SKILL.md`), since
  the absolute root is machine-specific.
- **`assertScopesRegistered(config, registered)`** runs first inside `resolveBundle`, so `install`
  is guarded too. It throws on the first (alphabetically first) offender.
  `expandHeldScopes` stays total: an unregistered scope still expands to nothing.
- Suggestion policy for unknown scopes: exact Levenshtein, threshold `max(2, floor(len/3))`,
  ties broken by the registry's sorted order. Holding an unregistered *parent* (bare `function`
  when only `function.engineering` is registered) is an unknown scope.
- **`MergedSkill.catalogRoot` (absolute) must stay out of every output surface** — excluded from
  `resolve --json` and `catalog --json` so golden files stay machine-independent.
- **`Bundle.scopes` reports the held scopes as configured, not the expansion.** A12's
  `--explain`/`why` must derive the chain held → descendant → item from `config.scopes` plus the
  registry, and the `required-by` edges from each skill's `requires`.
- **`PlannedArtifact` carries both `path`** (project-relative — the state identity) **and
  `target`** (absolute), which is what lets `apply(plan, prior)` match the spec §5 signature
  without a project argument. A10 extends this union with a `harness-config` variant;
  `src/state.ts` already models `managedKeys`.

## Deliberate omissions, and who owns them

- `apply` removes a target only when `prior` state already owns it. Refusing unowned targets and
  `--adopt` are **A17**; pruning is **A18**. `install` adds and overwrites but never removes.
- The bundle's `mcps` reach `resolve` output only; nothing writes `.mcp.json` yet — **A10**. The
  fixture's requires-only server (`fixture`) is already in the `project.acme` bundle, so A10 has a
  ready subject for "scope-matched plus requires-only".
- No `.gitignore` handling at all — **A21**.
- Unimplemented flags throw exit 1 "not implemented yet" from an `UNIMPLEMENTED` map in
  `src/handlers/install.ts` (`--dry-run`, `--frozen`, `--adopt`, `--copy`, `--link`) and from the
  handler itself for `resolve --explain`. **When your task implements one, delete its entry from
  that map — and `test/install.test.ts` has a loop asserting all five, so remove the matching
  case there too.**

## Traps

- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. One selection change touches several at once; regenerate with
  `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- The fixture catalog must stay cycle-free and dangling-free: `validate` (A23) will be run against
  it, and every golden profile resolves it. `test/resolve.test.ts` writes its chain/diamond/cycle
  shapes into the per-test copy via a local `writeSkill` helper — do the same rather than adding
  them to `scripts/fixture-catalog.ts`.
- The text output of `resolve` and `catalog` is asserted with exact column padding, built by
  `src/output.ts`. Adding an artifact to a fixture profile shifts those assertions.
- Whole-object `toEqual` assertions on `ProjectConfig` in `test/config.test.ts` must be updated
  whenever the config type gains a field.
