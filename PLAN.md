# ambit — build specification

A deterministic dependency manager for AI-agent capabilities: skills and MCP servers,
selected by scope.

This document is the complete build brief. It assumes no prior context.

---

## 1. What ambit is

Agent harnesses (Claude Code, Cursor, Codex) load *skills* — folders of instructions — and
connect to *MCP servers*. Today you pick those by hand, per project, per person. That
doesn't scale past one person: a designer and a backend engineer at the same company need
overlapping-but-different sets, and nobody wants to hand-maintain a config file per human.

ambit makes the selection declarative. A project declares the **scopes** it holds:

```yaml
scopes:
  - function.engineering
  - project.vision-group
```

Skills and MCP servers in a **catalog** declare which scopes they belong to. ambit resolves
the two into a **bundle** and materializes it into the harness's config.

**ambit contains no AI.** It is a resolver and an installer. Same inputs, same output, every
time. Anything requiring judgement — deciding which scopes a person holds, writing a skill —
happens outside and hands ambit a config file.

### Relationship to dotagents

ambit replaces [dotagents](https://github.com/getsentry/dotagents) rather than wrapping it.
dotagents' model (a flat, hand-listed set of skills) can't express scope-driven selection,
and three of its behaviors actively fight this design:

- `install` does not prune skills removed from config — they stay on disk and active.
- `sync` *adopts* orphaned skills, rewriting them into the lockfile as permanent local
  path entries. Deselect something, run `sync`, and it comes back.
- Local path skills are **copied** into the install directory, so the file the agent reads
  is a stale duplicate of the tracked source.

ambit fixes all three by owning the install path: real pruning, strict ownership tracking,
and symlinks for local sources.

**But catalog repos stay compatible.** A catalog is a plain skills repo — skills at
`skills/<namespace>/<name>/SKILL.md`, name derived from the path. dotagents, skills.sh, or
anything else can install from the same repo. ambit's additions (extra frontmatter keys, a
`mcps/` directory, a `scopes.yml`) are additive and ignored by other tools. **Never break
this.** It is a hard requirement, not a nice-to-have.

### Stack

- **TypeScript**, distributed on npm, run via `npx @<org>/ambit` with no install step.
- Node 20+. No runtime dependencies beyond git being on PATH.
- Test runner: vitest. Bundler: tsup. Single `ambit` bin.

---

## 2. Concepts

| Term | Meaning |
| --- | --- |
| **Catalog** | A source of skills and MCP definitions — a git repo or local directory. |
| **Skill** | A directory containing `SKILL.md`. Its name is its path under `skills/` with `/` → `.`, so `skills/nebulab/sales/use-close/` is `nebulab.sales.use-close`. |
| **MCP entity** | A server definition in the catalog's `mcps/` directory. |
| **Scope** | A dotted, nestable label for *who needs a thing*: `function.engineering`, `project.vision-group`, `person.jane-doe`. |
| **Project** | A directory containing `ambit.yml`. |
| **Bundle** | The resolved set of skills and MCP servers for a project. |
| **Harness adapter** | Code that writes a bundle into one agent tool's layout. |
| **Owned artifact** | A file or directory ambit created. ambit never touches anything else. |

### The selection rule

**A held scope selects itself and every scope beneath it. Descendants only.**

Holding `function.engineering` selects things scoped `function.engineering` *and*
`function.engineering.frontend`. Holding `function.engineering.frontend` selects only that
subtree — it does **not** reach up to `function.engineering`.

This makes tree shape load-bearing, and catalog authors must understand it: nest only when
selecting the parent genuinely implies wanting every child. Things people pick independently
must be siblings. Document this prominently in the README, because getting it wrong is only
fixable by restructuring the tree.

**ambit reserves no scope names.** Nothing is held implicitly — a project gets exactly the
scopes it lists. Catalogs conventionally use `core` for the universal floor, but that is a
naming convention, not a rule the resolver knows about, and a project that wants it must say
so.

The tradeoff: someone who writes `scopes: [function.sales]` and forgets `core` gets a bundle
with no company context or house style, and nothing warns them. That's the cost of a
resolver with no special cases. `ambit init` scaffolds `core` into the starter config with a
comment, and consuming tools should write it explicitly.

---

## 3. File formats

Everything is YAML — config, catalog metadata, the lockfile, and the skill frontmatter that
harnesses already use. One format, one parser, one set of rules.

### 3.0 YAML handling rules

These are not stylistic. Getting them wrong produces silent, hard-to-trace corruption.

- **Parser:** the `yaml` package (eemeli), YAML 1.2, with the **core schema only**. No
  custom tags, no arbitrary type resolution, no `!!python`-style constructs. Reject any
  document containing custom tags.
