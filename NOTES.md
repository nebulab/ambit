# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A14 — `ambit.lock`** (the tip of `main`). Next task is **A15 — multi-catalog merge
and shadowing**, whose `Depends: A14` is now checked.

## Constraints later tasks inherit

- **`install` now writes `ambit.lock`, and the lock is *not* an owned artifact.** It is absent from
  `.ambit/state.json`, from install's output, and from every `PlannedArtifact` — a record of the
  resolution, not something ambit materialized. So **A18's pruning must not touch it**, **A21's
  gitignore block must not list it** (spec §3.5: teams commit it), and **A22's `clean` has to decide
  deliberately** whether "leaves the project identical to before the first install" reaches a file
  ambit does not own. Nothing else reads it: `--frozen` compares *bytes*, so there is no lock parser
  and A19's `status` should not add one without a reason.
- **`src/lock.ts` owns the whole lock.** `buildLock(loaded, bundle)` is pure and takes the
  **unmerged** `readonly Catalog[]` (every configured catalog, contributing or not), `serializeLock`
  renders it, `assertLockCurrent` is `--frozen`. `installProject(projectDir, { frozen })` serializes
  once and compares **before** anything is applied, so a stale-lock CI run leaves the project
  untouched; the write happens after `apply`, beside `writeState`, for the §5.4 reason.
- **`emitYaml` in `src/yaml.ts` is the only sanctioned way to write YAML** (spec §3.0): sorted keys at
  every depth, double quotes when quoting is needed, no anchors/aliases, no wrapping and no block
  scalars, core schema 1.2 to match the parser. **A25's `init` scaffold and B02's editor emit through
  it** — except that B02 must *preserve* formatting, so it cannot use `emitYaml` on a hand-written
  file, only on shapes ambit owns.
- **Top-level lock keys are sorted, so the file reads `catalogs, mcps, skills, version`** — not §3.5's
  illustrative order. Same call `state.ts` already made; §3.0's sorted-keys rule is the normative one.
  Empty sections stay as `mcps: {}` rather than vanishing, so a diff shows the change.
- **A source-declared skill's lock `catalog:` is its `source` as written** (`path:../extra`, a git
  URL), and an inline MCP's is the config filename. Decided deliberately: `resolve --json` already
  reports `MergedSkill.catalog` that way, and `handlers/resolve.ts` documents itself as the shape the
  lock serializes, so a second key (`source:`) would make the two surfaces disagree about the same
  fact. **A15's shadowing report should keep that consistency.**
- **`MergedSkill` gained `commit?`** — a catalog skill inherits its catalog's, a `source` skill carries
  its own (`loadSourceSkill` no longer discards the `ResolvedSource`). Absent for `path:`. Not in
  `resolve --json` or `catalog --json`, both of which build records from explicit key lists, so the
  goldens are untouched; **anything that starts spreading a `MergedSkill` into output must exclude
  `catalogRoot` and think about `commit`.**
