# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A12 — `resolve --explain` and `ambit why`** (the tip of `main`).

## Constraints later tasks inherit

- **`Bundle` gained `reasons: SelectionReasons`** — `{ skills, mcps }`, each a `Map<name,
  SelectionReason>` with one entry per selected item. Computed inside `resolveBundle`, not on
  request, so `--explain`, `ambit why`, and **A14's lock `reason:` field (spec §3.5)** all read the
  same answer: `formatReason(reasonOf(bundle, { kind, name }))` gives the string the lock wants.
  Precedence is **explicit > scope > required-by**, and a `scope` reason carries both the declared
  scope and the held scope that reached it (they differ under the subtree rule).
  `required-by` names the **first selected skill by name** that requires the item, recovered from
  the closure's result rather than its walk order.
- **Whole-object `toEqual` on a `Bundle` must now include `reasons`** — `test/resolve.test.ts`'s
  empty-bundle assertion is the only one, and it spells out two empty `Map`s.
- **The resolve/install pipeline is three steps, and every call site must run all three**
  (`src/install.ts`, `src/handlers/resolve.ts`, `src/handlers/why.ts`):
  `mergeCatalogs(await loadCatalogs(...))` → `await mergeConfigEntities(catalogs, config, projectDir)`
  → `resolveBundle(config, merged)`. `mergeConfigEntities` folds the project's own declarations —
  `skills` entries carrying a `source`, and inline `mcps` — into the merged namespace, so
  `resolveBundle` looks *every* name up in one place and `requires` can reach an inline server.
  Call `resolveBundle` on a bare `mergeCatalogs` result and an inline MCP silently drops out.
  `ambit catalog` deliberately does *not* fold them in; its golden JSON stays catalog-only.
- **`MergedSkill.catalog` is "where it came from", not always a catalog name.** A source-form skill
  carries its `source` as written (`path:../extra`) and its within-source `path`; an inline MCP
  carries the config filename (`ambit.yml`). Both are machine-independent, so `resolve --json` stays
  golden-able. **A15's shadowing report and A14's lock must decide what these look like** — the
  lock's `skills.<name>.catalog` has no real catalog to name for a source skill.
- **`--explain` does not yet report shadowing.** Spec §6's fourth reason form,
  `catalog:company (shadows personal)`, is **A15's**: it needs `mergeCatalogs` to record the
  shadowing first. Adding it means a fourth `SelectionReason` variant, and `formatReason` is a
  `switch` with no default, so TS will point at every place that must handle it.
- **`ProjectConfig.origin` carries `scopeLines`, `skillLines`, `mcpLines`** (name → 1-based line).
  Whole-object assertions on `ProjectConfig`/`ConfigOrigin` live in `test/config.test.ts` and
  `test/resolve.test.ts`'s `held()` helper — both must be updated whenever the type gains a field.
- **Duplicate names inside one config list are exit 2 at parse time**, via `nameTracker` in
  `src/config.ts` (`catalog name`, `skills entry`, `mcps entry`). Later lists should use it too.
- **A config declaration colliding with a catalog is exit 3, not an override** — a source-form skill
  or inline MCP whose name a catalog already provides. Rationale: spec §3.1 calls both surfaces
  "not defined in any catalog", so a collision is a mistake and ambit will not guess which side.
  **A15's shadowing work should not quietly turn this into precedence.** `ambit why`'s
  "not in the bundle" error relies on it: anything the config declares is always selected, so the
  unselected item it names is always from a real catalog.
- `resolveCatalogRoot` takes the config filename as its third argument and shares
  `resolveSourceRoot` with skill sources; `loadSourceSkill` reads exactly one `SKILL.md` from a
  directory that need not be a catalog (no `scopes.yml` expected), with `path` overriding the
  name→path convention and allowed to point outside `skills/`. Non-`path:` sources fail the same way
  catalogs do until **A13**.
- **`closeOverRequires(skills, mcps, merged)`** is still the only place `requires` is walked; cycle
  detection **throws on the first cycle**. **A23 still needs a multi-problem variant**, as it does
  for unknown scopes, dangling `requires`, and unknown explicit names.
- `resolve` hard-validates the **closure only** (spec §4 validation split): a skill nothing selects
  may carry a dangling `requires` and resolution still exits 0. A23 is what rejects it catalog-wide.
