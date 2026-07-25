# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A20 — symlink local sources** (the tip of `main`). Next task is **A21 — managed
gitignore block**, whose `Depends: A20` is now checked.

## Constraints later tasks inherit

- **A skill's materialization mode is derived from `MergedSkill.commit`** (`modeOf` in
  `src/adapters/claude.ts`): absent means a `path:` source, which is a working tree someone edits, so
  it is **linked**; present means a pinned commit, so it is **copied** (spec §5). That is the only
  signal, and it is exact — `commit` is absent for `path:` and set for every git source. The override
  rides on **`ProjectPaths.mode` / `InstallOptions.mode`** (`--copy`/`--link`), absent meaning "follow
  each source"; a new construction site of `ProjectPaths` therefore decides the mode by omission, so
  set it deliberately.
- **The fixture catalog is a `path:` source, so the default install of it is now symlinks.** Every
  install test's state, text, and `--json` assertions read `mode: link`; the tests that are about a
  directory of ambit's own bytes pass `--copy` (see Traps).
- **Links are relative** (`linkSkillDir`), resolved against the link's own directory, so a project and
  its catalog move together and no absolute machine path lands in the working tree. `--link` against a
  remote source deliberately links into the shared cache checkout: it is an explicit request, and
  nothing else in ambit points into the cache.
- **`status` compares a skill by the shape on disk, not by the plan's `mode`** (`skillVerdict`,
  `linkVerdict` in `src/status.ts`). A link is checked for pointing at its source; a directory is
  compared byte for byte. So a project installed with `--copy` whose copies are intact reads **clean**
  even though a plain `install` would relink it. Deliberate, and the reverse of what A19's notes
  guessed: mode is a per-run choice, both modes put identical bytes in front of the harness, and
  treating divergence as drift would leave anyone who uses the flag with a `status --check` that can
  never pass. **Reporting mode divergence is A24's `doctor`** — "this is not how it would be set up
  today" is that command's question. Worth a second opinion.
- **Editing a linked skill edits the catalog, and that is never drift.** `status.ts`'s comparison and
  `test/status.test.ts`'s link block both say so; content drift is only a question about a copy.
- **`--copy`/`--link` mutual exclusion is enforced in `installHandler`, not by Commander's
  `.conflicts()`.** Reason, and a **pre-existing bug worth a task**: a subcommand added with
  `addCommand` inherits neither `exitOverride` nor `configureOutput`, so *any* Commander-level usage
  error in a subcommand (a bad `--flag`, a missing argument) writes to the real stderr and calls
  `process.exit` instead of travelling out of `run()` as an exit code. `program.addCommand` calling
  `copyInheritedSettings` would fix it for every command at once. No task owns it.
- **`--dry-run` is the only entry left in the `UNIMPLEMENTED` map in `src/handlers/install.ts`**, with
  one matching test in `test/install.test.ts`. A22 owns it — delete the entry and the test together.
- **`src/status.ts`'s `projectStatus(projectDir, { offline })` plans through the adapters exactly as
  `installProject` does** — that is why `adaptersFor` is exported from `src/install.ts` — and then
  compares, writing nothing. Every row is one artifact and one `ArtifactState`
  (`missing | modified | ok | stale | unowned`), so the whole report answers one question: would
  `ambit install` change this? **Drift is never an error**: `statusHandler` prints the same table and
  *returns* `ExitCode.Drift` under `--check`, which is what `buildCommand`'s `onExit` exists for.
  **A24's `doctor` should build on `projectStatus`** and add what status deliberately leaves out: lock
  drift (status never reads `ambit.lock`), env vars, and mode divergence.
- **A copied skill's contents are compared against its `source`, so status reports upstream change,
  not only local edits** (`test/status.test.ts` pins that by rewriting the catalog, under `--copy`).
  One difference is reported, the first in sorted order, and a file that cannot be read counts as
  differing.
- **`.mcp.json` is compared key by key and the first problem in plan order wins the row** — the same
  choice ownership makes about which conflict to refuse. Key order inside a server is *not* a
  difference (`jsonEqual`): ambit owns the key, not the file's layout. Foreign keys are invisible.
- **New helpers exist so status cannot drift from install:** `sectionOf` (`src/harness-config.ts`,
  `sectionKeys` is now defined on it) and `ownedKeys` (`src/ownership.ts`, exported). Use them rather
  than re-deriving "what does ambit own in this file".