- **Everything that identifies something is a string.** Git refs are the trap: a commit SHA
  like `1234567` parses as an integer, and `ref: 1e5` parses as a float. Coerce every
  `ref`, `name`, `path`, `source`, and scope to a string after parsing, and fail with a
  clear error if a value arrives as a number or boolean where a string is required rather
  than silently stringifying it.
- **Duplicate keys are an error.** Most YAML parsers accept them and keep the last. ambit
  must reject the document, naming the key and both line numbers.
- **Tabs are an error**, reported as "YAML does not permit tabs for indentation" with the
  line number — the single most common YAML mistake.
- **Empty file, or a document that isn't a mapping**, is an error, not an empty config.
- **`null` vs missing:** an explicitly null value is an error where a value is required.
  Absent keys take defaults.
- **Emitting** (lock, `init` scaffold): sorted keys, consistent double-quoting for strings
  that could otherwise coerce, no anchors or aliases, no line-wrapping. The output must be
  byte-stable across runs.

### 3.1 `ambit.yml` — project config

Lives at the project root. `ambit.yaml` is accepted; having both is an error. Hand-written
or generated by a consuming tool.

```yaml
version: 1
harnesses: [claude]

# Scopes this project holds. Nothing is implicit — list everything, including the
# catalog's universal scope if it has one.
scopes:
  - core
  - function.engineering
  - project.vision-group

# Catalogs, in priority order. On a name collision, the first wins.
catalogs:
  - name: company
    source: git@github.com:acme/skills.git
    ref: "a1b2c3d4"            # tag, branch, or commit. Quote it. Omit for default branch.
  - name: personal
    source: git@github.com:jane/skills-private.git
    ref: main

# Extra skills, regardless of scope.
# A string is shorthand for a name looked up in the configured catalogs.
# A mapping declares a skill from a source that isn't a full catalog.
skills:
  - acme.marketing.use-luma
  - name: readwise-cli
    source: https://github.com/readwiseio/readwise-skills
    path: skills/readwise-cli  # optional; overrides the name→path convention

# Ad-hoc MCP servers not defined in any catalog. Same shape as a catalog MCP entity.
mcps:
  - name: custom
    transport:
      stdio:
        command: npx
        args: ["-y", "some-server"]
    env: [SOME_TOKEN]
```

**Field reference**

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `version` | int | yes | Must be `1`. |
| `harnesses` | string[] | no | Default `[claude]`. |
| `scopes` | string[] | no | Held scopes, exactly as listed. Nothing is added implicitly. Absent or empty means nothing is selected by scope — only explicit `skills` entries. |
| `catalogs` | list of maps | no | `name`, `source`, `ref?`. `name` unique. |
| `skills` | list of strings or maps | no | String = name from a catalog. Map = `name`, `source`, `ref?`, `path?`. |
| `mcps` | list of maps | no | Inline server definitions, §3.3 shape. |

**Source formats:** `owner/repo`, `owner/repo@ref`, `https://github.com/owner/repo`,
`git@host:owner/repo.git`, `git:<any-git-url>`, `path:./relative/dir`.

### 3.2 Skill annotations — `SKILL.md` frontmatter

Annotations are **top-level frontmatter keys**, added alongside whatever the harness already
uses. Other tools ignore unknown keys.

```yaml
---
name: acme.sales.use-close
description: "Calls the Close CRM REST API…"
scopes: [function.sales]
requires:
  - acme.commons.use-company-context
  - mcp.close
env: [CLOSE_API_KEY]
---
```

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `scopes` | string[] | no | Absent or empty = never selected by scope; reachable only via `requires` or explicit listing. |
| `requires` | string[] | no | Skill names, or MCP names prefixed `mcp.`. |
| `env` | string[] | no | Env vars the skill itself reads (not via an MCP). |

`name` and `description` are the harness's own keys; ambit reads `name` and requires it to
match the directory path. The frontmatter block is parsed under the same rules as §3.0.

> **Collision risk:** these are unnamespaced top-level keys. If a harness later defines its
> own `scopes` or `requires`, this breaks. Note it in the README; revisit if it happens.

### 3.3 MCP entities — `mcps/<name>.yml`

```yaml
name: close
scopes: [function.sales]

transport:
  http:
    url: https://api.close.com/mcp
    headers:
      Authorization: "Bearer ${CLOSE_API_KEY}"

# or, for a locally-spawned server:
# transport:
#   stdio:
#     command: npx
#     args: ["-y", "@acme/close-mcp"]

env: [CLOSE_API_KEY]
```

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | Must match the filename stem. |
| `scopes` | string[] | no | Same semantics as skills. |
| `transport` | map | yes | Exactly one key, naming the kind: `stdio` or `http`. |
| `transport.stdio.command` | string | yes for stdio | Executable to spawn. |
| `transport.stdio.args` | string[] | no | Arguments. |
| `transport.http.url` | string | yes for http | Server endpoint. |
| `transport.http.headers` | map | no | `${VAR}` interpolated from the environment at install. |
| `env` | string[] | no | Env vars this server needs. |