- **`Catalog` gained `ref?`**, attached by `loadCatalogs` after `parseCatalogDirectory` returns —
  it is a fact about the config entry, not the directory, so a catalog parsed straight off disk
  (A23's `validate --catalog`) has none. A `path:` catalog with a pointless `ref` still records it.
- **`--frozen` is implemented; `--dry-run`, `--adopt`, `--copy`, `--link` remain in the
  `UNIMPLEMENTED` map in `src/handlers/install.ts`.** `test/install.test.ts` loops over those four —
  delete the entry *and* the loop case together when you implement one.
- **Every source resolves through `src/sources.ts`** (§3.1 grammar; `owner/repo[@ref]`, any URL,
  scp-like remotes, `git:<url>`, `path:./dir`) returning `ResolvedSource = { root, commit? }`.
  `loadCatalogs`, `mergeConfigEntities`, `loadSourceSkill`, and `resolveCatalogRoot` take a
  `SourceContext` (`{ projectDir, env }`); `env` is where the cache location comes from, read once at
  the boundary (`sourceContextOf(ctx)`, or `process.env` in `installProject`).
- **The cache is refreshed only when it cannot resolve the ref** (`src/git.ts`), so `ref: main` pins to
  the commit first seen and a cache hit touches nothing. **A16's `--offline` is therefore mostly about
  the miss path.** A refresh needs a new flag, not a change here: two runs a minute apart must agree.
- **Clones are `--mirror`** (a bare clone gets no `remote.origin.fetch`); checkouts are
  `git worktree add --detach` into `sources/<key>/<commit>` with a `<commit>.ready` sentinel written
  last. Cache layout `<cache>/repos/<host>/<path…>.git` and `<cache>/sources/<host>/<path…>/<commit>/`,
  key from `gitCacheKey()`. **A20's symlink mode must not point into a path `worktree prune` could
  invalidate, and A22's `clean` must not touch the cache.**
- Exit codes for sources: **2** for an unrecognized/empty source, a missing `path:` directory, or an
  unusable/unknown ref; **4** for git missing from PATH or a failed clone/fetch/checkout.
- **`Bundle` carries `reasons: SelectionReasons`**, one entry per selected item.
  `formatReason(reasonOf(bundle, { kind, name }))` is the string `--explain`, `ambit why`, and the
  lock's `reason:` all use. Precedence **explicit > scope > required-by**. A whole-object `toEqual` on
  a `Bundle` must include `reasons` (`test/resolve.test.ts`'s empty-bundle assertion is the only one).
- **The resolve pipeline is three steps and every call site must run all three**
  (`src/install.ts`, `src/handlers/{resolve,why}.ts`): `mergeCatalogs(await loadCatalogs(...))` →
  `await mergeConfigEntities(...)` → `resolveBundle(...)`. Skip the middle one and inline MCPs and
  source skills silently drop out. `ambit catalog` deliberately skips it; its golden JSON is
  catalog-only.
- **`--explain` does not yet report shadowing.** Spec §6's fourth form,
  `catalog:company (shadows personal)`, is **A15's**: `mergeCatalogs` must record the shadowing first.
  It means a fourth `SelectionReason` variant, and `formatReason` is a `switch` with no default, so TS
  will point at every place that must handle it — the lock's `reason:` included.
- **A config declaration colliding with a catalog is exit 3, not an override** (spec §3.1 calls both
  surfaces "not defined in any catalog"). **A15 should not quietly turn this into precedence**;
  `ambit why`'s "not in the bundle" error relies on it.
- **`ProjectConfig.origin` carries `scopeLines`, `skillLines`, `mcpLines`** (name → 1-based line).
  Whole-object assertions live in `test/config.test.ts` and `test/resolve.test.ts`'s `held()` helper.
  Catalog entries have no line of their own, so their errors say `(ambit.yml)` alone.
- **Duplicate names inside one config list are exit 2 at parse time**, via `nameTracker` in
  `src/config.ts`. Later lists should use it too.
- **`closeOverRequires` throws on the first cycle**, and `resolve` hard-validates the **closure only**
  (spec §4 validation split) — a skill nothing selects may carry a dangling `requires`. **A23 needs a
  multi-problem variant** of this, of unknown scopes, and of unknown explicit names.
- **`at(file, line)` lives in `src/errors.ts`.** Errors inside a catalog or skill source cite the
  source-relative path and get a prepended `in catalog "x" (root)` line from `inSource` — for a git
  source that root is the cache checkout, machine-specific, so it must stay out of golden output.
- **`assertScopesRegistered`** runs first inside `resolveBundle`. Suggestions: exact Levenshtein,
  threshold `max(2, floor(len/3))`, ties by the registry's sorted order. **Explicit skill names and
  `ambit why` arguments get no suggestion.**
- **`.mcp.json` is co-owned, so ambit owns keys and not the file.** `src/harness-config.ts` replaces
  only `mcpServers.<name>`. **A17's ownership check must be per-key for `harness-config`**, and
  **A18's pruning removes managed keys, not the file** — and must work from `prior` state, since a
  bundle with no MCPs plans no artifact at all.
- `${VAR}` in http `headers` is interpolated at install (spec §5); an unset variable leaves its
  placeholder rather than emptying the value, and **A24's `doctor` reports it**. The entity's `env`
  list is deliberately not written into `.mcp.json`.
- **`ProjectPaths` carries `env`**, supplied by `installProject`, so `claudeAdapter.plan` stays pure.

## Deliberate omissions, and who owns them

- `apply` removes a target only when `prior` state already owns it; nothing prunes `.mcp.json` keys.
  Refusing unowned targets and `--adopt` are **A17**; pruning is **A18**.
- Nothing prunes the cache, and nothing locks it against a concurrent ambit (`loadCatalogs` is
  sequential for that reason). No task owns cache GC; raise it if it matters.
- No `.gitignore` handling at all — **A21**. `.mcp.json` and `ambit.lock` are committed, so only
  `.ambit/` and copied skills belong in that block.

## Traps

- **Nothing may reach the network (spec §7).** Git tests use `buildFixtureGitCatalog`'s local bare
  repo, whose commit SHA is fixed by pinned dates and `GIT_CONFIG_GLOBAL=/dev/null`. A test needing a
  *rejected* source must pick one no fetch can be attempted for — a bare relative path like
  `../catalog` is unrecognized (`path:` is the prefix), whereas `acme/skills` resolves to a GitHub URL.
- `test/git-source.test.ts`'s `installed()` skips **`PER_SOURCE_FILES` = `ambit.yml` + `ambit.lock`**:
  the git and path projects must install byte-identically *except* for the two files that record where
  the catalog came from. Anything that adds a third per-source file belongs in that set, with a reason.
- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. **Plain `--json` carries no `reason` key** — that exists only under
  `--explain`. One selection change touches several goldens, so regenerate with
  `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- `test/lock.test.ts` asserts the **exact bytes** of the lock for two profiles. A new field, a
  changed reason string, or a different key order rewrites those two blocks — which is the point, but
  read the diff rather than pasting the new output.
- `writeProfile` differs per file: `(scopes, extra?)` in `test/resolve.test.ts` and
  `test/lock.test.ts`, `(scopes, harnesses?, extra?)` in `test/install.test.ts`; `extra` lines always
  land **after** the scopes list so the `FIRST_SCOPE_LINE`/`FIRST_EXTRA_LINE` line math holds.
  `test/git-source.test.ts` has its own `writeProject(dir, source, ref?, extra?)`.
- `test/install.test.ts`'s default profile is `[core, function.engineering]`, which selects the
  `scoped` http server — so it writes `.mcp.json` too. Its state, `--json`, and padded-text
  assertions list four artifacts; adding a fifth shifts the column widths.
- That file and `test/git-source.test.ts` stub `SCOPED_API_KEY` to `undefined` in `beforeEach`
  because the fixture interpolates it into a header. Any new test that installs and asserts file
  contents needs the same discipline (`test/lock.test.ts` does not: no lock field reads the
  environment).
- The fixture catalog must stay cycle-free and dangling-free: `validate` (A23) will run against it and
  every golden profile resolves it. Tests needing extra catalog shapes write them into the per-test
  copy (`writeSkill`/`writeSourceSkill`/`writeMcp` in `test/resolve.test.ts`, `writeCatalogFile` in
  `test/install.test.ts`) rather than into `scripts/fixture-catalog.ts`.
- The text output of `resolve`, `catalog`, `install`, and `why` is asserted with exact column padding
  from `src/output.ts`. `--explain` adds a **third** cell to the skills and mcps rows, repadding them;
  `why`'s chain pads the name column across skills and MCPs together.
- `ambit why` reads a bare name as a skill and an `mcp.`-prefixed one as a server — the same
  disambiguation `requires` uses. `MCP_REQUIREMENT_PREFIX` is exported from `src/resolve.ts` for it.