- **A new artifact kind means a new branch in `compareArtifacts`.** It switches on `skill-dir` vs
  `harness-config` and nothing else, so **A21's gitignore block** — if it becomes an owned artifact —
  needs a comparison of its own or it will fall through as a config file.
- **`removeConfigKeys` (in `src/harness-config.ts`) returns `undefined` when the document held none of
  the keys**, and pruning skips the write entirely in that case. That is what keeps a run with nothing
  to prune byte-identical and what stops pruning from recreating a `.mcp.json` someone deleted by
  hand. `test/install.test.ts`'s `describe("idempotence")` is what pins the whole claim now.
- **`src/prune.ts`'s `pruneArtifacts(projectDir, plan, prior)` answers only from `.ambit/state.json`.**
  It never walks `.claude/skills` looking for strangers, which is what makes "leaves unowned files
  alone" true by construction. Called once from `installProject` with **every adapter's plan flattened
  together** (same reason `authorizePlan` is), **after the last `apply` and before the lock and state
  writes**: a prune that throws is retryable because state still owns what it was about to remove, and
  a failed `apply` leaves the previous install standing instead of half-dismantled. `InstallResult`
  carries `pruned: readonly PrunedArtifact[]`, sorted by path. **It needs no mode branch**:
  `rm(..., { recursive: true, force: true })` unlinks a symlink without following it, so a pruned link
  never reaches the catalog behind it (pinned by a test).
- **Pruning removes managed keys, never the config file.** A bundle with no MCPs plans no `.mcp.json`
  artifact at all, so the stale keys can only come from prior state — and what is left behind is
  `{"mcpServers": {}}` plus every foreign key, because ambit owns keys in that file and not the
  document (spec §3.6). **Nor does it remove the directories that held pruned skills**: an empty
  `.claude/skills` survives, since `.claude/` is the harness's. **A22's `clean` has to decide
  deliberately** whether "leaves the project identical to before the first install" reaches the empty
  section and those directories.
- **A state entry's `managedKeys` are split at the *first* dot** (`mcpServers.acme.internal` is one
  server named `acme.internal`), and a key naming no section at all is exit 2 `cannot prune "<key>"
  from <file>` rather than a silently un-prunable artifact.
- **Install's output says nothing about pruning** — `status` and A22's `--dry-run` are the reporting
  surfaces. **`--dry-run` needs a plan-only form of pruning**, because `pruneConfigKeys` re-reads the
  config file after `apply` has merged this run's keys into it.
- **The standalone `ambit prune` command is still declared-but-unimplemented, and A22 owns it**
  alongside `clean` and `--dry-run`; the handler would be a thin caller of `pruneArtifacts` over a
  fresh plan.
- **`src/ownership.ts`'s `authorizePlan(plan, prior, { adopt })` is the safety core**, called once from
  `installProject` before any adapter applies. It returns the `State` `apply` must act with: `prior`,
  plus an owned entry per target `--adopt` just took over. **That is the whole of `--adopt` for skill
  dirs** — an adopted path looks owned, so `applySkillDir` replaces it rather than copying on top of
  it. Its `exists` check is `lstat`, so a symlink — including a dangling one, and including one ambit
  itself would have written — counts as something ambit did not create unless state says otherwise.
  Pruning is handed `prior` rather than that state, since anything just adopted is in the plan anyway.