**Transport validation:** `transport` must contain exactly one key. Zero keys, two keys, or
an unrecognized kind is an error naming the supported kinds — this is the discriminator, so
it must never be ambiguous. Keeping the kind as a nested key rather than a `type:` field
means each kind's fields are scoped to it and a new kind (sse, websocket) adds nothing to
the top level.

A server is installed if **its scopes match, or a selected skill requires it.** Both paths
are needed: some servers are worth having because of who you are, with no skill involved;
others must follow a skill into the bundle even when their scopes differ.

### 3.4 `scopes.yml` — the catalog's scope registry

At the catalog root.

```yaml
scopes:
  function.engineering:
    description: Building and shipping client software
  function.engineering.frontend:
    description: "Browser-side work: components, styling, accessibility"
  project.vision-group:
    description: The Vision Group engagement
```

Every scope used by a skill or MCP must be registered here, so a typo fails loudly instead
of silently matching nothing. The registry is also the human-readable list a consuming tool
renders as a picker — descriptions are not optional decoration.

### 3.5 `ambit.lock` — resolution result

Generated YAML. Committed when a team wants reproducible installs; gitignored when config
is per-person. Sorted keys, no timestamps, byte-stable.

```yaml
version: 1

catalogs:
  company:
    source: git@github.com:acme/skills.git
    ref: main
    commit: a1b2c3d4e5f6789...

skills:
  acme.sales.use-close:
    catalog: company
    path: skills/acme/sales/use-close
    commit: a1b2c3d4e5f6789...
    reason: scope:function.sales

mcps:
  close:
    catalog: company
    reason: required-by:acme.sales.use-close
```

### 3.6 `.ambit/state.json` — what is actually on disk

Generated, always gitignored, machine-local, and **JSON rather than YAML** — nothing reads
it by hand, and JSON's single unambiguous serialization is what a crash-safety record wants.

It lists every **owned artifact** by project-relative path. This is what makes pruning safe:
ambit deletes only what this file says it created.

```json
{
  "version": 1,
  "harnesses": ["claude"],
  "artifacts": [
    { "path": ".claude/skills/acme.sales.use-close", "kind": "skill-dir", "mode": "copy" },
    { "path": ".mcp.json", "kind": "harness-config", "managedKeys": ["mcpServers.close"] }
  ]
}
```

## 4. Resolution algorithm

Must be deterministic: sort every collection before iterating, never depend on object key
order, never include timestamps. Resolving twice produces byte-identical output; resolving
with shuffled input file order produces identical output.

1. **Load and validate config.** Malformed → exit 2 naming the field.
2. **Fetch catalogs.** Each to a local cache, at its `ref`, resolved to a commit SHA.
3. **Parse each catalog:** `scopes.yml`, every `skills/**/SKILL.md`, every `mcps/*.yml`.
   A skill whose frontmatter `name` disagrees with its directory path is an error.
4. **Merge registries** across catalogs. Same scope declared twice with identical
   descriptions merges silently; differing descriptions → exit 3 naming both catalogs.
5. **Merge catalogs.** On a duplicate skill or MCP name, the earlier catalog in config order
   wins; record the shadowing so `--explain` and `validate` can report it.
6. **Expand held scopes.** `H` = for each held scope `s` in config, every registered scope
   equal to `s` or beginning with `s + "."`. A held scope absent from the merged registry →
   exit 3, naming it and suggesting the nearest registered scope by edit distance.
7. **Select by scope.** Any skill or MCP with at least one declared scope in `H`.
8. **Add explicit entries:** `skills` and `mcps` from config.
9. **Close over `requires`.** Worklist until fixpoint. `mcp.`-prefixed targets resolve
   against MCP entities, everything else against skills. Unresolvable → exit 3 naming the
   requirer and the missing target. A cycle → exit 3 printing the full cycle path.
10. **Union `env`** across selected skills and MCPs.
11. **Emit the bundle**, sorted by name.

### Validation split

- `ambit resolve` / `install` hard-validate only the **selected closure**, so one broken
  unrelated skill doesn't block everyone.
- `ambit validate` validates the **entire catalog** — every scope registered, every
  `requires` target resolvable, no cycles, no name shadowing, every skill name matching its
  path. This is the CI command for catalog repos.

---

## 5. Fetching, cache, and materialization

### Cache

`$XDG_CACHE_HOME/ambit/` (fall back to `~/.cache/ambit/`), keyed by host/owner/repo. Bare
clones, fetched on demand. `--offline` uses only what's cached and fails with exit 4 if
something is missing.

### Materialization — the Claude adapter

