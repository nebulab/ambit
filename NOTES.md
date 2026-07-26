# Closing handoff

**Every task in `PLAN.md` §8 is checked.** A29 was the last one, and there is no next iteration to hand
to — so this file is no longer a carry-forward note. It is two things: what someone needs to cut the
first release, and the residue thirty-two iterations left unowned.

The long-form design record that used to fill this file — the per-task constraints, the reasons behind
each invariant, and the trap list for every test — is not lost. It is in this file's own history:

```
git log -p --follow NOTES.md      # every iteration's handoff, newest first
```

Read that before changing anything subtle, and read the module doc comment at the top of the file you
are about to touch; between them they carry the "why" that `PLAN.md` states only as a requirement.

---

## Cutting the first release

Nothing has ever been published. `package.json` says `0.1.0`, `.github/workflows/release.yml` is wired
and has never fired, and the two acts that cannot be undone — the publish and the tag — were left to a
human on purpose (see the note under A29 in `PLAN.md`).

### Settle these three first

1. **The npm org.** The package is `@nebulab/ambit` while the git remote is
   `git@github.com:aldesantis/ambit.git`. Publishing needs a `nebulab` org on npmjs.com that the
   publishing identity can write to. **This is not a rename you can do cheaply later:**
   `src/catalog-init.ts` bakes `npx --yes @nebulab/ambit validate --catalog .` into the CI workflow
   every scaffolded catalog gets, `test/catalog-init.test.ts` pins that string, and the README quotes
   it. Changing the name means changing all three *and* every catalog already scaffolded in the wild.
2. **The `LICENSE` copyright holder.** A29 wrote `Copyright (c) 2026 Nebulab`, chosen to match the
   package scope. If the holder should be a person or the registered legal entity's full name, fix the
   one line in `LICENSE` before the first publish — a published tarball carries it forever.
3. **How the workflow authenticates.** It currently sets `NODE_AUTH_TOKEN` from a `NPM_TOKEN` secret
   *and* requests `id-token: write` for `--provenance`. If you instead configure npm **trusted
   publishing** for this repo/workflow pair on npmjs.com, OIDC alone suffices and the `NPM_TOKEN`
   secret and its `env:` block can go. Either way `id-token: write` must stay, or `--provenance` fails.
   Provenance also requires the **GitHub repo to be public** and `repository` to be set in
   `package.json` (it is — that field exists for exactly this reason).

### Then

```
git tag v0.1.0 && git push origin v0.1.0
```

The workflow refuses a tag that disagrees with `package.json`'s version before it publishes anything,
so a mistyped tag costs a failed run and nothing else. It then reruns lint, typecheck, test and build
against the tagged commit — deliberately, because a tag can point anywhere and npm does not let you
republish a version — and finishes with `npm publish --provenance --access public`. `--access public`
is required: npm defaults a *scoped* package to restricted.

For any later release, bump `package.json` (`npm version patch|minor|major` does the bump and the tag)
and push the tag. `--version` reads `package.json` through `src/version.ts`, a real import inlined by
tsup, so there is exactly one place to edit.

### The check that is still owed

A29's last clause, withdrawn with the publish:

```
npx @nebulab/ambit@latest --version     # must print the published version
```

Run it on a machine that has never seen this repo. It is the first thing that will ever resolve
`@nebulab/ambit` against the real registry, and therefore the first real test of the string
`catalog init` scaffolds. What A29 could verify offline it did: the packed tarball was installed into a
throwaway project and `node_modules/.bin/ambit --version` printed `0.1.0` off the symlink npm created,
which is the same code path `npx` takes minus the network.

### What is in the tarball

Nine files, 520 kB packed / 2.0 MB unpacked: `LICENSE`, `README.md`, `package.json`, and
`dist/{cli,index}.{js,js.map,d.ts}`. `files: ["dist"]` is what selects `dist/`; npm ships the other
three regardless. No test, no fixture, no `PLAN.md`/`PROMPT.md`/`NOTES.md`. Two notes:

- **`bin.ambit` is written `dist/cli.js`, without the `./`.** npm normalizes the leading `./` away and
  warns `"bin[ambit]" script name dist/cli.js was invalid and removed` while doing so — misleading
  wording for a rewrite, not a removal, but it is the kind of warning that eats an hour at release
  time. Written the way npm normalizes it, the publish is warning-free. Do not put the `./` back.
- **Source maps are ~1.4 MB of the 2.0 MB unpacked.** `tsup.config.ts` emits them and nothing excludes
  them. Fine, arguably good for a CLI people debug; nobody owns deciding otherwise.

### CI

`.github/workflows/ci.yml` runs lint → typecheck → test → build on Node 20 and 22 (20 is the `engines`
floor; 22 is what the scaffolded catalog workflow pins), on every PR and every push to `main`.

**`AMBIT_SKIP_NETWORK_TESTS` is deliberately unset there.** Actions sets `CI=true` itself, and that is
exactly what makes `test/dotagents.test.ts` mandatory rather than skippable — a skip outside CI, a
thrown `beforeAll` inside it. Spec §7 calls the compatibility promise the guarantee most likely to rot,
so it has to be able to fail. The cost is that a registry blip takes ~70s to report. Setting that
variable in CI would silently retire the promise; do not.

---

## Residue: what nobody owns

Collected from every iteration's omissions. None of these is a defect — each is a stance somebody took
deliberately — but each is a place where a reasonable person could want something else.