- **`applySkillDir` removes an owned target before writing it**, which is also what makes a mode change
  between runs work: a copy becomes a link and a link becomes a copy rather than one landing on top of
  the other. An *unowned* target is still merged into in copy mode (a case install never reaches;
  deliberate, so `apply` called directly cannot destroy a stranger's directory) — link mode has no
  merge, so there it is exit 2 `cannot symlink <path>`.
- **Ownership granularity follows the artifact kind.** `skill-dir` is owned as a path; `harness-config`
  is checked **per key** (`sectionKeys` in `src/harness-config.ts` × prior `managedKeys`), so a
  `.mcp.json` full of hand-added servers is a normal input and only a colliding server *name* is a
  conflict.
- **Refusal is on the first conflict, in plan order** (skills sorted, then the config file), not a
  list of every conflict — `--adopt` clears all of them at once, and multi-problem reporting is
  A23's. The two messages are exit 2 and read
  `refusing to overwrite unowned path` / `unowned key`; the path one is byte-for-byte spec §6's
  example, so **do not reword it without changing the spec**.
- **A crash mid-`apply` still costs a `--adopt`.** State is written last (§5 rule 4), so artifacts from
  a failed run are present-but-unowned and the next plain `install` refuses them — `status` now
  reports them as `unowned` before that happens. **A24's `doctor` is what should explain it**.
- **Shadowing is *not* a `SelectionReason`.** `MergedCatalog` carries
  `shadowing: { skills, mcps }` — name-keyed maps of `Shadowing = { name, catalog, shadows[] }`,
  `shadows` in config order — and `formatShadowing` renders spec §6's
  `catalog:company (shadows personal)`. Deliberately *beside* the reason, not one of its variants:
  the two answer different questions, every item has a reason while at most a few are shadowed, and
  folding them would cost a shadowed item its reason in `--explain` **and** in `ambit why`'s chain.
  So `formatReason` is still an exhaustive three-arm `switch` and **`ambit.lock`'s `reason:` is
  untouched**. Reverse this only with a reason, and expect the byte-exact lock tests to move.
- **`--explain` is the only surface that reports shadowing so far.** Text gets a **fourth** cell
  (empty where nothing is shadowed, so the reason column pads uniformly), `--json` gets
  `shadows: [catalog…]`. **`ambit why` and `catalog dump` deliberately do not report it** (spec §4.5
  names `--explain` and `validate`), so **A23's `validate` is the other half** and `catalog --json`'s
  golden assertion stayed untouched.
- **A config `skills`/`mcps` declaration colliding with a catalog is still exit 3, not precedence**
  (spec §3.1 calls both surfaces "not defined in any catalog"); catalog-vs-catalog is the only place
  first-wins applies. `mergeCatalogs`'s doc says so; `ambit why`'s "not in the bundle" error relies
  on it.
- **`mergeCatalogs` throws** (exit 3) when two catalogs describe one scope differently; identical
  descriptions merge silently. It is the first non-total function in the merge path — anything that
  calls it on catalogs it did not validate should expect an `AmbitError`.
- **`install` writes `ambit.lock`, and the lock is *not* an owned artifact.** It is absent from
  `.ambit/state.json`, from install's output, from `status`, and from every `PlannedArtifact` — a
  record of the resolution, not something ambit materialized. So **pruning cannot see it** (it works
  from state), **A21's gitignore block must not list it** (spec §3.5: teams commit it), and **A22's
  `clean` has to decide deliberately** whether "leaves the project identical to before the first
  install" reaches a file ambit does not own. Nothing parses it: `--frozen` compares *bytes*.
- **`src/lock.ts` owns the whole lock.** `buildLock(loaded, bundle)` is pure and takes the
  **unmerged** `readonly Catalog[]` (every configured catalog, contributing or not), `serializeLock`
  renders it, `assertLockCurrent` is `--frozen`. `installProject(projectDir, { frozen })` serializes
  once and compares **before** anything is applied, so a stale-lock CI run leaves the project
  untouched; the write happens after `apply` and after pruning, beside `writeState`, for the §5.4 reason.
  **The lock records no mode**, so `--copy` and `--link` cannot make a lock differ.
- **`emitYaml` in `src/yaml.ts` is the only sanctioned way to write YAML** (spec §3.0): sorted keys at
  every depth, double quotes when quoting is needed, no anchors/aliases, no wrapping and no block
  scalars, core schema 1.2 to match the parser. **A25's `init` scaffold and B02's editor emit through
  it** — except that B02 must *preserve* formatting, so it cannot use `emitYaml` on a hand-written
  file, only on shapes ambit owns.
- **Top-level lock keys are sorted, so the file reads `catalogs, mcps, skills, version`** — not §3.5's
  illustrative order. Same call `state.ts` already made; §3.0's sorted-keys rule is the normative one.
  Empty sections stay as `mcps: {}` rather than vanishing, so a diff shows the change.
- **A source-declared skill's lock `catalog:` is its `source` as written** (`path:../extra`, a git
  URL), and an inline MCP's is the config filename — the same column `resolve --json` reports, so the
  two surfaces cannot disagree about the same fact.
- **`MergedSkill` carries `commit?`** — a catalog skill inherits its catalog's, a `source` skill carries
  its own. Absent for `path:`, which is now also what decides the install mode. Not in `resolve --json`
  or `catalog --json`, both of which build records from explicit key lists, so the goldens are
  untouched; **anything that starts spreading a `MergedSkill` into output must exclude `catalogRoot`
  and think about `commit`.**