- **Skills → `.claude/skills/<name>/`.**
  - Remote-source skills are **copied** (immutable, pinned to a commit).
  - `path:` local-source skills are **symlinked**, so editing the skill edits the tracked
    source rather than a stale duplicate. `--copy` / `--link` override per run.
- **MCP servers → `.mcp.json`.** Each entity's `transport` maps onto the harness's own
  server shape — `stdio` to `command`/`args`, `http` to `url`/`headers`. ambit owns only the
  server keys it wrote, recorded in state. Servers added by hand are preserved untouched. `${VAR}` in `headers` is
  interpolated from the environment at install; a missing var is a warning, not a failure
  (`doctor` reports it).
- **Gitignore.** ambit appends its owned paths to `.gitignore` under a clearly delimited
  managed block it rewrites in place.

### Ownership rules — the safety core

1. ambit deletes or overwrites **only** paths listed as owned in `.ambit/state.json`.
2. If a target path exists and is not owned, ambit **stops** with exit 2 rather than
   clobbering it, naming the path.
3. Pruning removes owned artifacts absent from the new bundle, then rewrites state.
4. State is written **after** the filesystem changes succeed, so a crash leaves artifacts
   owned and recoverable rather than orphaned.

### Adapter interface

Keep the boundary explicit even though v1 ships one adapter:

```ts
interface HarnessAdapter {
  readonly name: string;
  plan(bundle: Bundle, project: ProjectPaths): PlannedArtifact[];
  apply(plan: PlannedArtifact[], prior: State): Promise<AppliedArtifact[]>;
}
```

`plan` is pure and testable; `apply` is the only thing that touches disk. `--dry-run` prints
the plan and exits.

---

## 6. CLI

```
ambit init                     scaffold an ambit.yml
ambit scopes [--json]          list registered scopes with descriptions
ambit catalog [--json]         dump the merged catalog
ambit resolve [--explain]      compute the bundle and print it
ambit why <name>               explain why one item is in the bundle
ambit install [--frozen]       resolve, write lock, materialize, prune
ambit status [--check]         compare what's installed against what resolve produces
ambit prune                    remove owned artifacts not in the current bundle
ambit clean                    remove everything ambit owns
ambit validate [--catalog DIR] full-catalog validation, for CI
ambit doctor                   env vars, drift, ownership

ambit catalog dump [--json]    dump the merged catalog (what `ambit catalog` does)
ambit catalog init             scaffold a catalog repo, as `ambit init` does a project
ambit catalog tree [--json]    the scope tree, and what each scope selects
ambit catalog audit [--check]  find dead scopes and unreachable items
ambit catalog scope add|rm|mv  maintain scopes.yml
ambit catalog skill new|rm|mv  maintain a skill directory
ambit catalog mcp new|rm       maintain an MCP entity
ambit catalog annotate <name>  change a skill or MCP's scopes, requires, or env
```

**Global flags:** `--project <dir>` (default cwd), `--json`, `--offline`, `--quiet`,
`--no-color`, `--dry-run` (on mutating commands).

`--frozen` fails if resolution would change `ambit.lock` — the CI check that a committed
lock is current.

`--explain` annotates each item with why it was selected: `scope:function.sales`,
`required-by:acme.sales.use-close`, `explicit`, or `catalog:company (shadows personal)`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected internal error |
| 2 | Config or ownership error |
| 3 | Resolution error — unknown scope, missing requirement, cycle, name conflict |
| 4 | Network or cache error |
| 5 | Drift detected (`status --check`, `install --frozen`) |
| 6 | `doctor` found failures |

### Error message standard

Every error names the offending file, the offending identifier, and one concrete next step.

```
error: unknown scope "function.enginering" (ambit.yml line 6)
       not found in the merged registry
       did you mean "function.engineering"?

error: requirement cycle
       acme.a → acme.b → acme.c → acme.a
       break the cycle by removing one `requires` edge

error: refusing to overwrite unowned path
       .claude/skills/acme.sales.use-close exists but ambit did not create it
       move it aside, or run `ambit install --adopt` to take ownership
```

### Catalog authoring

The commands above serve someone *consuming* a catalog. These serve someone *maintaining* one.
The split matters because the two act on different directories: consumer commands take
`--project <dir>` and read `ambit.yml`; authoring commands take **`--catalog <dir>` (default
cwd)** and read the catalog root. A catalog is not a project and has no `ambit.yml`.

`catalog` becomes a command group whose **default action is `dump`**, so `ambit catalog` and
`ambit catalog --json` keep behaving exactly as they do today.

```
ambit catalog scope add <name> --description <text>
ambit catalog scope rm <name>
ambit catalog scope mv <old> <new>

ambit catalog skill new <name> [--description <text>] [--scope <s>…]
                               [--requires <r>…] [--env <v>…]
ambit catalog skill rm <name>
ambit catalog skill mv <old> <new>

ambit catalog mcp new <name> (--stdio <command> [--arg <a>…] | --http <url> [--header <k=v>…])
                             [--env <v>…]
ambit catalog mcp rm <name>

ambit catalog annotate <name> [--add-scope <s>…]     [--remove-scope <s>…]
                              [--add-requires <r>…]  [--remove-requires <r>…]
                              [--add-env <v>…]       [--remove-env <v>…]
```

