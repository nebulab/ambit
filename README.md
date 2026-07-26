# ambit

A deterministic dependency manager for AI-agent capabilities: skills and MCP servers, selected by
scope.

Agent harnesses (Claude Code, Cursor, Codex) load _skills_ — folders of instructions — and connect to
_MCP servers_. Picking those by hand, per project, per person, does not scale past one person: a
designer and a backend engineer at the same company need overlapping-but-different sets, and nobody
wants to hand-maintain a config file per human.

ambit makes the selection declarative. A project declares the **scopes** it holds; skills and MCP
servers in a **catalog** declare which scopes they belong to; ambit resolves the two into a **bundle**
and writes it into the harness's config.

**ambit contains no AI.** It is a resolver and an installer — same inputs, same output, every time.
Anything requiring judgement (which scopes a person holds, what a skill should say) happens outside
and hands ambit a config file.

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [File formats](#file-formats)
- [Resolution](#resolution)
- [The selection rule](#the-selection-rule) — read this before you design a catalog
- [What install puts on disk](#what-install-puts-on-disk)
- [CLI reference](#cli-reference)
- [Determinism](#determinism)
- [Compatibility with plain skills repos](#compatibility-with-plain-skills-repos)
- [Not in scope](#not-in-scope)
- [Development](#development)

## Install

No install step. Node 20+ and `git` on `PATH` are the only requirements.

```
npx @nebulab/ambit --help
```

## Quick start

### Consuming a catalog

```
$ ambit init
created ambit.yml
next: add a catalog under `catalogs`, edit `scopes`, then run `ambit install`
```

The scaffolded `ambit.yml` holds `core` and no catalog, so `ambit install` on it is an honest failure
rather than a silently empty bundle — `core` is a convention no resolver knows, and the file's comments
say so. Point it at a catalog and list the scopes this project holds:

```yaml
version: 1
harnesses: [claude]

scopes:
  - core
  - function.engineering

catalogs:
  - name: company
    source: acme/skills
    ref: main
```

Then look before you leap, and install:

```
$ ambit scopes                 # what the catalog offers, and what this project holds
$ ambit resolve --explain      # what you would get, and why
$ ambit install                # write the lock, materialize the bundle, prune what left it
```

```
$ ambit install
harnesses (1)
  claude

artifacts (4)
  .claude/skills/acme.commons.use-house-style      skill-dir       link
  .claude/skills/acme.engineering.use-code-review  skill-dir       link
  .claude/skills/acme.engineering.use-storybook    skill-dir       link
  .mcp.json                                        harness-config  -
```

### Authoring a catalog

A catalog is a plain git repo. Scaffold one, register the scopes, then add skills and servers:

```
$ ambit catalog init --catalog acme-skills
created (5)
  .github/workflows/validate.yml
  README.md
  mcps/.gitkeep
  scopes.yml
  skills/.gitkeep

kept (0)
  (none)

next: register your scopes with `ambit catalog scope add`, then add a skill with `ambit catalog skill new`
```

```
$ ambit catalog scope add function.engineering --description "Building and shipping software"
registered (1)
  function.engineering  Building and shipping software

files (1)
  scopes.yml
```

```
$ ambit catalog skill new acme.engineering.use-code-review \
    --description "How we review code" \
    --scope function.engineering \
    --requires acme.commons.use-house-style
created (1)
  acme.engineering.use-code-review  How we review code

files (1)
  skills/acme/engineering/use-code-review/SKILL.md  created

next: write the skill's instructions in skills/acme/engineering/use-code-review/SKILL.md
```

ambit writes the file and maintains its annotations. What the instructions _say_ is your judgement —
exactly the judgement ambit refuses to make.

`ambit catalog init` also scaffolds a GitHub Actions workflow running `ambit validate`, so a catalog
repo is a CI'd repo from its first commit. It creates the root directory if it is missing — unlike
`ambit init`, which refuses one, because the scaffold creates directories regardless and
`--catalog acme-skills` is the ordinary first use. `scopes.yml` is what "already a catalog" means, and
it alone is refused; every other scaffolded file that already exists is left byte-identical and
reported as `kept`, since a catalog is normally initialized inside a repo that already has a README.

## Concepts

| Term                | Meaning                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**         | A source of skills and MCP definitions — a git repo or a local directory.                                                                            |
| **Skill**           | A directory containing `SKILL.md`. Its name is its path under `skills/` with `/` → `.`, so `skills/acme/sales/use-close/` is `acme.sales.use-close`. |
| **MCP entity**      | A server definition in the catalog's `mcps/` directory.                                                                                              |
| **Scope**           | A dotted, nestable label for _who needs a thing_: `function.engineering`, `project.vision-group`, `person.jane-doe`.                                 |
| **Project**         | A directory containing `ambit.yml`.                                                                                                                  |
| **Bundle**          | The resolved set of skills and MCP servers for a project.                                                                                            |
| **Harness adapter** | Code that writes a bundle into one agent tool's layout. v1 ships one: `claude`.                                                                      |
| **Owned artifact**  | A file or directory ambit created, recorded in `.ambit/state.json`. ambit never touches anything else.                                               |

A catalog looks like this:

```
acme-skills/
  scopes.yml                                    the scope registry
  skills/
    acme/commons/use-house-style/SKILL.md       skill acme.commons.use-house-style
    acme/engineering/use-code-review/SKILL.md   skill acme.engineering.use-code-review
  mcps/
    sentry.yml                                  MCP server "sentry"
```

## File formats

Everything is YAML — config, catalog metadata, the lockfile, and the skill frontmatter harnesses
already read. One format, one parser, one set of rules. (`.ambit/state.json` is the exception, and
is JSON for the reason given below.)

### `ambit.yml` — project config

At the project root. `ambit.yaml` is accepted; having both is an error.

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
    ref: "a1b2c3d4" # tag, branch, or commit. Quote it. Omit for the default branch.
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
    path: skills/readwise-cli # optional; overrides the name→path convention

# Ad-hoc MCP servers not defined in any catalog. Same shape as a catalog MCP entity.
mcps:
  - name: custom
    transport:
      stdio:
        command: npx
        args: ["-y", "some-server"]
    env: [SOME_TOKEN]
```

| Field       | Type                    | Required | Notes                                                                                                                                             |
| ----------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`   | int                     | yes      | Must be `1`.                                                                                                                                      |
| `harnesses` | string[]                | no       | Default `[claude]`.                                                                                                                               |
| `scopes`    | string[]                | no       | Held scopes, exactly as listed. Nothing is added implicitly. Absent or empty means nothing is selected by scope — only explicit `skills` entries. |
| `catalogs`  | list of maps            | no       | `name`, `source`, `ref?`. `name` unique.                                                                                                          |
| `skills`    | list of strings or maps | no       | String = a name from a catalog. Map = `name`, `source`, `ref?`, `path?`.                                                                          |
| `mcps`      | list of maps            | no       | Inline server definitions, in the shape below.                                                                                                    |

**Source formats:** `owner/repo`, `owner/repo@ref` (GitHub shorthand), `https://github.com/owner/repo`,
`git@host:owner/repo.git`, `git:<any-git-url>`, `path:./relative/dir`. A `@ref` shorthand that
contradicts the entry's own `ref` is an error rather than a silent winner.

### `SKILL.md` frontmatter — skill annotations

Annotations live under **one top-level key, `ambit:`**, alongside whatever the harness already uses.
Other tools ignore keys they do not know, so the whole of ambit's addition is one mapping they never
look inside.

```yaml
---
name: acme.sales.use-close
description: "Calls the Close CRM REST API…"
ambit:
  scopes: [function.sales]
  requires:
    - acme.commons.use-company-context
    - mcp.close
  env: [CLOSE_API_KEY]
---
```

| Key              | Type     | Required | Notes                                                                                            |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------------------------------ |
| `ambit`          | map      | no       | Every annotation below. Absent means the skill declares nothing.                                 |
| `ambit.scopes`   | string[] | no       | Absent or empty = never selected by scope; reachable only via `requires` or an explicit listing. |
| `ambit.requires` | string[] | no       | Skill names, or MCP names prefixed `mcp.`.                                                       |
| `ambit.env`      | string[] | no       | Env vars the skill itself reads (not via an MCP).                                                |

`name` and `description` are the harness's own keys. ambit reads `name` and requires it to match the
directory path.

**One key, so nothing can collide.** A harness that one day defines its own `scopes` or `requires`
takes the top-level name and ambit's stay a level down, where they always were. The cost is a line of
nesting and it buys the guarantee outright.

**Unknown keys go two ways, deliberately.** At the top level they are kept: that block is the
harness's and ambit is a guest in it. Under `ambit:` they are rejected: that block is ambit's, so a
misspelled `scope:` is an error rather than a skill that declares nothing and warns nobody.

`ambit.yml`, `mcps/<name>.yml`, and `scopes.yml` are ambit's own documents end to end and are
**not** namespaced — they hold no other tool's keys to collide with.

### `mcps/<name>.yml` — MCP entities

```yaml
name: sentry
scopes: [function.engineering]

transport:
  http:
    url: https://mcp.sentry.dev/mcp
    headers:
      Authorization: "Bearer ${SENTRY_TOKEN}"

# or, for a locally-spawned server:
# transport:
#   stdio:
#     command: npx
#     args: ["-y", "@acme/close-mcp"]

env: [SENTRY_TOKEN]
```

| Key                       | Type     | Required      | Notes                                                               |
| ------------------------- | -------- | ------------- | ------------------------------------------------------------------- |
| `name`                    | string   | yes           | Must match the filename stem. `.yml` and `.yaml` are both accepted. |
| `scopes`                  | string[] | no            | Same semantics as skills.                                           |
| `transport`               | map      | yes           | Exactly one key, naming the kind: `stdio` or `http`.                |
| `transport.stdio.command` | string   | yes for stdio | Executable to spawn.                                                |
| `transport.stdio.args`    | string[] | no            | Arguments, in order.                                                |
| `transport.http.url`      | string   | yes for http  | Server endpoint.                                                    |
| `transport.http.headers`  | map      | no            | `${VAR}` interpolated from the environment at install.              |
| `env`                     | string[] | no            | Env vars this server needs.                                         |

`transport` must contain **exactly one** key. Zero keys, two keys, or an unrecognized kind is an error
naming the supported kinds — it is the discriminator, so it must never be ambiguous. Keeping the kind
as a nested key rather than a `type:` field scopes each kind's fields to it, so a future kind (sse,
websocket) adds nothing to the top level.

**A server is installed if its scopes match, or a selected skill requires it.** Both paths are needed:
some servers are worth having because of who you are, with no skill involved; others must follow a
skill into the bundle even when their scopes differ.

### `scopes.yml` — the catalog's scope registry

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

Every scope a skill or MCP declares must be registered here, so a typo fails loudly instead of
silently matching nothing. The registry is also the human-readable list a consuming tool renders as a
picker, so descriptions are not optional decoration.

### `ambit.lock` — the resolution result

Generated YAML, written by `install`. Commit it when a team wants reproducible installs; gitignore it
when config is per-person. Sorted keys, no timestamps, byte-stable.

```yaml
catalogs:
  company:
    source: path:../acme-skills
mcps:
  sentry:
    catalog: company
    reason: required-by:acme.engineering.use-code-review
skills:
  acme.commons.use-house-style:
    catalog: company
    path: skills/acme/commons/use-house-style
    reason: scope:core
  acme.engineering.use-code-review:
    catalog: company
    path: skills/acme/engineering/use-code-review
    reason: scope:function.engineering
version: 1
```

Nothing parses the lock: `install --frozen` compares its **bytes** against what resolving now would
produce, which is why nothing about it can drift out of sync with the resolver. A git-sourced catalog
also records the `commit` its `ref` resolved to.

The lock records no materialization mode — whether a skill was copied or linked is a per-run choice,
not part of a resolution.

### `.ambit/state.json` — what is actually on disk

Generated, always gitignored, machine-local, and **JSON rather than YAML**: nothing reads it by hand,
and JSON's single unambiguous serialization is what a crash-safety record wants.

It lists every **owned artifact** by project-relative path. This is what makes pruning safe — ambit
deletes only what this file says it created.

```json
{
  "artifacts": [
    {
      "kind": "skill-dir",
      "mode": "link",
      "path": ".claude/skills/acme.commons.use-house-style"
    },
    {
      "kind": "harness-config",
      "managedKeys": ["mcpServers.sentry"],
      "path": ".mcp.json"
    }
  ],
  "harnesses": ["claude"],
  "version": 1
}
```

### YAML rules

These are not stylistic. Getting them wrong produces silent, hard-to-trace corruption, so ambit
refuses instead.

- **Core schema only** (YAML 1.2, the `yaml` package). No custom tags, no arbitrary type resolution.
- **Everything that identifies something is a string.** Git refs are the trap: `1234567` parses as an
  integer and `1e5` as a float. A value arriving as a number or boolean where a string is required is
  an error, not a silent `String()`. Quote your refs.
- **Duplicate keys are an error**, naming the key and both line numbers — most parsers keep the last
  one silently.
- **Tabs are an error**, reported as "YAML does not permit tabs for indentation" with the line number.
- **An empty file, or a document that is not a mapping**, is an error rather than an empty config.
- **`null` is not "missing".** An explicitly null value where a value is required is an error; absent
  keys take their defaults.
- **Everything ambit emits** has sorted keys, quotes strings that could otherwise coerce, uses no
  anchors or aliases, and is byte-stable across runs.

## Resolution

1. **Load and validate config.** Malformed → exit 2 naming the field.
2. **Fetch catalogs**, each into the local cache, at its `ref`, resolved to a commit SHA.
3. **Parse each catalog:** `scopes.yml`, every `skills/**/SKILL.md`, every `mcps/*.yml`. A skill whose
   frontmatter `name` disagrees with its directory path is an error.
4. **Merge registries** across catalogs. The same scope declared twice with identical descriptions
   merges silently; differing descriptions → exit 3 naming both catalogs.
5. **Merge catalogs.** On a duplicate skill or MCP name the earlier catalog in config order wins, and
   the shadowing is recorded so `resolve --explain` and `validate` can report it.
6. **Expand held scopes.** For each held scope `s`, every registered scope equal to `s` or beginning
   with `s + "."`. A held scope absent from the merged registry → exit 3, suggesting the nearest
   registered scope by edit distance.
7. **Select by scope.** Any skill or MCP with at least one declared scope in the expanded set.
8. **Add explicit entries** from the config's `skills` and `mcps`.
9. **Close over `requires`** to a fixpoint. `mcp.`-prefixed targets resolve against MCP entities,
   everything else against skills. Unresolvable → exit 3 naming the requirer and the missing target. A
   cycle → exit 3 printing the full cycle path.
10. **Union `env`** across every selected skill and server.
11. **Emit the bundle**, sorted by name.

A config `skills` or `mcps` entry whose name a catalog also provides is an error (exit 3), not a
precedence question. First-wins applies between catalogs and nowhere else.

### Validation split

- `ambit resolve` and `ambit install` hard-validate only the **selected closure**, so one broken
  unrelated skill does not block everyone.
- `ambit validate` validates the **entire catalog** — every scope registered, every `requires` target
  resolvable, no cycles, no name shadowing, every skill name matching its path. This is the CI command
  for catalog repos.
- `ambit catalog audit` is the report about a catalog's _health_ where `validate` is the report about
  its _validity_: dead scopes and unreachable items. The two deliberately do not learn each other's
  findings, so a catalog can be perfectly valid and still be reported as untidy.

## The selection rule

**A held scope selects itself and every scope beneath it. Descendants only.**

Holding `function.engineering` selects things scoped `function.engineering` _and_
`function.engineering.frontend`. Holding `function.engineering.frontend` selects only that subtree —
it does **not** reach up to `function.engineering`.

That single rule is the whole resolver, and it makes the shape of your scope tree load-bearing:

```
$ ambit catalog tree
scopes (3)
  core                             1 direct  0 inherited  The universal floor — what everyone here needs
  function.engineering             1 direct  1 inherited  Building and shipping software
    function.engineering.frontend  1 direct  0 inherited  Browser-side work
```

A project holding `function.engineering` gets both engineering skills — one directly, one inherited
from the child scope:

```
$ ambit resolve --explain
scopes (2)
  core
  function.engineering

skills (3)
  acme.commons.use-house-style      company  scope:core
  acme.engineering.use-code-review  company  scope:function.engineering
  acme.engineering.use-storybook    company  scope:function.engineering.frontend
```

A project holding only the child gets only the child:

```
$ ambit resolve
scopes (1)
  function.engineering.frontend

skills (1)
  acme.engineering.use-storybook  company
```

### Nest or make siblings?

This is the decision catalog authors get wrong, and the only fix is restructuring the tree — which
means every project's `ambit.yml` has to be edited to match. Get it right first.

- **Nest** only when selecting the parent genuinely implies wanting _every_ child. Everyone doing
  engineering work should have the frontend conventions too? Then `function.engineering.frontend` is a
  child of `function.engineering`.
- **Make siblings** of anything people pick independently. If some engineers want the frontend set and
  some want the backend set and nobody wants both, they are siblings — `discipline.frontend` and
  `discipline.backend` — with no parent that selects them together.

The test to apply to any candidate parent: _would I be annoyed to receive everything under this?_ If
yes, the children belong somewhere else.

Two corollaries worth internalising:

- **A scope with no children is a leaf you can always split later.** Adding
  `function.engineering.frontend` under an existing `function.engineering` is backwards-compatible —
  every project already holding the parent picks the new child up automatically. Splitting a parent
  _apart_ into siblings is not.
- **There is no "select the parent from the child" escape hatch.** If a skill is genuinely needed by
  both `function.engineering` and `function.design`, give it both scopes. `scopes` is a list.

### Nothing is implicit

**ambit reserves no scope names.** A project gets exactly the scopes it lists. Catalogs conventionally
use `core` for the universal floor, but that is a naming convention, not a rule the resolver knows,
and a project that wants it must say so.

The tradeoff is deliberate: someone who writes `scopes: [function.sales]` and forgets `core` gets a
bundle with no company context and no house style, and nothing warns them. That is the cost of a
resolver with no special cases. Two things soften it — `ambit init` scaffolds `core` into the starter
config with a comment explaining why, and a consuming tool that writes `ambit.yml` should always write
the universal scope explicitly.

A scope a project holds but the catalog never registered is an error, not a silent miss:

```
$ ambit resolve
error: unknown scope "function.enginering" (ambit.yml line 4)
       not found in the merged registry
       did you mean "function.engineering"?
```

## What install puts on disk

### Skills → `.claude/skills/<name>/`

- **Remote-source skills are copied.** They are pinned to a commit and immutable.
- **`path:` local-source skills are symlinked**, so editing the installed skill edits the tracked
  source rather than a stale duplicate. Links are relative, so a project and its catalog move
  together and no absolute path lands in the working tree.
- `--copy` and `--link` override that per run. They are mutually exclusive. Nothing persists the
  choice; it is not a config key.

```
$ ls -l .claude/skills
acme.commons.use-house-style -> ../../../acme-skills/skills/acme/commons/use-house-style
```

Because a linked skill _is_ the catalog's copy, editing one is never drift. Content drift is only a
question about a copy — and there, `status` compares the copy against its source, so it reports
upstream change as well as local edits.

### MCP servers → `.mcp.json`

Each entity's `transport` maps onto the harness's own server shape — `stdio` to `command`/`args`,
`http` to `url`/`headers`:

```json
{
  "mcpServers": {
    "sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${SENTRY_TOKEN}"
      }
    }
  }
}
```

`.mcp.json` is **co-owned**: ambit owns only the server keys it wrote, recorded per key in state.
Servers you added by hand are preserved untouched, and only a colliding server _name_ is a conflict.

`${VAR}` in `headers` is interpolated from the environment at install time. A missing variable leaves
its placeholder rather than emptying the value — a warning, not a failure, because a bundle you cannot
authenticate against yet is still the right bundle. `ambit doctor` is what reports it, and fails.

### `.gitignore`

ambit rewrites a delimited managed block in place, listing `.ambit/` and every installed skill path:

```
# BEGIN ambit - managed block, rewritten by `ambit install`; edits are lost
.ambit/
.claude/skills/acme.commons.use-house-style
.claude/skills/acme.engineering.use-code-review
# END ambit
```

Never `ambit.lock` and never `.mcp.json` — both are files a team may want to commit. Skill paths carry
no trailing slash on purpose: git does not match a `dir/` pattern against a symlink, and a linked skill
would stay tracked.

Two shapes are refused (exit 2, file left byte-identical): more than one `# BEGIN ambit` line, and a
begin marker with no `# END ambit` after it.

### Ownership — the safety core

1. ambit deletes or overwrites **only** paths `.ambit/state.json` lists as owned.
2. If a target path exists and is not owned, ambit **stops** rather than clobbering it:

```
$ ambit install
error: refusing to overwrite unowned path
       .claude/skills/acme.commons.use-house-style exists but ambit did not create it
       move it aside, or run `ambit install --adopt` to take ownership
```

3. `install` **prunes**: owned artifacts absent from the new bundle are removed, then state is
   rewritten. Narrow a project's scopes and the skills that left the bundle leave the disk.
4. State is written **after** the filesystem changes succeed, so a crash leaves artifacts owned and
   recoverable rather than orphaned.

The cost of rule 4 is worth knowing: a run that crashed mid-apply leaves artifacts present but
_unowned_, so the next plain `install` refuses them. `status` reports them as `unowned` and `doctor`
names `--adopt`.

### Cache and offline

Git catalogs are bare-cloned into `$XDG_CACHE_HOME/ambit/` (falling back to `~/.cache/ambit/`), keyed
by host/owner/repo, and fetched on demand. A cached clone is refetched only when it cannot answer the
ref, so `ref: main` pins to the commit first seen — reproducibility comes from the lock, not from the
network.

`--offline` refuses the clone and the fetch and nothing else, failing with exit 4 naming what the cache
is missing. `path:` sources never consult the cache at all. Nothing ambit does removes anything from
the cache, `clean` included.

## CLI reference

### Global flags

| Flag              | Notes                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--project <dir>` | The project to act on. Default: cwd. On consumer commands.                                                                 |
| `--catalog <dir>` | The catalog root to act on. Default: cwd. On authoring commands.                                                           |
| `--json`          | Machine-readable output. Every command supports it.                                                                        |
| `--offline`       | Resolve from the cache alone. On consumer commands only — an authoring command reads one directory and resolves no source. |
| `--dry-run`       | On mutating commands: report what would happen and touch nothing.                                                          |
| `--help`          | Usage for the program or for any command, at any depth, on stdout at exit 0.                                               |
| `--version`       | Print the ambit version. Program-level.                                                                                    |

`--dry-run` still checks ownership and `--frozen`: a preview of an install that would be refused is
refused, with the same message and exit code, because "what would happen" includes stopping.

### Consumer commands

| Command                                               | What it does                                                                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ambit init`                                          | Scaffold an `ambit.yml`. Refuses a directory that already has one, `--dry-run` included, and does not create a missing directory.                                  |
| `ambit scopes`                                        | List the merged registry with descriptions, marking which scopes this project holds.                                                                               |
| `ambit catalog`                                       | Dump the merged catalog. (`ambit catalog dump` is the same command.)                                                                                               |
| `ambit resolve [--explain]`                           | Compute the bundle and print it.                                                                                                                                   |
| `ambit why <name>`                                    | Explain why one item is in the bundle, as a chain. A skill wins a bare name; `mcp.<name>` insists on a server, and a bare name no skill answers falls back to one. |
| `ambit install [--frozen] [--adopt] [--copy\|--link]` | Resolve, write `ambit.lock`, materialize the bundle, prune what left it.                                                                                           |
| `ambit status [--check]`                              | Compare what is installed against what resolve produces. `--check` exits 5 on drift.                                                                               |
| `ambit prune`                                         | Remove owned artifacts not in the current bundle.                                                                                                                  |
| `ambit clean`                                         | Remove everything ambit owns.                                                                                                                                      |
| `ambit validate [--catalog DIR]`                      | Full-catalog validation, for CI.                                                                                                                                   |
| `ambit doctor`                                        | Check env vars, the lock, ownership, drift, and materialization mode.                                                                                              |

`--explain` annotates each item with why it was selected: `scope:function.sales`,
`required-by:acme.sales.use-close`, `explicit`, or `catalog:company (shadows personal)`.

`--frozen` fails if resolution would change `ambit.lock` — the CI check that a committed lock is
current:

```
$ ambit install --frozen
error: ambit.lock is out of date
       resolving this project produces a different ambit.lock than the one on disk
       run `ambit install` without `--frozen`, then commit the result
```

`ambit status` answers exactly one question — would `ambit install` change this? Every row is one
artifact in one of five states (`missing`, `modified`, `ok`, `stale`, `unowned`):

```
$ ambit status --check
artifacts (4)
  .claude/skills/acme.commons.use-house-style      skill-dir       ok
  .claude/skills/acme.engineering.use-code-review  skill-dir       ok
  .claude/skills/acme.engineering.use-storybook    skill-dir       missing  nothing is installed at this path
  .mcp.json                                        harness-config  ok
```

`ambit doctor` runs five checks in a fixed order and reports two severities. Only a failure reaches
exit 6; a warning exits 0:

```
$ ambit doctor
checks (5)
  env        fail
  lock       ok
  ownership  ok
  drift      ok
  mode       ok

failures (1)
  unset environment variable "SENTRY_TOKEN"
      MCP server "sentry" declares it in `env`
      "mcpServers.sentry" in .mcp.json still holds its `${SENTRY_TOKEN}` placeholder
      set SENTRY_TOKEN, then run `ambit install` again so the placeholder is interpolated

warnings (0)
  (none)
```

Mode divergence is the only warning: a project installed with `--copy` reports warnings and still
passes, because both modes put identical bytes in front of the harness.

`ambit prune` and `ambit clean` are the two narrow commands. `prune` writes nothing at all when nothing
is stale — not even state — so pruning an untouched project cannot create the records of an install
that never happened. `clean` resolves nothing: it answers from `.ambit/state.json` alone, so it works
on the project you actually reach for it with, `ambit.yml` deleted or catalog unreachable.

Both leave behind what ambit does not own: a `.mcp.json` left holding an empty `mcpServers` (the
document is co-owned) and the harness's own `.claude/skills` directory. `clean` also leaves
`ambit.lock` — a record teams commit, not an artifact ambit deletes. A `prune` that removed something
_rewrites_ the lock to the bundle it just resolved, the same bytes `install` would write, so the
project it leaves behind passes `doctor` and `install --frozen` rather than reporting drift from the
change it had just carried out. A prune with nothing stale writes nothing, lock included.

### Authoring commands

Consumer commands serve someone _using_ a catalog; these serve someone _maintaining_ one. The split
matters because the two act on different directories: consumer commands take `--project <dir>` and read
`ambit.yml`, authoring commands take `--catalog <dir>` and read the catalog root. A catalog is not a
project and has no `ambit.yml`.

```
ambit catalog init                              scaffold a catalog repo
ambit catalog tree [--json]                     the scope tree, and what each scope selects
ambit catalog audit [--check]                   find dead scopes and unreachable items

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

List-valued flags are repeatable rather than comma-separated (`--scope a --scope b`): a scope name can
hold a comma far more easily than an argv entry can.

**Rules every authoring command obeys.** These are what make editing a catalog as deterministic as
resolving one:

1. **Never break the plain skills repo.** Authored output stays readable by any tool that derives a
   name from a path.
2. **Surgical edits.** Changing an annotation preserves comments, unknown keys, the order of keys ambit
   did not touch, and the markdown body **byte-for-byte**. A catalog is hand-maintained; a tool that
   reformats it on every edit is a tool nobody runs twice. An edit that would change no bytes writes
   nothing at all — not even an mtime.
3. **Sorted, quoted, byte-stable output** wherever ambit owns the shape of a document. A list ambit
   rewrites comes out sorted and deduplicated, because argv order is not information — with one
   deliberate exception, a stdio transport's `args`, which is nothing _but_ order.
4. **Validate before writing, not after.** Every mutation runs the `validate` checks against the
   _result_ and refuses to write if they fail — exit 3, every file left byte-identical. A mutation
   cannot leave a catalog broken. The corollary is that a pre-existing problem anywhere in a catalog
   blocks every mutation until it is fixed.
5. **Atomic writes**, and never a path outside the catalog root — exit 2, naming the path.
6. **`--dry-run` prints the diff** it would write and touches nothing:

```
$ ambit catalog annotate acme.engineering.use-storybook --add-env STORYBOOK_TOKEN --dry-run
skill acme.engineering.use-storybook

would declare (3)
  scopes    function.engineering.frontend
  requires  -
  env       STORYBOOK_TOKEN

diff (1)
  skills/acme/engineering/use-storybook/SKILL.md (updated)
    ...
      name: acme.engineering.use-storybook
      ambit:
        scopes:
          - function.engineering.frontend
    +   env:
    +     - STORYBOOK_TOKEN
      ---

      # acme.engineering.use-storybook
    ...
```

The three verbs are deliberately not symmetric. `scope add` **registers, it does not reword** — a name
the registry already holds is refused (exit 3, nothing written), because overwriting the entry would
redefine a scope every project holding it already names. No command rewords a registered scope, so the
refusal tells you to edit that entry's `description` in `scopes.yml` by hand. `scope rm` unregisters
one entry, never a descendant, and refuses while any skill or server still declares it, naming every
declarer with its file. `scope mv` renames the scope **and its whole registered subtree**, rewriting
every declarer in the same edit — because a rename has to move exactly the scopes a held one would
reach, or renaming would silently change what holding a scope selects. It closes by telling you to
update each project's `ambit.yml`, since a catalog command edits none.

`skill mv` moves the directory with `rename`, so a skill's `references/logo.png` survives, and rewrites
the moved document's `name` and every `requires` naming the old name in the same edit. Neither `rm` nor
`mv` will touch a skill directory that holds another skill.

`ambit catalog audit` finds what no profile can reach. Reachability is transitive over `requires`, so a
skill required only by an unreachable skill is itself unreachable, and a scope is dead only when its
whole registered subtree selects nothing:

```
$ ambit catalog audit
audited 4 scopes, 4 skills, 1 mcp

findings (2)
  unused scope "person.jane" (scopes.yml)
      no skill and no MCP server declares it, and nothing registered beneath it does either
      holding it selects nothing, so every picker rendering this registry offers a choice with no effect
      declare it with `ambit catalog annotate <name> --add-scope person.jane`, or unregister it with `ambit catalog scope rm person.jane`
  unreachable skill "acme.labs.use-scratch" (skills/acme/labs/use-scratch/SKILL.md)
      it declares no registered scope, and nothing reachable requires it
      no profile can select it, so nothing it says ever reaches an agent
      give it a scope with `ambit catalog annotate acme.labs.use-scratch --add-scope <scope>`, or remove it with `ambit catalog skill rm acme.labs.use-scratch`
```

Plain `audit` exits 0 however much it found — a report that broke a build by existing is a report
nobody adds to CI. `--check` is what turns findings into exit 6.

Because `audit` judges one catalog directory, it cannot see a project: an item some project lists
explicitly in `skills`, or one another catalog's skill requires, is reachable there and still reported
here. That is the honest answer for a catalog repo's own CI.

### Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | Success                                                                              |
| 1    | Unexpected internal error                                                            |
| 2    | Config or ownership error                                                            |
| 3    | Resolution error — unknown scope, missing requirement, cycle, name conflict          |
| 4    | Network or cache error                                                               |
| 5    | Drift detected (`status --check`, `install --frozen`)                                |
| 6    | A health check found something (`doctor` failures, `catalog audit --check` findings) |

A usage error — an unknown flag, a missing argument — is exit 2 at any depth.

### Error messages

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

`validate`, `status --check`, `doctor` and `catalog audit --check` are the four commands that _report_
rather than throw: their findings go to stdout, so `--json` stays parseable, and the non-zero code
travels out beside a full report instead of stopping at the first problem.

## Determinism

Resolving twice produces byte-identical output. Resolving with a shuffled filesystem read order
produces identical output. That is a tested property, not an aspiration: every collection is sorted
before iteration, no output depends on object key order, and no report ambit prints or file ambit
generates carries a timestamp, a clock time, or an absolute path from the machine it ran on.

The last of those is load-bearing for the goldens and for anything that pipes ambit's `--json` around:
a catalog's location on disk is machine-specific, so it appears in no report and in no lock. (An error
message may still name an absolute path — that is where naming the exact file is the whole point.)

## Compatibility with plain skills repos

**A catalog is a plain skills repo.** Skills live at `skills/<namespace>/<name>/SKILL.md` with the name
derived from the path, which is exactly what dotagents, skills.sh, and anything else in this shape
expect. ambit's additions — one `ambit:` frontmatter key, a `mcps/` directory, a `scopes.yml` — are
additive and ignored by other tools.

This is a hard requirement, not a nice-to-have, and it is enforced by a test rather than asserted in
prose: `test/dotagents.test.ts` runs `npx @sentry/dotagents install` against a catalog and checks that
dotagents installs exactly the skills ambit's own parser finds, under exactly the names ambit derives,
with every `SKILL.md` byte-identical. It runs against the hand-written fixture catalog _and_ against
one produced by `ambit catalog init` plus `ambit catalog skill new`, so ambit's own authored output is
covered by the promise too. The package is deliberately unpinned: the promise is about the release
people actually have.

That test is the one thing in the suite allowed to touch the network. It skips with a printed reason
when the registry is unreachable outside CI, and fails inside it.

ambit **replaces** dotagents rather than wrapping it. dotagents' model — a flat, hand-listed set of
skills — cannot express scope-driven selection, and three of its behaviours fight this design:
`install` does not prune skills removed from config; `sync` adopts orphaned skills back into the
lockfile, so deselecting something and syncing brings it back; and local path skills are copied, so
the file the agent reads is a stale duplicate of the tracked source. ambit fixes all three by owning
the install path — real pruning, strict ownership, and symlinks for local sources.

## Development

```
npm install
npm test          # vitest, offline apart from the one compatibility test
npm run typecheck
npm run lint
npm run format    # prettier --write; `format:check` is the CI variant
npm run build
```

Those five are what CI runs, so a green local run is the whole story. Formatting is Prettier's
decision and not worth discussing in review — `prettier.config.js` sets one option and takes every
other default. `test/golden/` is deliberately exempt: those files are recorded program output, and
formatting them would assert Prettier's JSON style instead of ambit's.

`test/golden/` holds the golden files; regenerate them with `UPDATE_GOLDEN=1 npm test` and read the
diff. `npm run fixture` builds the fixture catalog the suite resolves against.

`AMBIT_SKIP_NETWORK_TESTS=1` skips the dotagents compatibility test without probing the registry.

The build specification that guided this codebase was `PLAN.md`, retired once this README covered
the same ground; `git log -- PLAN.md` still has it.

### Source layout

`src/` is grouped into dependency layers, and every import points strictly down this list — a module
may only reach for things below it:

```
errors.ts, version.ts   ambient: the error type, the exit codes, the version
model/                  what is on disk and how it is read and written; decides nothing
resolution/             derive and verify the selected closure
harness/                the adapter seam and its implementations
authoring/              the `ambit catalog …` command family
project/                act on a consuming project
cli/                    presentation and dispatch — Commander wiring and one handler per command
```

`authoring/` and `project/` never import each other: curating a catalog and installing into a project
are the two halves of the tool, and they meet only at `model/` and `resolution/`. The layering is
enforced by `no-restricted-imports` in `eslint.config.js`, not by convention.

`cli.ts` and `index.ts` stay at the root because they are the two build entry points — the bin and
the library. `test/` mirrors the same structure.

## License

MIT