- **`Catalog` carries `ref?`**, attached by `loadCatalogs` after `parseCatalogDirectory` returns —
  it is a fact about the config entry, not the directory, so a catalog parsed straight off disk
  (A23's `validate --catalog`) has none. A `path:` catalog with a pointless `ref` still records it.
- **`--frozen`, `--adopt`, `--copy`, `--link` and `status --check` are implemented.**
- **Every source resolves through `src/sources.ts`** (§3.1 grammar; `owner/repo[@ref]`, any URL,
  scp-like remotes, `git:<url>`, `path:./dir`) returning `ResolvedSource = { root, commit? }`.
  `loadCatalogs`, `mergeConfigEntities`, `loadSourceSkill`, and `resolveCatalogRoot` take a
  `SourceContext` (`{ projectDir, env }`); `env` is where the cache location comes from, read once at
  the boundary (`sourceContextOf(ctx)`, or `process.env` in `installProject` and `projectStatus`).
- **The cache is refreshed only when it cannot resolve the ref** (`src/git.ts`), so `ref: main` pins to
  the commit first seen and a cache hit touches nothing. A refresh needs a new flag, not a change here:
  two runs a minute apart must agree.
- **`--offline` rides on `SourceContext.offline?: boolean`**, set in exactly three places —
  `sourceContextOf(ctx)` (so `resolve`, `catalog`, `why` get it for free), `installProject`, and
  `projectStatus`. It is optional, so **absent means fetching is allowed**: a fourth construction site
  that forgets it would silently reach the network. Add one only with a reason, and set the flag there.
- **Offline refuses the clone and the fetch, nothing else** (`notCached` / `refNotCached` in
  `src/git.ts`, both exit 4). A `git worktree add` from a clone ambit already has is still an offline
  answer, and `path:` sources never consult the cache at all — so **A22's `clean` needs no offline
  branch.** Offline also turns an unresolvable ref into exit **4** where the fetching path calls it
  exit 2 (`unknownRef`): only a fetch could tell "the repo lacks it" from "the clone was never told".
- **Clones are `--mirror`** (a bare clone gets no `remote.origin.fetch`); checkouts are
  `git worktree add --detach` into `sources/<key>/<commit>` with a `<commit>.ready` sentinel written
  last. Cache layout `<cache>/repos/<host>/<path…>.git` and `<cache>/sources/<host>/<path…>/<commit>/`,
  key from `gitCacheKey()`. **A22's `clean` must not touch the cache.**
- Exit codes for sources: **2** for an unrecognized/empty source, a missing `path:` directory, or an
  unusable/unknown ref; **4** for git missing from PATH or a failed clone/fetch/checkout.
- **`Bundle` carries `reasons: SelectionReasons`**, one entry per selected item.
  `formatReason(reasonOf(bundle, { kind, name }))` is the string `--explain`, `ambit why`, and the
  lock's `reason:` all use. Precedence **explicit > scope > required-by**. A whole-object `toEqual` on
  a `Bundle` must include `reasons` (`test/resolve.test.ts`'s empty-bundle assertion is the only one).
- **The resolve pipeline is three steps and every call site must run all three**
  (`src/install.ts`, `src/status.ts`, `src/handlers/{resolve,why}.ts`):
  `mergeCatalogs(await loadCatalogs(...))` → `await mergeConfigEntities(...)` → `resolveBundle(...)`.
  Skip the middle one and inline MCPs and source skills silently drop out; it also carries `shadowing`
  through untouched. `ambit catalog` deliberately skips it; its golden JSON is catalog-only.
- **`ProjectConfig.origin` carries `scopeLines`, `skillLines`, `mcpLines`** (name → 1-based line).
  Whole-object assertions live in `test/config.test.ts` and `test/resolve.test.ts`'s `held()` helper.
  Catalog entries have no line of their own, so their errors say `(ambit.yml)` alone.
- **Duplicate names inside one config list are exit 2 at parse time**, via `nameTracker` in
  `src/config.ts`. Later lists should use it too.
- **`closeOverRequires` throws on the first cycle**, and `resolve` hard-validates the **closure only**
  (spec §4 validation split) — a skill nothing selects may carry a dangling `requires`. **A23 needs a
  multi-problem variant** of this, of unknown scopes, of unknown explicit names, and now of shadowing.
- **`at(file, line)` lives in `src/errors.ts`.** Errors inside a catalog or skill source cite the
  source-relative path and get a prepended `in catalog "x" (root)` line from `inSource` — for a git
  source that root is the cache checkout, machine-specific, so it must stay out of golden output.
  The scope-description conflict is the exception that names no root: it is about two catalogs, so it
  cites `scopes.yml` and names both catalogs in its detail lines.
- **`assertScopesRegistered`** runs first inside `resolveBundle`. Suggestions: exact Levenshtein,
  threshold `max(2, floor(len/3))`, ties by the registry's sorted order. **Explicit skill names and
  `ambit why` arguments get no suggestion.**
- `${VAR}` in http `headers` is interpolated at install (spec §5); an unset variable leaves its
  placeholder rather than emptying the value, and **A24's `doctor` reports it**. `status` interpolates
  from the same `process.env`, so a variable that changed between two runs *is* drift. The entity's
  `env` list is deliberately not written into `.mcp.json`.
- **`ProjectPaths` carries `env` and `mode?`**, both supplied by `installProject` (and `env` by
  `projectStatus`), so `claudeAdapter.plan` stays pure.

## Deliberate omissions, and who owns them

- Nothing prunes the cache, and nothing locks it against a concurrent ambit (`loadCatalogs` is
  sequential for that reason). No task owns cache GC; raise it if it matters.
- No `.gitignore` handling at all — **A21**. `.mcp.json` and `ambit.lock` are committed, so only
  `.ambit/` and installed skills belong in that block — **including linked ones**, which are still
  files git would otherwise track.
- **Nothing persists a materialization mode.** `--copy`/`--link` are per-run (spec §5) and there is no
  config key for them, so a team that wants copies everywhere has to pass the flag every time. If that
  ever needs fixing it is a config change and a spec change, not an adapter change.
- Shadowing is recorded for every colliding name but reported only under `--explain`; `validate`
  listing all of them is **A23**.
- `status` reports artifacts only: no lock drift, no env vars, no harness list, no mode divergence —
  **A24's `doctor`**.

## Traps

- **Nothing may reach the network (spec §7).** Git tests use `buildFixtureGitCatalog`'s local bare
  repo, whose commit SHA is fixed by pinned dates and `GIT_CONFIG_GLOBAL=/dev/null`. A test needing a
  *rejected* source must pick one no fetch can be attempted for — a bare relative path like
  `../catalog` is unrecognized (`path:` is the prefix), whereas `acme/skills` resolves to a GitHub URL.
- **Every test walker now follows symlinks** — `tree`/`snapshot`/`installedSkills` in
  `test/install.test.ts`, `snapshot` in `test/status.test.ts`, `installed` in
  `test/git-source.test.ts`. A `readdir`-dirent walk reads a linked skill as a *file* and then fails
  with `EISDIR`, so a new walker must `stat` (not `lstat`) each entry. Mode itself is asserted
  separately, from state and `lstat`/`readlink`.
- **Three places deliberately pass `--copy`, and the claim collapses without it:**
  `test/install.test.ts`'s "replaces an owned skill directory rather than merging into it" (writing
  into a *linked* skill writes into the catalog), `test/status.test.ts`'s whole
  `describe("ambit status after a manual edit")` block (content drift is a question about a copy), and
  `test/git-source.test.ts`'s byte-for-byte git-vs-path comparison (otherwise one side links and the
  other copies).