List-valued flags are repeatable rather than comma-separated: a scope name can contain a comma
far more easily than an argv entry can.

**Rules every authoring command obeys.** These are what make editing a catalog as deterministic
as resolving one:

1. **Never break the plain skills repo.** Authored output stays readable by any tool that
   derives a name from a path (§1). Same hard requirement, now enforced on ambit's own writes.
2. **Surgical edits.** Changing an annotation preserves comments, unknown keys, the order of
   keys ambit did not touch, and the markdown body **byte-for-byte**. A catalog is
   hand-maintained; a tool that reformats it on every edit is a tool nobody runs twice.
3. **Emit per §3.0** where ambit owns the shape: sorted keys, quoting for strings that could
   otherwise coerce, no anchors or aliases, byte-stable across runs.
4. **Validate before writing, not after.** Every mutation runs the `validate` checks against
   the *result* and refuses to write if they fail — exit 3, every file left byte-identical. A
   mutation cannot leave a catalog broken.
5. **Atomic writes**, and never a path outside the catalog root — exit 2, naming the path.
6. **`--dry-run`** prints the diff it would write and touches nothing.

---

## 7. Testing

Everything must be testable offline. A fixture builder script constructs local git repos so
no test touches the network.

- **Unit:** YAML loading under the §3.0 rules, frontmatter parsing, name↔path derivation,
  scope expansion,
  `requires` closure, cycle detection, catalog merge and shadowing.
- **Golden files:** `resolve --json` for a matrix of profiles against a fixture catalog.
- **Integration:** full `install` against fixture catalogs, asserting the resulting tree and
  `.mcp.json`.
- **Determinism:** resolve twice → byte-identical; resolve with shuffled directory-read
  order → identical.
- **Idempotence:** install twice → second run changes nothing, `status --check` exits 0.
- **Pruning:** install bundle A, install bundle B, assert A-only artifacts gone, unowned
  files untouched, state accurate.
- **Ownership:** pre-create an unowned path at a target location, assert exit 2 and that the
  file is unmodified.
- **Compatibility:** a fixture catalog must remain installable by `npx @sentry/dotagents`.
  This is a real test, not a claim — it is the guarantee most likely to rot.
- **Authoring round-trip:** every mutation's output re-parses; a no-op edit is byte-identical,
  comments, unknown frontmatter keys, and skill bodies included; and a mutation refused by
  validation leaves every file untouched.

---

## 8. Tasks

Sliced so each leaves the tool working and demonstrable. The walking skeleton (A01–A06)
runs the whole pipeline against a local fixture before any git, lock, or prune logic exists.

### Loop protocol

1. Take **exactly one** unchecked task, topmost first. Skip any whose `Depends` are
   unchecked.
2. Do only what the task says. No opportunistic refactoring.
3. Run every check under **Done when**. Fix failures before ticking the box.
4. Tick the box, then commit as `type(scope): description (A01)`.
5. If blocked, add `> BLOCKED: <reason>` under the task, leave it unchecked, move on.

### Walking skeleton

- [x] **A01 — Repo scaffold.**
  **Do:** TypeScript, tsup build, vitest, a single `ambit` bin, strict tsconfig, lint.
  Commander or a hand-rolled arg parser; no heavyweight framework.
  **Done when:** `npm test` passes with zero tests, `npx .` prints usage and exits 0.

- [x] **A02 — Fixture catalog builder.**
  **Depends:** A01
  **Do:** A script building a local catalog directory: `scopes.yml` with a nested scope,
  four skills (`core`, `function.engineering`, `function.engineering.frontend`, and a
  `project.acme` one that requires the core skill and `mcp.fixture`), and two MCP entities —
  one scoped, one reachable only via `requires`.
  **Done when:** Idempotent, and a test asserts the fixture's contents.

- [x] **A03 — Config loading.**
  **Depends:** A02
  **Do:** Build the shared YAML loader enforcing every §3.0 rule, then parse and validate
  `ambit.yml` per §3.1 on top of it. Unknown keys are an error, not a warning. Every later
  parser — frontmatter, MCP entities, scope registry — uses this loader.
  **Done when:** Valid fixtures parse into a typed object, and each of these malformed
  fixtures exits 2 naming the problem and its line: duplicate key, tab indentation, custom
  tag, empty document, non-mapping root, unknown key, explicit null where a value is
  required, and `ref: 1234567` arriving as a number rather than a string.