### Worth a second opinion (a decision, not a gap)

- **The editor validates the *whole* result, so any pre-existing problem in a catalog blocks every
  mutation** (exit 3, nothing written). That is spec §6 authoring rule 4 read literally. The
  alternative is to refuse only problems the edit introduces, which would let someone fix one broken
  file while another is still broken.
- **`validate` calls name shadowing a problem**, so a project deliberately overlaying a personal
  catalog on a company one *fails* `validate` while installing fine. The other reading is that
  shadowing is only a problem in `--catalog` mode.
- **`catalog scope add` is declarative** — re-running it with new words is the only way to correct a
  description, because nothing else edits one. The alternative is to refuse an existing name.
- **`.gitignore` is written by `install` but is not an owned artifact**: no state entry, no
  `PlannedArtifact`, no `status` row, no prune branch. The record is the in-band marker block instead.
  Spec §5 rule 1 is phrased in terms of state, so this is a reading.
- **`clean` leaves three things behind** — `ambit.lock`, a `.mcp.json` holding `{"mcpServers": {}}`, and
  an empty `.claude/skills` — on the grounds that ambit deletes only what it owns. `PLAN.md`'s
  "otherwise identical to before the first install" can be read as reaching all three.

### Redundancy and rough edges

- **`CatalogMcp.file` obsoletes three disk lookups.** `auditCatalog`'s `mcpFiles` option,
  `removeMcp`/`alreadyProvided`'s `await mcpDocumentFile(root, …)` in `src/catalog-mcp.ts`, and
  `declarersOf`'s per-entity `stat` in `src/catalog-scope.ts` (the only reason that function is async)
  all re-derive a filename the parsed catalog already carries. All three *agree* with `file` by
  construction, so this is redundancy, not a bug. Routing them through the data would delete the
  option, both `await`s, and probably `declarersOf`'s asyncness. `mcpDocumentFile` itself must stay,
  for a name nothing has parsed (`mcp new`).
- **Several flag rules stay in their handlers** rather than on Commander, even though A30 made moving
  them possible: `catalog scope add`'s required `--description`, `mcp new`'s "exactly one transport"
  and every transport-flag refusal, `annotate`'s add-and-remove contradiction. Each handler message
  names a file and gives a next step where Commander's would say
  `error: required option '--description <text>' not specified` and nothing else. Their tests pin the
  current wording.
- **A Commander usage error always ends with the program's ``(run `ambit --help` for usage)``**, even from
  `catalog scope add`, because `showHelpAfterError` is inherited wholesale by `inheritSettings`. A
  per-command hint means re-applying the setting after the copy with the command's full name.
- **`src/validate.ts` holds a literal NUL byte** (a `join("\0")` written as a raw byte, in
  `cycleProblems`' canonical-rotation key), so **`grep` treats the file as binary and silently finds
  nothing in it**. Use `rg -a`, or read it. A one-character change to `"\\u0000"` fixes it.
- **Nothing removes a catalog's top-level directories.** `skills/` and `mcps/` survive even when the
  last thing inside them goes, because they are the catalog's shape rather than its contents; the
  editor's ancestor pruning stops at depth one for the same reason, and removing an entity file prunes
  no directory at all.
- **`--quiet` and `--no-color` are accepted everywhere and are no-ops.** Nothing in `src/` reads
  either. The README says so in as many words.

### Capability nobody built

- **The compatibility promise covers one consumer.** `test/dotagents.test.ts` is the only networked
  test (spec §7 exempts exactly one), and it can claim nothing about MCP servers — dotagents declares
  those in its own `agents.toml`, so a catalog's `mcps/` is invisible to it, and being *ignored* is the
  whole promise there. A second consumer (skills.sh) would take the same helper with a different
  package name.
- **Nothing prunes the git cache, and nothing locks it** against a concurrent ambit (`loadCatalogs` is
  sequential for that reason). Cache GC is unowned; nothing ambit does, `clean` included, ever removes
  anything from the cache.
- **Nothing persists a materialization mode.** `--copy`/`--link` are per-run by spec §5 and there is no
  config key. Adding one is a config change and a spec change, not an adapter change.
- **No command reports the configured harnesses**, and nothing says **which catalog registered a
  scope** — `mergeCatalogs` keeps that only long enough to raise the §4.4 description conflict, so
  widening `ScopeDefinition` is the price of per-scope provenance.
- **Nothing merges the `scopes` and `catalog tree` views.** `scopes` is the merged registry with `held`
  and says nothing about what a scope selects; `tree` shows selection counts but works on one
  `--catalog` directory. Likewise `catalog audit` judges one catalog directory and so cannot see a
  project: an item a project lists explicitly, or one another catalog's skill requires, is reachable
  there and still reported here. That is the honest answer for a catalog repo's own CI, and the reason
  the command takes `--catalog`. A merged-view audit is unowned.
- **`prune` leaves `ambit.lock` stale**, and `doctor`'s `lock` check is the only thing that says so.
- **Harness adapters beyond Claude Code.** The interface exists; the implementations do not (§9).
- **Spec §3.2's collision risk is a standing bet:** `scopes` and `requires` are unnamespaced top-level
  frontmatter keys, and a harness that later defines its own breaks this. `PLAN.md` §3.2 flags it, the
  README says it out loud, and revisiting it waits for it to happen.