- `test/install.test.ts`'s **`describe("idempotence")`** snapshots *every file in the project* and
  asserts the file list too, in `PROJECT_FILES`. **A21 adding `.gitignore` to what install writes has
  to extend that list** — the test is meant to fail when a new file appears.
- `test/status.test.ts` asserts the exact four-cell table (path, kind, state, detail) with the detail
  cell trimmed away on a clean project, and most of its cases assert the **whole** report through
  `states()` (`path=state` pairs) so a new row cannot appear unnoticed. Two of its cases are the ones
  that make the block mean something: a hand-added server and a hand-written skill directory must
  leave the report clean.
- `test/install.test.ts`'s **`describe("pruning")`** narrows a profile between two installs and then
  asserts *both* directions every time: what is gone, and what is still there. Its managed-key error
  case has to keep owning `mcpServers.scoped` in the state it writes, or ownership enforcement refuses
  the install before pruning is ever reached.
- `test/catalog.test.ts` owns the **second-catalog fixture**: `writeShadowingCatalog(name, coreDesc?)`
  writes a catalog under `<root>/<name>` that collides with the fixture on the `core` scope, the core
  skill, and the `scoped` server, and `writeCatalogOrder(extra, scopes)` writes the multi-catalog
  `ambit.yml`. Its `core` and `function.engineering` descriptions must stay byte-identical to
  `scripts/fixture-catalog.ts`'s or every multi-catalog test fails with the §4.4 conflict.