- [x] **A04 — Catalog parsing, local paths only.**
  **Depends:** A03
  **Do:** Read `scopes.yml`, `skills/**/SKILL.md` frontmatter, `mcps/*.yml` from a `path:`
  source. Enforce name↔path agreement.
  **Done when:** `ambit catalog --json` emits the full fixture catalog; a mismatched skill
  name exits 2.

- [x] **A05 — Resolve: exact scope match.**
  **Depends:** A04
  **Do:** Exactly the scopes listed, exact matches only. No implicit scopes, no subtree, no
  closure.
  **Done when:** Golden files prove `[function.engineering]` yields the engineering skill
  and **not** the core one — nothing is implicit — while `[core, function.engineering]`
  yields both, and neither profile yields the nested frontend skill or the acme one. An
  empty `scopes` list yields an empty bundle.

- [x] **A06 — Claude adapter: install skills.**
  **Depends:** A05
  **Slice:** **the walking skeleton** — config in, skills on disk.
  **Do:** `plan`/`apply` split, copy skill dirs into `.claude/skills/`, write
  `.ambit/state.json`.
  **Done when:** `ambit install` against the fixture produces exactly the resolved skill
  directories, and an integration test asserts the tree.

### Resolver

- [x] **A07 — Scope subtree expansion.**
  **Depends:** A06
  **Done when:** `["function.engineering"]` now also selects the frontend skill;
  `[function.engineering.frontend]` selects the frontend skill but **not** general
  engineering — and not core either, since nothing is implicit. Both directions tested.

- [x] **A08 — Unknown-scope detection.**
  **Depends:** A07
  **Done when:** A held scope absent from the registry exits 3, names it, and suggests the
  nearest registered scope.

- [x] **A09 — `requires` closure and cycles.**
  **Depends:** A08
  **Done when:** Selecting the acme skill pulls in its required core skill and
  `mcp.fixture` despite neither matching by scope; a cycle fixture exits 3 printing the full
  path.

- [x] **A10 — MCP selection and `.mcp.json`.**
  **Depends:** A09
  **Done when:** After install, `.mcp.json` contains exactly the scope-matched server plus
  the requires-only server, with both transport kinds mapped correctly; a hand-added server
  in the file survives untouched; a `transport` with zero or two kind keys exits 2.

- [ ] **A11 — Explicit skills and inline MCPs.**
  **Depends:** A10
  **Done when:** Both `skills` forms — a bare name resolved from a catalog, and a mapping
  carrying its own `source` — appear in the bundle regardless of scope, as do inline `mcps`
  entries; a bare name matching nothing in any catalog exits 3.

- [ ] **A12 — `resolve --explain` and `ambit why`.**
  **Depends:** A11
  **Done when:** Every bundle item carries a reason (`scope:…`, `required-by:…`, `explicit`),
  and `ambit why <name>` prints the full chain from a held scope to that item.

### Sources and reproducibility

- [ ] **A13 — Git sources and cache.**
  **Depends:** A12
  **Do:** All source formats from §3.1, bare clones in the cache, ref → commit resolution.
  **Done when:** A fixture served from a local bare repo installs identically to the
  path-source version; a second run hits the cache without fetching.

- [ ] **A14 — `ambit.lock`.**
  **Depends:** A14
  **Done when:** Install writes a sorted, timestamp-free YAML lock with no anchors or
  aliases; the same inputs produce a byte-identical file; a commit SHA that looks numeric
  round-trips as a quoted string; `--frozen` exits 5 when resolution would change it.

- [ ] **A15 — Multi-catalog merge and shadowing.**
  **Depends:** A14
  **Done when:** Two catalogs providing the same skill name resolve to the first in config
  order, `--explain` reports the shadowing, and conflicting scope descriptions exit 3.

- [ ] **A16 — `--offline`.**
  **Depends:** A15
  **Done when:** Resolves entirely from cache; a cache miss exits 4 naming what's missing.

### Install correctness

- [ ] **A17 — Ownership enforcement.**
  **Depends:** A16
  **Slice:** ambit can never eat a file it didn't create.
  **Done when:** An unowned file at a target path exits 2 and is left byte-identical;
  `--adopt` takes ownership explicitly.

- [ ] **A18 — Pruning.**
  **Depends:** A17
  **Done when:** Install A then install B removes A-only skills and MCP entries from disk,
  `.mcp.json`, and state, while leaving unowned files alone.

- [ ] **A19 — Idempotence and `status`.**
  **Depends:** A18
  **Done when:** A second identical install changes no bytes; `status` reports drift after a
  manual edit; `status --check` exits 5 on drift, 0 when clean.

- [ ] **A20 — Symlink local sources.**
  **Depends:** A19
  **Done when:** `path:` sources are symlinked so editing the installed skill edits the
  source; remote sources are copied; `--copy`/`--link` override; prune handles both.

