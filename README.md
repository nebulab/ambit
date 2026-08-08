# ambit

ambit is a dependency manager for your AI agent's harness.

All agent harnesses (Claude Code, Codex, Cursor, opencode, etc.) load skills, hooks, and MCP servers.
ambit makes picking them declarative:

1. An ambit catalog is a directory of skills, hooks and MCP servers, each named by its path — plus
   **packs**, which are named groups of the other three.
2. An ambit project declares the catalogs it draws from and, per catalog, what it selects: a pack, or
   an individual skill, server or hook, by name or by glob.
3. ambit resolves those into a bundle and writes it into your harness's configuration.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [File formats](#file-formats)
- [Resolution](#resolution)
- [Staying up to date](#staying-up-to-date)
- [CLI reference](#cli-reference)
- [Development](#development)
- [License](#license)

## Install

No install step. Node 20+ and `git` on `PATH` are the only requirements.

```
npx @nebulab/ambit --help
```

## Quick start

### Scaffolding a project

Every ambit project is also a catalog — a project that ships a skill of its own puts it in `skills/`
and lists itself — so one command scaffolds both halves:

```
$ ambit init
created (5)
  ambit.yml
  hooks/.gitkeep
  mcps/.gitkeep
  packs/.gitkeep
  skills/.gitkeep

kept (0)
  (none)

next: put a skill in `skills/<name>/SKILL.md`, or add a catalog under `catalogs`
      then uncomment a `requires` entry that selects it, and run `ambit install`
```

The `ambit.yml` it writes lists the project itself as a catalog:

```yaml
catalogs:
  - name: local
    source: path:. # this project's own packs/, skills/, mcps/, hooks/
```

That entry is live; the `requires` entries selecting it are scaffolded **commented out**, because an
entry matching nothing is exit 3 and a fresh project's `local` catalog is four empty directories.
Uncomment them once there is something to take.

An existing `ambit.yml` is refused, and so is a project directory that does not exist — `--project`
naming the wrong path should not leave a project where nobody meant one. An existing `.gitkeep` is
left byte-identical and reported as `kept`.

### Authoring a catalog

A catalog is a plain git repo, and a catalog is a directory: four item directories, and no config
file of its own. `ambit init` scaffolds one; write its contents with your editor.

Add a skill by writing `skills/<name>/SKILL.md`, a server by writing `mcps/<name>.yml`, a hook by
writing `hooks/<name>/hook.yml`. Every format is documented below, and `ambit validate` checks the
result. There is no command that writes into a catalog: it is Markdown and YAML, and you have an
editor.

Then group them. A **pack** is a fourth kind of capability whose only job is to pull in the other
three:

```yaml
# packs/function/engineering.yml
name: function.engineering
description: Everything an Acme engineer needs — reviews, tooling, and the guards around them.

requires:
  - pack: core
  - skill: code-review
  - mcp: linter
  - hook: guard-secrets
```

A pack ships no bytes and installs nowhere. What it does is give a grouping a **name in the catalog**
— so `ambit search` can list it, it carries a description saying what it is for, and a
`requires` entry naming one that does not exist fails the install rather than reaching nobody. A pack
may require other packs, which is how a large grouping is built out of small ones.

That is deliberately the author's call rather than the consumer's. The free-form labels this replaced
let a consumer invent a grouping the catalog had never blessed; a pack does not. The catalog decides
what `function.engineering` means, in one place, and a consumer who wants a different set writes the
entries for it or asks the catalog for a pack.

### Consuming a catalog

The scaffold selects nothing, so `ambit install` installs nothing until you point it at a catalog.
Add one and say what to take from it:

```yaml
version: 1
harnesses: [claude]

catalogs:
  - name: company
    source: acme/skills
    ref: main

requires:
  - pack: "company/function.engineering" # everything that pack names, transitively
  - skill: "company/core.*" # everything beneath the `core` name prefix
```

Then:

```
$ ambit search "*"             # everything the catalogs offer, whether you selected it or not
$ ambit resolve --explain      # what you would get, and why
$ ambit install                # write the lock, materialize the bundle, prune what left it
$ ambit outdated               # has any catalog moved, and would it change anything?
```

```
$ ambit install
harnesses (1)
  claude

artifacts (5)
  .agents/skills/house-style  skill-dir       link
  .agents/skills/code-review  skill-dir       link
  .agents/skills/storybook    skill-dir       link
  .claude/skills              skills-link     link
  .mcp.json                   harness-config  -
```

### Finding what to select

`ambit search` is how you find the name to put in `requires`. Its `<pattern>` is the same glob a
`requires` entry is written with, so what you typed to find an item is what selects it:

```
$ ambit search --capability pack "*"       # every grouping the catalogs named
$ ambit search --capability skill "core.*" # skills beneath the `core` prefix
$ ambit search --catalog company "*lint*"  # one catalog, anything with `lint` in the name
```

Repeating a flag widens (`--catalog a --catalog b` means _either_); different flags narrow, so the
three above are read together when all three are given. A pattern that matches nothing prints an
empty report and exits 0 — unlike the same pattern in a `requires` entry, which is exit 3, because a
requirement reaching nothing is a config that will not do what it says.

### Checking it in CI

`ambit validate` is the check worth running on every push: it reads every catalog the project lists —
including the project's own `packs/`, `skills/`, `mcps/` and `hooks/` — and reports every `requires`
entry that matches nothing, every `requires` cycle, every item whose declared name disagrees with its
path, and every catalog it fetches and then selects nothing from. Catching those here is the point: a broken
catalog otherwise fails for whoever installs it next, which is never the person who broke it.

`ambit init` deliberately scaffolds no workflow — a project is routinely an existing application, and
writing into its `.github/workflows/` is presumptuous. Paste this into
`.github/workflows/ambit.yml` instead:

```yaml
name: ambit
on: [push, pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Check out the project
        uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Validate
        run: npx --yes @nebulab/ambit validate
```

Add `ambit status --check` beside it to fail on drift between `ambit.lock` and what is installed, or
`ambit install --frozen` to fail when resolution would rewrite the lock.

## Concepts

| Term                | Meaning                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**         | A source of packs, skills, MCP definitions and hooks: a git repo or a local directory.                                                                                                                                |
| **Skill**           | A directory containing `SKILL.md`. Its name is its path under `skills/`, so `skills/close-crm/` is `close-crm`. A nested directory joins its segments with `.`.                                                       |
| **MCP entity**      | A server definition in the catalog's `mcps/` directory.                                                                                                                                                               |
| **Hook**            | A directory containing `hook.yml` (lowercase — ambit is its only reader), named from its path under `hooks/` the way a skill is. It runs a command on one harness event.                                              |
| **Pack**            | A `requires` list with a name and a description, at `packs/<name>.yml`. It ships no bytes and installs nowhere: what it does is name a group of the other three, so one entry takes the lot. Packs may require packs. |
| **Entry**           | One member of a `requires` list, in a project or in a catalog: one key naming a namespace (`pack`, `skill`, `mcp`, `hook`), carrying the glob to match names in it.                                                   |
| **Project**         | A directory containing `ambit.yml`.                                                                                                                                                                                   |
| **Bundle**          | The resolved set of packs, skills, MCP servers and hooks for a project.                                                                                                                                               |
| **Harness adapter** | Code that writes a bundle into one agent tool's layout: `claude`, `codex`, `cursor`, `opencode`, `vscode`.                                                                                                            |
| **Owned artifact**  | A file or directory ambit created, recorded in `.ambit/state.json`. ambit never touches anything else.                                                                                                                |

## File formats

### `ambit.yml`: project config

```yaml
version: 1
harnesses: [claude]

# Catalogs. The order carries no meaning: every catalog's items are addressable,
# and none takes precedence over another.
catalogs:
  - name: company
    source: git@github.com:acme/skills.git
    ref: "a1b2c3d4" # tag, branch, or commit. Quote it. Omit for the default branch.
  - name: personal
    source: git@github.com:jane/skills-private.git
    ref: main

# What this project selects. Nothing is implicit: an item no entry reaches is not
# installed. Each entry is one key naming a namespace — `pack`, `skill`, `mcp`,
# `hook` — carrying the glob to match names in it. An address is
# `<catalog>/<pattern>`, where the catalog is an alias from `catalogs:` above.
requires:
  - pack: "company/function.engineering" # everything that pack names, transitively
  - skill: "company/core.*" # everything beneath the `core` name prefix
  - skill: "personal/luma" # one skill, exactly
  - hook: "company/guards.*"
```

Every definition lives in a file a catalog holds: a skill in `skills/<name>/SKILL.md`, a server in
`mcps/<name>.yml`, a hook in `hooks/<name>/hook.yml`, a pack in `packs/<name>.yml`. A project that
ships one of its own puts it there and lists **itself** as a catalog:

```yaml
catalogs:
  - name: local
    source: path:. # this project's own packs/, skills/, mcps/, hooks/
```

A top-level `mcps:` or `hooks:` is refused rather than ignored, naming both halves of the rewrite:
the file to move the definition into, and the `catalogs:` entry that makes it reachable. A top-level
`scopes:` or `skills:` is refused the same way — `skills:` naming the `requires` entry each of its
members becomes, per line, and `scopes:` naming the pack that does its job now.

| Field       | Type         | Required | Notes                                                                                                                                                                           |
| ----------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`   | int          | yes      | Must be `1`.                                                                                                                                                                    |
| `harnesses` | string[]     | no       | Any of `claude`, `codex`, `cursor`, `opencode`, `vscode`. Default `[claude]`. An unknown name is an error naming the five.                                                      |
| `catalogs`  | list of maps | no       | `name`, `source`, `ref?`. `name` unique, and holding no `/` — it is the qualifier half of an address, so an alias holding one could be selected from by nothing. A dot is fine. |
| `requires`  | list of maps | no       | Each entry: exactly one key of `pack`/`skill`/`mcp`/`hook`, carrying `<catalog>/<pattern>`. An entry matching nothing is an error.                                              |

**Source formats:** `owner/repo`, `owner/repo@ref` (GitHub shorthand), `https://github.com/owner/repo`,
`git@host:owner/repo.git`, `git:<any-git-url>`, `path:./relative/dir`. A `@ref` shorthand that
contradicts the entry's own `ref` is an error.

#### Why an entry names its namespace

There is no shorter spelling. An entry is a mapping of one key, written out and never guessed:

```yaml
- pack: "company/function.engineering"
```

**A catalog's namespaces are flat and independent**, so a skill at `skills/mcp/sentry/SKILL.md` is
legitimately named `mcp.sentry` while an MCP entity called `sentry` sits one namespace over. A bare
`- company/mcp.sentry` cannot say which of the two it means. Stating the key is the same rule that
makes `ambit why` take `<kind>:<name>` rather than a bare name.

It also means **hooks are opt-in by construction**. A hook is a command line the harness runs, and no
`skill:` or `pack:` entry can reach one by accident: taking a hook is either a `hook:` entry or a
pack whose document says, in the catalog, that the hook belongs to it.

**One entry, one namespace.** An author who wants one name to reach a skill, a server and a hook at
once declares a **pack** and a consumer writes `- pack: company/engineering`. That is the whole of what
replaced the free-form tags this grammar used to select on — and the trade is deliberate. A tag let a
consumer invent a grouping the catalog had never blessed; a pack does not, and in exchange the
grouping is a document with a name, a description and an enumerable membership, so `ambit
search` can show it and a misspelling in it is an error rather than a label reaching nobody.

### `packs/<name>.yml`: packs

A pack is a `requires` list with a name and a description. It ships no bytes, runs nothing, and
installs nowhere — what it contributes to a bundle is the items it names.

```yaml
name: function.engineering
description: Everything an Acme engineer needs — reviews, tooling, and the guards around them.

requires:
  - pack: core # packs compose: a big grouping built out of small ones
  - skill: code-review
  - skill: guides.* # a glob, like anywhere else
  - mcp: linter
  - hook: guard-secrets
```

| Key           | Type   | Required | Notes                                                                                                                                                         |
| ------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string | yes      | Must match the path under `packs/`, with the extension dropped and `/` read as `.`, the way a skill's does. `.yml` and `.yaml` are both accepted.             |
| `description` | string | no       | What the pack is for. Carried into `ambit search`, which is the point of a pack being a document.                                                             |
| `requires`    | map[]  | no       | Each entry: exactly one key of `pack`/`skill`/`mcp`/`hook`, carrying a **bare** pattern. Resolved within this catalog. An entry matching nothing is an error. |

`packs/` nests, unlike `mcps/`: `packs/function/engineering.yml` and `packs/function.engineering.yml`
both declare `function.engineering`, and declaring the same name both ways is refused rather than
arbitrated. Group them into directories or not, as you prefer.

There is no `expects` on a pack. An expectation says something must be true of the world, and every
one of those is read by something that runs — a skill's instructions, a server's credentials, a hook's
command. A pack runs nothing, and the items it names carry their own.

### `SKILL.md` frontmatter: skill annotations

```yaml
---
name: close-crm
description: "Calls the Close CRM REST API…"
ambit:
  requires: # resolved into the bundle; exit 3 if an entry matches nothing
    - skill: company-context
    - hook: guards.*
  expects: # checked by `doctor`; exit 6 if unsatisfied
    - env: CLOSE_API_KEY
---
```

| Key              | Type  | Required | Notes                                                                                                                                                         |
| ---------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambit`          | map   | no       | Every annotation below. Absent means the skill declares nothing.                                                                                              |
| `ambit.requires` | map[] | no       | Each entry: exactly one key of `pack`/`skill`/`mcp`/`hook`, carrying a **bare** pattern. Resolved within this catalog. An entry matching nothing is an error. |
| `ambit.expects`  | map[] | no       | One entry per precondition, each a single key naming its kind. Today: `env:`.                                                                                 |

**A skill's `requires` is a pack's `requires`, and both are a project's minus the qualifier.** Same one
declared key, same glob rules. What differs is why they exist: a pack's list _is_ the pack, and a
skill's says what that skill cannot work without — so a project reaching a skill gets a working bundle
rather than a plausible-looking broken one.

The qualifier is refused rather than optional: the alias belongs to the consumer's `catalogs:`, and the
same catalog is `company` in one project and `acme` in the next. So a bare pattern resolves **within
the catalog that ships the requiring document** — a catalog is self-contained, and can only require
what it ships.

Three consequences worth knowing. A catalog's `requires` cannot reach another catalog's skill, however
plainly the merged view holds a match. A wildcard is live: adding `skills/core/internal-notes` to a
catalog grows a dependency for everything requiring `skill: core.*`, at install, with no message —
accepted, and silent. And a pattern that matches the requiring item **itself** is a one-step cycle, so
the skill `core.a` cannot require `skill: core.*` — which is why the cycle refusal names the entry that
closed the loop and the file it is in.

Where only a string will do — `ambit why skill:mcp.sentry`, `ambit why mcp:sentry` — an item is named
`<kind>:<name>`. Nothing guesses a namespace there either: a bare name is refused rather than resolved
against whatever the catalog happens to hold today, because `skills/mcp/sentry/SKILL.md` is legitimately
the skill `mcp.sentry` and an MCP entity called `sentry` is a different thing one namespace over.

#### `requires` vs. `expects`

**`requires` is resolved**: every entry selects catalog items, resolution closes over them to a
fixpoint, and an entry that selects nothing fails the install at exit 3 rather than leaving a bundle
missing what a skill said it could not work without. **`expects` is checked**: nothing provides an
environment variable, so there is no lookup, no collision, no cycle and nothing to close over. `ambit
doctor` asks the machine, and a machine that says no fails at exit 6 with the install left exactly as it
was. `expects` is also the last list written as one-key `<kind>: <name>` mappings, which `requires` left
when it started selecting by pattern.

That is why they are two lists rather than one with four kinds. Each has one algebra, one exit code,
and one answer to _why does this entry fail my install and that one doesn't_.

`env:` is `expects`' only kind today, and the list is the shape the next precondition arrives in: a
skill whose instructions shell out to `docker` has something to declare that no `env:` can carry, and
`bin:` lands as one more entry rather than as another top-level key meaning _check this_. It is also
the one annotation the three _executable_ kinds share — a skill, a server and a hook each read
something from the world — while `requires` is carried by a skill and by a pack.

### `mcps/<name>.yml`: MCP entities

```yaml
name: sentry

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

expects:
  - env: SENTRY_TOKEN
```

| Key                       | Type     | Required      | Notes                                                               |
| ------------------------- | -------- | ------------- | ------------------------------------------------------------------- |
| `name`                    | string   | yes           | Must match the filename stem. `.yml` and `.yaml` are both accepted. |
| `transport`               | map      | yes           | Exactly one key, naming the kind: `stdio` or `http`.                |
| `transport.stdio.command` | string   | yes for stdio | Executable to spawn.                                                |
| `transport.stdio.args`    | string[] | no            | Arguments, in order.                                                |
| `transport.http.url`      | string   | yes for http  | Server endpoint.                                                    |
| `transport.http.headers`  | map      | no            | `${VAR}` becomes a reference in each harness's own syntax.          |
| `expects`                 | map[]    | no            | Preconditions, each a single key naming its kind. Today: `env:`.    |

### `hooks/<name>/hook.yml`: hooks

A hook is always a directory, named from its path under `hooks/` the way a skill is. A hook that runs
a command line holds nothing but its `hook.yml`; a hook that ships a script holds that too. The name
is lowercase, unlike `SKILL.md`, because ambit is the only thing that reads it.

```yaml
name: block-rm
description: Refuses a destructive rm before it runs

event: PreToolUse
matcher: Bash
type: script # or `command`
command: guard.sh # a file this directory ships, since `type` is `script`
timeout: 30

expects:
  - env: SOME_TOKEN
```

| Key           | Type   | Required | Notes                                                                                                                                     |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string | yes      | Must match the directory path under `hooks/`, same rule as a skill.                                                                       |
| `description` | string | no       | Carried into reports.                                                                                                                     |
| `event`       | string | yes      | One of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.               |
| `matcher`     | string | no       | Tool-name filter. Meaningful only for `PreToolUse` and `PostToolUse`; on any other event it is an error rather than a value quietly lost. |
| `type`        | string | yes      | `command` or `script` — how to read `command`.                                                                                            |
| `command`     | string | yes      | What to run, per `type`.                                                                                                                  |
| `timeout`     | int    | no       | Seconds. Written where the harness has a field for it.                                                                                    |
| `expects`     | map[]  | no       | Preconditions, each a single key naming its kind. Today: `env:`. Checked by `doctor`.                                                     |

**Whether a hook ships a script is declared, not guessed.** `type: command` is a command line the
harness runs exactly as written — `npx prettier --write`, `node tools/check.js`. `type: script` names
a file this directory ships, relative to it, optionally followed by arguments: `guard.sh --strict`.
The script is materialized to `.agents/hooks/<name>/`, and the command each harness gets points at it
there — only the first word is rewritten, so the arguments arrive untouched.

A `type: script` hook naming a file the directory does not hold is an error listing what it does hold.
`${VAR}` in a `command` is left exactly as written, unlike an MCP transport's: the harness spawns a
shell, so it already means the right thing.

| Harness            | Hooks written to        | Notes                                                                                                                                       |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`, `vscode` | `.claude/settings.json` | VS Code reads Claude's file natively, so it is written once.                                                                                |
| `cursor`           | `.cursor/hooks.json`    | Its own event spellings, and no field for a `matcher`, so a matcher is dropped.                                                             |
| `codex`            | `.codex/hooks.json`     | Experimental: Codex runs them only with `[features] codex_hooks = true` in a user's own config, which ambit must not write. `doctor` warns. |
| `opencode`         | —                       | No declarative hooks. A selected hook is skipped with a warning, and the install succeeds.                                                  |

Every harness's hook root is an array, which has no name to key on, so ambit identifies its own
entries by a content digest recorded in `.ambit/state.json`. Hooks you wrote by hand in the same file
are not ambit's and survive `install`, `prune` and `clean` byte-identically.

### The catalog root

Nothing. A catalog is a directory holding some of `packs/`, `skills/`, `mcps/` and `hooks/`, and
parsing takes what is there — there is no catalog-side config file. A directory holding none of the
four is a catalog with zero items.

A leftover `scopes.yml` is refused rather than ignored, naming the rewrite: delete it, and carry each
scope over as a pack requiring the items that declared it.

## Resolution

1. **Load and validate config.** Malformed → exit 2 naming the field.
2. **Fetch catalogs**, each into the local cache, at its `ref`, resolved to a commit SHA. A cached
   clone is refetched only when it cannot answer the `ref`, so a moving one keeps meaning what it
   meant — except on a first install, which has no `ambit.lock` and therefore nothing to reproduce.
   See [Staying up to date](#staying-up-to-date).
3. **Parse each catalog:** every `packs/**/*.yml`, every `skills/**/SKILL.md`, every `mcps/*.yml`,
   every `hooks/**/hook.yml`. An item whose declared `name` disagrees with its path is an error. A
   leftover `scopes.yml` → exit 2 naming the rewrite.
4. **Merge catalogs.** Every catalog's copy of every pack, skill, MCP and hook survives, identified by
   its catalog and its name. `catalogs:` order settles nothing — there is no precedence between them.
5. **Check every `requires` entry.** An entry no item satisfies → exit 3, naming the entry and the
   config line it was written on. A qualifier no `catalogs:` alias answers to is reported as that
   rather than as a pattern problem: the qualifier is an alias, so `*` is matched literally there.
6. **Select by entry.** Any item in the namespace the entry's key names, whose catalog it qualified,
   and whose name its pattern matches. An exact name is a pattern with no wildcard, so naming one item
   and globbing a prefix are one operator.
7. **Close over `requires`** to a fixpoint. A pack's list and a skill's are the same grammar minus the
   qualifier, so both may glob, and both resolve **within the catalog that ships the document** — a
   catalog can only require what it ships. An entry that selects nothing → exit 3, the same finding a
   project entry earns, naming the entry and the file it is written in. Servers and hooks are leaves:
   neither carries `requires`. A cycle → exit 3 printing the full path, plus the entry that closed it
   and its file.
8. **Union `expects`** across every selected skill, server and hook, grouped by kind. Packs contribute
   none — a pack reads nothing from the world. Nothing is resolved here: an expectation names no
   catalog item, so the union is the list `doctor` later checks the machine against.
9. **Refuse a collision.** Two selected items of one kind sharing a name → exit 3, naming both and
   the catalog each came from. A harness's layout is flat — Claude reads `.claude/skills/<name>` — so
   both copies would be installed at one path, and ambit will not choose one on the project's behalf.
   Packs materialize nowhere and are refused all the same: a pack is addressable, and two called
   `core` would leave `ambit why pack:core` with two answers. Narrow a `requires` pattern, or drop the
   entry that reaches the other catalog.
10. **Emit the bundle**, sorted by name.

### Glob rules

**`*` matches any run of characters, including `.`, and may appear anywhere. A pattern with no `*` is
an exact name.**

```
skill: "company/core.*"   ->  core.a, core.a.b        (NOT core)
skill: "company/core"     ->  core
skill: "company/*"        ->  every skill in the catalog
```

`core.*` says _`core`, a dot, then anything_, and `core` has no dot — so selecting a prefix **and** the
item named exactly that takes two entries. The wildcard spans `.` because a dot in a name is a
character and not a level: `core.*` reaches `core.a.b` in one entry, with no depth to agree with.

That rule is strictly honest about the syntax, and it costs you something. `core.*` against a catalog
holding both `core` and `core.a` matches `core.a`, so the entry matches _something_ and no error fires;
`core` itself is quietly left out, and you find out when an agent behaves as though it never read a
skill you were sure you had selected. Nothing can catch that — an entry that matched one item is a
working entry, and there is no second opinion about how much you meant to select.

The qualifier is not globbed. It is an alias from `catalogs:`, so `*/core` asks for a catalog literally
named `*` and matches nothing — which is exit 3, naming the alias rather than the pattern.

An entry that matches nothing is an error, not a silent miss: a typo'd or stale pattern would otherwise
leave a bundle quietly missing what the config went out of its way to ask for.

### Why an item is in the bundle

Every selected item carries one reason: the entry that selected it, or the pack or skill that required
it. `resolve --explain` prints it in the entry's own words.

```
$ ambit resolve --explain
packs (2)
  engineering  company  pack:company/engineering
  core         company  required-by:pack:engineering

skills (3)
  house-style  company  required-by:pack:core
  code-review  company  required-by:pack:engineering
  storybook    company  required-by:skill:code-review
```

A `required-by` reason names the requirer's **namespace** as well as its name, because both kinds that
can require anything are addressable and a pack may share a name with a skill: `required-by:pack:core`
is an answer, `required-by:core` is a second question. Two entries reaching one item tie-break on
sorted order, and an entry beats a `requires` edge — the entry ends a chain where the edge continues
one. `ambit why <kind>:<name>` walks the `required-by` chain back to the entry at the end of it.

## Staying up to date

A catalog is fetched into a local cache, and the cache is refetched only when it cannot answer the
`ref` it was asked for. So `ref: main` keeps meaning whichever commit it meant the first time, and
`ambit install` run twice a week apart installs the same bytes.

The exception is the _first_ time — a project with no `ambit.lock`. There is no earlier run for it to
agree with, and the cache is shared with every other project on the machine, so a first install
resolves its moving refs against the remote rather than inheriting a commit some unrelated project
last fetched. Every install after that leaves the cache alone. `--offline` opts out.

Moving forward after that is a decision, and these are the two commands that make it:

```
$ ambit outdated
catalogs (2)
  company   outdated  a1b2c3d → f9e1a04
  personal  current   3f1a99b

packs (1)
  ~  engineering  requires changed

skills (3)
  +  code-review  required-by:pack:engineering
  +  storybook    required-by:skill:code-review
  ~  house-style  description changed

mcps (2)
  ~  sentry  transport.http.url changed
  -  linear  was required-by:pack:engineering

hooks (1)
  +  guard-secrets  PreToolUse Bash — runs .agents/hooks/guard-secrets/guard.sh
```

**The report is about capabilities, not commits.** Both refs are resolved in one process and the two
bundles are compared directly, so a branch that advanced over two hundred commits touching nothing
this project selects reports a moved commit and an empty diff — which is the answer you wanted. A
changed item names the field that moved (`transport.http.url changed`) in preference to the file, and
falls back to `content changed` only when nothing it declares moved. An arriving hook says what will
run, because that is the question an update actually raises. A pack whose membership moved is
`requires changed`, and it is the cause the rows below it are the effect of.

| Freshness     | Meaning                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outdated`    | The `ref` names a different commit than the project resolves to now.                                                                                   |
| `current`     | It names the same one.                                                                                                                                 |
| `pinned`      | The `ref` is a commit, so there is nothing for it to name differently.                                                                                 |
| `unversioned` | A `path:` source. It has no revision, so it cannot be _behind_ — `ambit status` is the command for whether its bundle still matches what is installed. |

`ambit outdated` reaches the remote and still changes nothing: the answer lands in a private ref
namespace inside the cache that resolution never reads, so running it never moves a pin and never
changes what a later `ambit install` installs. `ambit update` is the command that does move it, and
`ambit update --dry-run` is exactly `ambit outdated` restricted to the catalogs you named.

Neither accepts `--offline`. Only the remote knows where a branch points now, so a cached answer
would be a confident wrong one; both refuse with exit 4 instead.

Every source a project has is a catalog — an item cannot be declared anywhere else — so there is no
second kind of `ref:` left for `ambit update` to miss.

## CLI reference

### Global flags

| Flag              | Notes                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `--project <dir>` | The project to act on. Default: cwd. The only directory flag there is.                         |
| `--json`          | Machine-readable output. Every command supports it.                                            |
| `--offline`       | Resolve from the cache alone. Refused by `outdated` and `update`, which exist to ask a remote. |
| `--dry-run`       | On mutating commands: report what would happen and touch nothing.                              |
| `--help`          | Usage for the program or for any command, on stdout at exit 0.                                 |
| `--version`       | Print the ambit version. Program-level.                                                        |

`--dry-run` still checks ownership and `--frozen`: a preview of an install that would be refused is
refused, with the same message and exit code.

### Commands

Twelve, and one flat surface: every one of them takes `--project` and `--json`, and no word in the
surface is a group. `--offline` is the one flag not every command answers to — `outdated` and `update`
exist to ask a remote, so they refuse it. Nothing writes into a catalog: a catalog is Markdown and YAML
in a git repo, maintained the way the rest of the repo is, with an editor and a validate step in CI.

| Command                                                             | What it does                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambit init`                                                        | Scaffold `ambit.yml`, the four item directories, and a live `catalogs:` entry naming the project itself. Refuses a directory that already holds a config, `--dry-run` included, and does not create a missing one.                                                                                                                                        |
| `ambit search [--catalog <name>…] [--capability <kind>…] <pattern>` | Search the merged catalog: every item in every catalog the project lists, the project's own among them, whether anything selects it or not. `<pattern>` is the same glob a `requires` entry uses, matched against names, so `ambit search "*"` is the whole of it. Repeating a flag widens; different flags narrow. A pattern matching nothing is exit 0. |
| `ambit resolve [--explain]`                                         | Compute the bundle and print it.                                                                                                                                                                                                                                                                                                                          |
| `ambit why <kind:name>`                                             | Explain why one item is in the bundle, as a chain. The subject declares its namespace, as everything that names an item does.                                                                                                                                                                                                                             |
| `ambit install [--frozen] [--adopt] [--copy\|--link]`               | Resolve, write `ambit.lock`, materialize the bundle, prune what left it.                                                                                                                                                                                                                                                                                  |
| `ambit outdated`                                                    | Ask each catalog's remote where its `ref` points now, and report what moving there would change.                                                                                                                                                                                                                                                          |
| `ambit update [<catalog>…] [--adopt] [--copy\|--link]`              | Move those pins forward, then install. Every catalog when none is named.                                                                                                                                                                                                                                                                                  |
| `ambit status [--check]`                                            | Compare what is installed against what resolve produces. `--check` exits 5 on drift.                                                                                                                                                                                                                                                                      |
| `ambit prune`                                                       | Remove owned artifacts not in the current bundle.                                                                                                                                                                                                                                                                                                         |
| `ambit clean`                                                       | Remove everything ambit owns.                                                                                                                                                                                                                                                                                                                             |
| `ambit validate`                                                    | Validate everything this project configures, for CI — every catalog it lists, the project's own items among them. A catalog repo runs this too: it lists itself.                                                                                                                                                                                          |
| `ambit doctor`                                                      | Check preconditions, the lock, ownership, drift, materialization mode, and harness limits.                                                                                                                                                                                                                                                                |

There is no `ambit catalog`. A catalog repo is a project that lists itself — three lines of
`ambit.yml`, which `ambit init` writes — so `ambit validate` reads its `packs/`, `skills/`, `mcps/` and
`hooks/` as an ordinary catalog and checks every item in it, selected or not. Scaffolding a catalog is
`ambit init` for the same reason: every project is one.

### Exit codes

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Success                                                                                 |
| 1    | Unexpected internal error                                                               |
| 2    | Config or ownership error                                                               |
| 3    | Resolution error: a pattern matching nothing, missing requirement, cycle, name conflict |
| 4    | Network or cache error                                                                  |
| 5    | Drift detected (`status --check`, `install --frozen`)                                   |
| 6    | A health check found something (`doctor` failures)                                      |

A usage error (an unknown flag, a missing argument) is exit 2 at any depth.

### Error messages

Every error names the offending file, the offending identifier, and one concrete next step.

```
error: `requires` entry "pack:company/function.enginering" matches nothing (ambit.yml line 6)
       no pack in catalog "company" has a name matching "function.enginering"
       correct the pattern, add the item to a catalog, or remove the entry

error: requirement cycle
       skill:alpha → skill:beta → skill:gamma → skill:alpha
       closed by `skill:alpha` in skills/gamma/SKILL.md
       break the cycle by removing one `requires` entry

error: refusing to overwrite unowned path
       .agents/skills/close-crm exists but ambit did not create it
       move it aside, or run `ambit install --adopt` to take ownership
```

`validate`, `status --check` and `doctor` _report_ rather than throw: findings go to stdout, so
`--json` stays parseable, and the non-zero code travels out beside a full report.

## Development

```
npm install
npm test          # vitest, offline apart from the one compatibility test
npm run typecheck
npm run lint
npm run format    # prettier --write; `format:check` is the CI variant
npm run build
```

`test/golden/` holds the golden files and is exempt from Prettier, since they are recorded program
output. Regenerate them with `UPDATE_GOLDEN=1 npm test` and read the diff.

`npm run fixture` builds the fixture catalog the suite resolves against. `AMBIT_SKIP_NETWORK_TESTS=1`
skips the dotagents compatibility test without probing the registry.

## License

MIT