- `test/git-source.test.ts`'s `--offline` block proves "no fetch" **by leaving the remote in place**:
  a cold-cache offline run must fail even though the repository is right there. Two of its tests
  instead delete `fixture.repo` to prove the cache alone answered. Keep both directions — either one
  on its own is satisfiable by a bug.
- `test/git-source.test.ts`'s `installed()` skips **`PER_SOURCE_FILES` = `ambit.yml` + `ambit.lock`**:
  the git and path projects must install byte-identically *except* for the two files that record where
  the catalog came from. Anything that adds a third per-source file belongs in that set, with a reason.
- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. **Plain `--json` carries neither `reason` nor `shadows`** — both exist
  only under `--explain`. One selection change touches several goldens, so regenerate with
  `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- `test/lock.test.ts` asserts the **exact bytes** of the lock for two profiles. A new field, a
  changed reason string, or a different key order rewrites those two blocks — which is the point, but
  read the diff rather than pasting the new output.
- `writeProfile` differs per file: `(scopes, extra?)` in `test/resolve.test.ts` and
  `test/lock.test.ts`, `(scopes, harnesses?, extra?)` in `test/install.test.ts`, `(scopes)` in
  `test/status.test.ts`; `extra` lines always land **after** the scopes list so the
  `FIRST_SCOPE_LINE`/`FIRST_EXTRA_LINE` line math holds. `test/git-source.test.ts` has its own
  `writeProject(dir, source, ref?, extra?)`. All of them write a single catalog; multi-catalog configs
  come from `test/catalog.test.ts`.
- `test/install.test.ts`'s **`describe("ownership")`** asserts what is still on disk after every
  refusal, not just the exit code — an unowned dir byte-identical, and no skills, no `.mcp.json`, no
  `ambit.lock`, no state file. That last part is what pins the check to being *pre*-apply. Same block
  proves adoption **replaces** (a stray file in the adopted directory must be gone afterwards, which
  under link mode means the whole directory is swapped for a link).
- Because the check reads `.mcp.json` before anything is written, a **malformed `.mcp.json` fails
  before any skill lands**; the two parse-failure tests assert only that the file is unchanged, which
  holds either way.
- `test/install.test.ts`'s and `test/status.test.ts`'s default profile is
  `[core, function.engineering]`, which selects the `scoped` http server — so it writes `.mcp.json`
  too. Its state, `--json`, and padded-text assertions list four artifacts; adding a fifth shifts the
  column widths.
- Those two files and `test/git-source.test.ts` stub `SCOPED_API_KEY` to `undefined` in `beforeEach`
  because the fixture interpolates it into a header. Any new test that installs and asserts file
  contents needs the same discipline (`test/lock.test.ts` does not: no lock field reads the
  environment).
- The fixture catalog must stay cycle-free and dangling-free: `validate` (A23) will run against it and
  every golden profile resolves it. Tests needing extra catalog shapes write them into the per-test
  copy (`writeSkill`/`writeSourceSkill`/`writeMcp` in `test/resolve.test.ts`, `writeCatalogFile` in
  `test/install.test.ts`) rather than into `scripts/fixture-catalog.ts`. **Under link mode a test that
  edits an installed skill edits the fixture copy**, which is per-test and disposable — but the edit is
  visible to the catalog immediately, so assert accordingly.
- The text output of `resolve`, `catalog`, `install`, `status`, and `why` is asserted with exact column
  padding from `src/output.ts`. `--explain` adds a **third and a fourth** cell to the skills and mcps
  rows (reason, then shadowing — the fourth is `""` when nothing is shadowed, which `columns` trims);
  `why`'s chain pads the name column across skills and MCPs together.
- `ambit why` reads a bare name as a skill and an `mcp.`-prefixed one as a server — the same
  disambiguation `requires` uses. `MCP_REQUIREMENT_PREFIX` is exported from `src/resolve.ts` for it.