- [ ] **A21 — Managed gitignore block.**
  **Depends:** A20
  **Done when:** Owned paths land in a delimited managed block that is rewritten in place
  across runs and never disturbs surrounding lines.

- [ ] **A22 — `--dry-run` and `clean`.**
  **Depends:** A21
  **Done when:** `--dry-run` prints the plan and touches nothing; `clean` removes every
  owned artifact and leaves the project otherwise identical to before the first install.

### Validation and health

- [ ] **A23 — `ambit validate`.**
  **Depends:** A22
  **Done when:** Full-catalog validation catches unregistered scopes, unresolvable
  `requires`, cycles, name↔path mismatches, and shadowing; exits 3 with all problems listed,
  not just the first.

- [ ] **A24 — `ambit doctor`.**
  **Depends:** A23
  **Done when:** Reports every env var the bundle's skills and MCPs declare that is absent
  from the environment, naming which skill or server wants each one; reports drift against
  the lock and any ownership anomaly; exits 6 if any check fails.

- [ ] **A25 — `ambit scopes` and `ambit init`.**
  **Depends:** A24
  **Done when:** `scopes --json` emits the merged registry with descriptions — the picker
  data a consuming tool needs — and `init` scaffolds a commented, valid `ambit.yml` whose
  `scopes` list includes `core` with a comment explaining that nothing is implicit.

### Catalog authoring

The consumer side is complete by here; this section gives the maintainer side the same
determinism. It lands before Shipping so the README and CI cover the whole surface, and so the
compatibility test gets to run against a catalog ambit itself authored. Every command edits
files other tools also read, so the editor lands before anything that uses it, and every
mutation ends by re-validating.

- [ ] **B01 — Authoring surface and `catalog dump`.**
  **Depends:** A25
  **Do:** Make `catalog` a command group with `dump` as its default action, and declare the
  whole authoring surface — `--catalog <dir>` included — in the one place `COMMAND_SPECS`
  already declares the rest. Unbuilt subcommands report as unimplemented.
  **Done when:** `ambit catalog` and `ambit catalog dump` emit byte-identical output with the
  existing golden files untouched; `ambit catalog --help` lists every authoring subcommand;
  each unbuilt one exits 1 naming itself.

- [ ] **B02 — The catalog editor.**
  **Depends:** B01
  **Slice:** every later mutation is a caller of this.
  **Do:** One module all writes go through: load `scopes.yml`, `SKILL.md` frontmatter, or
  `mcps/*.yml`, change only the keys asked for, re-emit preserving everything else. Atomic
  writes, and refuse any target outside the catalog root.
  **Done when:** A no-op round-trip of every fixture file is byte-identical, comments included;
  adding a scope to a `SKILL.md` carrying `allowed-tools` and a comment leaves both, the key
  order, and the body untouched; a target outside the root exits 2 with nothing written; a
  write refused by validation leaves the file byte-identical.

- [ ] **B03 — `ambit catalog init`.**
  **Depends:** B02
  **Do:** Scaffold a catalog in `--catalog <dir>` (default cwd), the mirror of what `ambit init`
  does for a project: `scopes.yml` registering `core` with a comment, `skills/` and `mcps/`, a
  README carrying the descendants-only rule and the sibling-vs-child guidance from §2, and a CI
  workflow running `ambit validate --catalog .`.
  **Done when:** The scaffold parses, `ambit validate` exits 0 against it, and two runs into
  fresh directories produce byte-identical trees. An existing `scopes.yml` is refused with exit 2
  and nothing written — initializing a directory that already holds a catalog is the mistake
  worth catching, while an otherwise-occupied directory (a README, a `.git`) is fine, since a
  catalog is normally initialized inside a repo that already exists.

- [ ] **B04 — Scope registry commands.**
  **Depends:** B03
  **Do:** `catalog scope add|rm|mv`. `add` requires a description. `rm` refuses while anything
  still declares the scope. `mv` renames the scope **and every descendant**, rewriting every
  skill and MCP that declares any of them.
  **Done when:** `add` emits a byte-stable registry and re-running it is a no-op; `rm` of a
  declared scope exits 3 naming every declarer; `mv function.engineering` also renames
  `function.engineering.frontend` and rewrites both declarers; comments in `scopes.yml`
  survive; `validate` passes after each.

- [ ] **B05 — Skill commands.**
  **Depends:** B04
  **Do:** `catalog skill new|rm|mv`. `new` writes the directory and a `SKILL.md` whose
  frontmatter `name` matches its path. `mv` moves the directory, rewrites `name`, and rewrites
  every `requires` that pointed at the old name. `rm` refuses while another skill requires it.
  **Done when:** A created skill parses with name↔path agreement and appears in `catalog dump`;
  an unregistered `--scope` exits 3 suggesting the nearest registered one; `mv` leaves no
  dangling `requires`; `rm` of a required skill exits 3 naming the requirer; the authored tree
  is still `skills/<namespace>/<name>/SKILL.md` and nothing else; `validate` passes after each.