- **`at(file, line)` lives in `src/errors.ts`** (degrades to `(file)`). Errors about a file inside a
  catalog or a skill source cite the source-relative path (`skills/…/SKILL.md`) and get a prepended
  `in catalog "x" (root)` / `in skill source "path:../extra" (root)` line from `inSource`.
- **`assertScopesRegistered`** runs first inside `resolveBundle`, before the explicit-entry check.
  Suggestion policy: exact Levenshtein, threshold `max(2, floor(len/3))`, ties broken by the
  registry's sorted order. **Explicit skill names and `ambit why` arguments get no suggestion** —
  `nearestScope` is private and takes `ScopeDefinition[]`; A23 can generalize it if wanted.
- **`MergedSkill.catalogRoot` (absolute) must stay out of every output surface.**
- **`.mcp.json` is co-owned, so ambit owns keys and not the file.** `src/harness-config.ts` replaces
  only `mcpServers.<name>` and writes everything else back in place. **A17's ownership check must be
  per-key for `harness-config`**, and **A18's pruning removes managed keys, not the file.** A bundle
  with no MCPs plans no artifact at all, so A18 must work from `prior` state.
- `${VAR}` in http `headers` is interpolated at install (spec §5); an unset variable leaves its
  placeholder rather than emptying the value, and **A24's `doctor` is what reports it**.
- Server shape written for the harness: stdio → `command` (+ `args` when non-empty, no `type`);
  http → `type: "http"`, `url`, `headers` (sorted, omitted when empty). The entity's `env` list is a
  declaration for `doctor` and is deliberately **not** written into `.mcp.json`.
- **`ProjectPaths` carries `env`**, passed once by `installProject` from `process.env`, so
  `claudeAdapter.plan` stays pure. Every `plan` call site must supply it.

## Deliberate omissions, and who owns them

- `apply` removes a target only when `prior` state already owns it; nothing prunes `.mcp.json` keys.
  Refusing unowned targets and `--adopt` are **A17**; pruning is **A18**.
- No `.gitignore` handling at all — **A21**. `.mcp.json` is committed, so only `.ambit/` and copied
  skills belong in that block.
- Unimplemented flags throw exit 1 "not implemented yet" from an `UNIMPLEMENTED` map in
  `src/handlers/install.ts` (`--dry-run`, `--frozen`, `--adopt`, `--copy`, `--link`). **When your
  task implements one, delete its entry from that map — and `test/install.test.ts` has a loop
  asserting all five, so remove the matching case too.** `resolve --explain` was the sixth such
  placeholder and is now real.

## Traps

- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. **Plain `--json` carries no `reason` key** — A12 added it only under
  `--explain`, so the goldens were untouched; one selection change touches several at once, so
  regenerate with `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- `writeProfile` in `test/resolve.test.ts` takes `(scopes, extra?)` and in `test/install.test.ts`
  `(scopes, harnesses?, extra?)`; `extra` lines are appended **after** the scopes list so the
  `FIRST_SCOPE_LINE = 6` / `FIRST_EXTRA_LINE = 6` line math in the error assertions holds.
- `test/install.test.ts`'s default profile is `[core, function.engineering]`, which selects the
  `scoped` http server — so it writes `.mcp.json` too. Its state, `--json`, and padded-text
  assertions all list four artifacts; adding a fifth shifts the column widths.
- That file stubs `SCOPED_API_KEY` to `undefined` in `beforeEach` (`vi.stubEnv`) because the fixture
  interpolates it into a header. Any new test that installs and asserts file contents needs the same
  discipline.
- The fixture catalog must stay cycle-free and dangling-free: `validate` (A23) will be run against
  it, and every golden profile resolves it. Tests that need extra catalog shapes write them into the
  per-test copy (`writeSkill`/`writeSourceSkill`/`writeMcp` in `test/resolve.test.ts`,
  `writeCatalogFile` in `test/install.test.ts`) rather than into `scripts/fixture-catalog.ts`.
- The text output of `resolve`, `catalog`, `install`, and `why` is asserted with exact column
  padding, built by `src/output.ts`. `--explain` adds a **third** cell to the skills and mcps rows,
  which repads those sections; `why`'s chain pads the name column across skills and MCPs together.
- `ambit why` reads a bare name as a skill first and an `mcp.`-prefixed one as a server — the same
  disambiguation `requires` uses. `MCP_REQUIREMENT_PREFIX` is exported from `src/resolve.ts` for it.