- [ ] **B06 — MCP entity commands.**
  **Depends:** B05
  **Do:** `catalog mcp new|rm`, exactly one transport per `new`, `--env` repeatable. `rm`
  refuses while a skill requires `mcp.<name>`.
  **Done when:** Both transport kinds round-trip through the §3.3 parser with filename↔`name`
  agreement; giving neither or both transport flags exits 2 naming the supported kinds; `rm` of
  a required server exits 3 naming the requirer; `validate` passes after each.

- [ ] **B07 — `ambit catalog annotate`.**
  **Depends:** B06
  **Do:** Add and remove `scopes`, `requires`, and `env` entries on an existing skill or MCP,
  through the B02 editor.
  **Done when:** Lists emerge sorted and deduplicated; unknown frontmatter keys, comments, and
  the body survive; removing the last entry leaves an empty list, not a null; an unregistered
  scope or an unresolvable `requires` target exits 3 with nothing written; annotating twice is
  idempotent.

- [ ] **B08 — `ambit catalog tree`.**
  **Depends:** B07
  **Do:** Render the registry as a tree, each scope showing what it selects directly and what it
  selects by descent — the view that makes the §2 nest-vs-sibling decision visible before it is
  expensive to change.
  **Done when:** The fixture renders its nesting; direct and inherited counts are distinguished;
  a registered scope nothing declares shows as empty; `--json` is byte-stable and golden-filed.

- [ ] **B09 — `ambit catalog audit`.**
  **Depends:** B08
  **Do:** Report what no single file shows: registered scopes nothing declares, skills and MCPs
  reachable by neither scope nor `requires`, and MCPs no scope selects and no skill requires.
  Build the audit fixture with the authoring commands themselves, so the test doubles as a
  round-trip over B03–B07.
  **Done when:** Each class is reported against a fixture holding one of each; `--json` is
  stable; exit 0 by default, and `--check` exits 6 when anything was found.

### Shipping

- [ ] **A26 — dotagents compatibility test.**
  **Depends:** B09
  **Slice:** the compatibility promise becomes executable.
  **Done when:** A test installs the fixture catalog with `npx @sentry/dotagents` and
  asserts it succeeds, proving ambit's annotations don't break other tools; the same test
  passes against a catalog produced by `catalog init` plus `catalog skill new`, so ambit's own
  authored output is covered by the promise and not just the hand-written fixture. Runs in CI,
  and is allowed to be the one test that needs network.

- [ ] **A27 — Determinism suite.**
  **Depends:** A26
  **Done when:** Tests prove resolve is byte-stable across repeated runs and across shuffled
  filesystem read order.

- [ ] **A28 — README.**
  **Depends:** A27
  **Done when:** Covers the concepts, both file formats, the full CLI — consumer and authoring
  commands alike — and, prominently, the descendants-only rule with the sibling-vs-child
  modeling guidance from §2, since that's the thing catalog authors get wrong.

- [ ] **A29 — CI and npm publish.**
  **Depends:** A28
  **Done when:** CI runs lint, tests, and a build on every PR; a tagged release publishes to
  npm; `npx @<org>/ambit@latest --version` works from a clean machine.

---

## 9. Deliberately out of scope for v1

- Harness adapters beyond Claude Code. The interface exists; the implementations don't.
- Hooks management (dotagents has it; nothing here needs it yet).
- Any interactive prompting. ambit reads config and acts. Interviewing a human is a
  consuming tool's job.
- Version ranges or semver solving. Catalogs pin to a git ref; that's the whole model.
- Publishing a catalog — releasing it, versioning it, hosting it. The authoring commands (§6)
  edit a catalog in place; getting it onto a git host is git's job.
- Writing a skill's *content*. ambit scaffolds the file and maintains its annotations; what the
  instructions say is the author's judgement — exactly what ambit refuses to make.

## 10. How a consuming tool uses ambit

For context on the design, not a requirement on the build.

The first consumer is CosmOS, a company-wide agent workspace. Its onboarding flow is
conversational — it works out who someone is and which scopes they hold, which is exactly
the judgement ambit refuses to make. It then:

1. Reads `ambit scopes --json` to render a picker from the registry's descriptions.
2. Writes the person's answers into `ambit.yml` as a `scopes` list, always including the
   catalog's universal scope explicitly, since ambit adds nothing on its own.
3. Runs `ambit install`.
4. Reads `ambit resolve --explain --json` to tell the person what they got and why.
5. Runs `ambit doctor` to find missing credentials, then supplies its own guidance for
   obtaining each one — ambit reports *that* `CLOSE_API_KEY` is absent and who wants it, not
   where to get it.

Every state change is a deterministic CLI call. The AI supplies conversation; ambit supplies
the truth.
