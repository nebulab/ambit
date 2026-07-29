# ambit

ambit is a dependency manager for your AI agent's harness.

All agent harnesses (Claude Code, Codex, Cursor, opencode, etc.) load skills, hooks, and MCP servers.
ambit makes picking them declarative:

1. An ambit catalog is a directory of skills, hooks and MCP servers, each named by its path and
   tagged with whatever labels its author thinks say who needs it.
2. An ambit project declares the catalogs it draws from and, per catalog, the patterns it selects —
   by name or by tag.
3. ambit resolves those patterns into a bundle and writes it into your harness's configuration.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [File formats](#file-formats)
- [Resolution](#resolution)
- [CLI reference](#cli-reference)
- [Migration](#migration)
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
created (4)
  ambit.yml
  hooks/.gitkeep
  mcps/.gitkeep
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
    source: path:. # this project's own skills/, mcps/, hooks/
```

That entry is live; the `requires` entry selecting it is scaffolded **commented out**, because an
entry matching nothing is exit 3 and a fresh project's `local` catalog is three empty directories.
Uncomment it once there is something to take.

An existing `ambit.yml` is refused, and so is a project directory that does not exist — `--project`
naming the wrong path should not leave a project where nobody meant one. An existing `.gitkeep` is
left byte-identical and reported as `kept`.

### Authoring a catalog

A catalog is a plain git repo, and a catalog is a directory: three item directories, and no config
file of its own. `ambit init` scaffolds one; write its skills, servers and hooks with your editor.

Add a skill by writing `skills/<name>/SKILL.md`, a server by writing `mcps/<name>.yml`, a hook by
writing `hooks/<name>/HOOK.yml`, and tag each with the labels that say who needs it. Every format is
documented below, and `ambit validate` checks the result. There is no command that writes into a
catalog: it is Markdown and YAML, and you have an editor.

Tags are free-form: nothing registers one, nothing describes one, and no file in the catalog has to
agree about which tags exist. The cost is that a misspelled tag is silently a new tag, reaching
nobody — nothing can catch that.

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
  - tag: "company/function.engineering"
    capabilities: [skills, mcps, hooks]
  - name: "company/core.*"
    capabilities: [skills]
```

Then:

```
$ ambit resolve --explain      # what you would get, and why
$ ambit install                # write the lock, materialize the bundle, prune what left it
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

### Checking it in CI

`ambit validate` is the check worth running on every push: it reads every catalog the project lists —
including the project's own `skills/`, `mcps/` and `hooks/` — and reports every `requires` entry that
matches nothing, every `requires` cycle, every item whose declared name disagrees with its path, and
every catalog it fetches and then selects nothing from. Catching those here is the point: a broken
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

| Term                | Meaning                                                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**         | A source of skills, MCP definitions and hooks: a git repo or a local directory.                                                                                                                                                                |
| **Skill**           | A directory containing `SKILL.md`. Its name is its path under `skills/`, so `skills/close-crm/` is `close-crm`. A nested directory joins its segments with `.`.                                                                                |
| **MCP entity**      | A server definition in the catalog's `mcps/` directory.                                                                                                                                                                                        |
| **Hook**            | A directory containing `HOOK.yml`, named from its path under `hooks/` the way a skill is. It runs a command on one harness event.                                                                                                              |
| **Tag**             | A label a catalog item carries, saying _who needs it_: `function.engineering`, `project.vision-group`, `person.jane-doe`. Free-form, registered nowhere, and the dots are a convention rather than a structure — nothing reads them as levels. |
| **Entry**           | One member of a `requires` list, in a project or in a skill: a field to match (`name` or `tag`), a glob to match it with, and the capabilities to match it against.                                                                            |
| **Project**         | A directory containing `ambit.yml`.                                                                                                                                                                                                            |
| **Bundle**          | The resolved set of skills, MCP servers and hooks for a project.                                                                                                                                                                               |
| **Harness adapter** | Code that writes a bundle into one agent tool's layout: `claude`, `codex`, `cursor`, `opencode`, `vscode`.                                                                                                                                     |
| **Owned artifact**  | A file or directory ambit created, recorded in `.ambit/state.json`. ambit never touches anything else.                                                                                                                                         |

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
# installed. Every entry declares both keys — the field, because
# `function.engineering` is a plausible name prefix and a plausible tag, and
# `capabilities`, because hooks execute. An address is `<catalog>/<pattern>`,
# where the catalog is an alias from `catalogs:` above.
requires:
  - tag: "company/function.engineering"
    capabilities: [skills, mcps, hooks]
  - name: "company/core.*" # everything beneath the `core` name prefix
    capabilities: [skills]
  - name: "personal/luma" # one skill, exactly
    capabilities: [skills]
```

Every definition lives in a file a catalog holds: a skill in `skills/<name>/SKILL.md`, a server in
`mcps/<name>.yml`, a hook in `hooks/<name>/HOOK.yml`. A project that ships one of its own puts it
there and lists **itself** as a catalog:

```yaml
catalogs:
  - name: local
    source: path:. # this project's own skills/, mcps/, hooks/
```

A top-level `mcps:` or `hooks:` is refused rather than ignored, naming both halves of the rewrite:
the file to move the definition into, and the `catalogs:` entry that makes it reachable. A top-level
`scopes:` or `skills:` is refused the same way, naming the `requires` entry each of its members
becomes, per line — the catalog alias is in the same file, so the message prints something pasteable.

| Field       | Type         | Required | Notes                                                                                                                                                                                |
| ----------- | ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`   | int          | yes      | Must be `1`.                                                                                                                                                                         |
| `harnesses` | string[]     | no       | Any of `claude`, `codex`, `cursor`, `opencode`, `vscode`. Default `[claude]`. An unknown name is an error naming the five.                                                           |
| `catalogs`  | list of maps | no       | `name`, `source`, `ref?`. `name` unique.                                                                                                                                             |
| `requires`  | list of maps | no       | Each entry: exactly one of `name`/`tag` carrying `<catalog>/<pattern>`, plus a non-empty `capabilities` drawn from `skills`, `mcps`, `hooks`. An entry matching nothing is an error. |

**Source formats:** `owner/repo`, `owner/repo@ref` (GitHub shorthand), `https://github.com/owner/repo`,
`git@host:owner/repo.git`, `git:<any-git-url>`, `path:./relative/dir`. A `@ref` shorthand that
contradicts the entry's own `ref` is an error.

#### Why an entry declares both keys

There is no shorter spelling. An entry is a mapping of two keys, both written out, neither guessed:

```yaml
- tag: "company/function.engineering"
  capabilities: [skills, mcps, hooks]
```

**The field is declared because a bare pattern cannot say which one it matches.**
`company/function.engineering` is a plausible name prefix and a plausible tag, and there is no way to
tell from the string which the author meant. Guessing would mean an entry that stops selecting the day
a catalog grows an item whose name happens to collide with a tag — so `name:` or `tag:` is stated, the
same rule that makes `ambit why` take `<kind>:<name>` rather than a bare name.

**`capabilities` is declared because hooks execute.** Defaulting it to all three is tempting: it is
what the mechanism this replaced did, and it is what would make the common entry one line instead of
two. It is refused anyway. An entry written while thinking about skills would otherwise install every
hook carrying that tag, and a hook is a command line the harness runs — the one class of surprise
worth two lines of YAML to avoid.

The list is a list, rather than a `<kind>.<field>` key, because selection by tag is inherently
multi-namespace: _everything the author tagged for engineers_ is one thought, and spending three
entries on it would be a regression against the mechanism it replaces.

The cost is that the common single-namespace entry takes two lines. Adding a shorthand later stays
backward-compatible; removing one would not, so there is none yet.

### `SKILL.md` frontmatter: skill annotations

```yaml
---
name: close-crm
description: "Calls the Close CRM REST API…"
ambit:
  tags: [function.sales]
  requires: # resolved into the bundle; exit 3 if an entry matches nothing
    - name: company-context
      capabilities: [skills]
    - tag: guards
      capabilities: [hooks]
  expects: # checked by `doctor`; exit 6 if unsatisfied
    - env: CLOSE_API_KEY
---
```

| Key              | Type     | Required | Notes                                                                                                                                                                      |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambit`          | map      | no       | Every annotation below. Absent means the skill declares nothing.                                                                                                           |
| `ambit.tags`     | string[] | no       | Free-form labels a `tag:` entry selects on. Absent or empty: reachable by a `name:` entry or a `requires` edge, and by nothing else.                                       |
| `ambit.requires` | map[]    | no       | Each entry: exactly one of `name`/`tag` carrying a **bare** pattern, plus a non-empty `capabilities`. Resolved within this catalog. An entry matching nothing is an error. |
| `ambit.expects`  | map[]    | no       | One entry per precondition, each a single key naming its kind. Today: `env:`.                                                                                              |

**A skill's `requires` is a project's `requires` minus the qualifier.** Same two declared keys, same
glob rules, so a skill can say _everything tagged `guards`, as hooks_ as readily as a project can. The
qualifier is refused rather than optional: the alias belongs to the consumer's `catalogs:`, and the same
catalog is `company` in one project and `acme` in the next. So a bare pattern resolves **within the
catalog that ships the requiring skill** — a catalog is self-contained, and can only require what it
ships.

Three consequences worth knowing. A catalog's `requires` cannot reach another catalog's skill, however
plainly the merged view holds a match. A wildcard is live: adding `skills/core/internal-notes` to a
catalog grows a dependency for every skill requiring `name: core.*`, at install, with no message —
accepted, and silent. And a pattern that matches the requiring skill **itself** is a one-step cycle, so
`core.a` cannot require `name: core.*` — which is why the cycle refusal names the entry that closed the
loop and the file it is in.

The spelling before this one — `- skill: company-context`, one key naming a namespace — is refused
rather than read, naming the entry it becomes: `- { name: "company-context", capabilities: [skills] }`.

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
the one annotation all three kinds of entity share — a skill, a server and a hook each read something
from the world — while only a skill carries `requires`.

### `mcps/<name>.yml`: MCP entities

```yaml
name: sentry
tags: [function.engineering]

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
| `tags`                    | string[] | no            | Same semantics as skills.                                           |
| `transport`               | map      | yes           | Exactly one key, naming the kind: `stdio` or `http`.                |
| `transport.stdio.command` | string   | yes for stdio | Executable to spawn.                                                |
| `transport.stdio.args`    | string[] | no            | Arguments, in order.                                                |
| `transport.http.url`      | string   | yes for http  | Server endpoint.                                                    |
| `transport.http.headers`  | map      | no            | `${VAR}` becomes a reference in each harness's own syntax.          |
| `expects`                 | map[]    | no            | Preconditions, each a single key naming its kind. Today: `env:`.    |

### `hooks/<name>/HOOK.yml`: hooks

A hook is always a directory, named from its path under `hooks/` the way a skill is. A hook that runs
a command line holds nothing but its `HOOK.yml`; a hook that ships a script holds that too.

```yaml
name: block-rm
description: Refuses a destructive rm before it runs
tags: [function.engineering]

event: PreToolUse
matcher: Bash
type: script # or `command`
command: guard.sh # a file this directory ships, since `type` is `script`
timeout: 30

expects:
  - env: SOME_TOKEN
```

| Key           | Type     | Required | Notes                                                                                                                                     |
| ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string   | yes      | Must match the directory path under `hooks/`, same rule as a skill.                                                                       |
| `description` | string   | no       | Carried into reports.                                                                                                                     |
| `tags`        | string[] | no       | Same semantics as skills.                                                                                                                 |
| `event`       | string   | yes      | One of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.               |
| `matcher`     | string   | no       | Tool-name filter. Meaningful only for `PreToolUse` and `PostToolUse`; on any other event it is an error rather than a value quietly lost. |
| `type`        | string   | yes      | `command` or `script` — how to read `command`.                                                                                            |
| `command`     | string   | yes      | What to run, per `type`.                                                                                                                  |
| `timeout`     | int      | no       | Seconds. Written where the harness has a field for it.                                                                                    |
| `expects`     | map[]    | no       | Preconditions, each a single key naming its kind. Today: `env:`. Checked by `doctor`.                                                     |

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

Nothing. A catalog is a directory holding some of `skills/`, `mcps/` and `hooks/`, and parsing takes
what is there — there is no catalog-side config file, and nothing registers or describes a tag. A
directory holding none of the three is a catalog with zero items.

A leftover `scopes.yml` is refused rather than ignored, naming the rewrite: delete it, and carry each
scope over as a tag on the items that declared it.

## Resolution

1. **Load and validate config.** Malformed → exit 2 naming the field.
2. **Fetch catalogs**, each into the local cache, at its `ref`, resolved to a commit SHA.
3. **Parse each catalog:** every `skills/**/SKILL.md`, every `mcps/*.yml`, every `hooks/**/HOOK.yml`.
   A skill or hook whose declared `name` disagrees with its directory path is an error. A leftover
   `scopes.yml` → exit 2 naming the rewrite.
4. **Merge catalogs.** Every catalog's copy of every skill, MCP and hook survives, identified by its
   catalog and its name. `catalogs:` order settles nothing — there is no precedence between them.
5. **Check every `requires` entry.** An entry no item satisfies → exit 3, naming the entry and the
   config line it was written on. A qualifier no `catalogs:` alias answers to is reported as that
   rather than as a pattern problem: the qualifier is an alias, so `*` is matched literally there.
6. **Select by entry.** Any skill, MCP or hook whose capability the entry names, whose catalog it
   qualified, and whose `name` or `tag` its pattern matches. An exact name is a pattern with no
   wildcard, so naming one item and globbing a prefix are one operator.
7. **Close over `requires`** to a fixpoint. A skill's entry is the same grammar minus the qualifier, so
   it may glob and may match on `tag`, and it is resolved **within the catalog that ships the skill** —
   a catalog can only require what it ships. An entry that selects nothing → exit 3, the same finding a
   project entry earns, naming the entry and the `SKILL.md` it is written in. Servers and hooks are
   leaves: neither carries `requires`. A cycle → exit 3 printing the full path, plus the entry that
   closed it and its file.
8. **Union `expects`** across every selected skill, server and hook, grouped by kind. Nothing is
   resolved here: an expectation names no catalog item, so the union is the list `doctor` later
   checks the machine against.
9. **Refuse a collision.** Two selected items of one kind sharing a name → exit 3, naming both and
   the catalog each came from. A harness's layout is flat — Claude reads `.claude/skills/<name>` — so
   both copies would be installed at one path, and ambit will not choose one on the project's behalf.
   Narrow a `requires` pattern, or drop the entry that reaches the other catalog.
10. **Emit the bundle**, sorted by name.

### Glob rules

**`*` matches any run of characters, including `.`, and may appear anywhere. A pattern with no `*` is
an exact name.**

```
company/core.*   ->  core.a, core.a.b        (NOT core)
company/core     ->  core
company/*        ->  the whole catalog
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

Every selected item carries one reason: the entry that selected it, or the skill that required it.
`resolve --explain` prints it in the entry's own words, minus the capability list — the namespace is
already the section the row is in.

```
$ ambit resolve --explain
skills (3)
  house-style  company  tag:company/core
  code-review  company  name:company/function.*
  storybook    company  required-by:code-review
```

The field is printed as well as the pattern, for the reason the grammar declares it: a reason that
cannot say whether `company/function.engineering` matched a name or a tag is not an answer. Two entries
reaching one item tie-break on sorted order. `ambit why <kind>:<name>` walks the `required-by` chain
back to the entry at the end of it.

## CLI reference

### Global flags

| Flag              | Notes                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| `--project <dir>` | The project to act on. Default: cwd. The only directory flag there is. |
| `--json`          | Machine-readable output. Every command supports it.                    |
| `--offline`       | Resolve from the cache alone. Every command accepts it.                |
| `--dry-run`       | On mutating commands: report what would happen and touch nothing.      |
| `--help`          | Usage for the program or for any command, on stdout at exit 0.         |
| `--version`       | Print the ambit version. Program-level.                                |

`--dry-run` still checks ownership and `--frozen`: a preview of an install that would be refused is
refused, with the same message and exit code.

### Commands

Ten, and one flat surface: every one of them takes the same three global flags — `--project`, `--json`,
`--offline` — and no word in the surface is a group. Nothing writes into a catalog: a catalog is
Markdown and YAML in a git repo, maintained the way the rest of the repo is, with an editor and a
validate step in CI.

| Command                                               | What it does                                                                                                                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ambit init`                                          | Scaffold `ambit.yml`, `skills/`, `mcps/` and `hooks/`, and a live `catalogs:` entry naming the project itself. Refuses a directory that already holds a config, `--dry-run` included, and does not create a missing one. |
| `ambit dump-catalog`                                  | Dump the merged catalog: every item in every catalog the project lists, the project's own among them, whether anything selects it or not.                                                                                |
| `ambit resolve [--explain]`                           | Compute the bundle and print it.                                                                                                                                                                                         |
| `ambit why <kind:name>`                               | Explain why one item is in the bundle, as a chain. The subject declares its namespace, as everything that names an item does.                                                                                            |
| `ambit install [--frozen] [--adopt] [--copy\|--link]` | Resolve, write `ambit.lock`, materialize the bundle, prune what left it.                                                                                                                                                 |
| `ambit status [--check]`                              | Compare what is installed against what resolve produces. `--check` exits 5 on drift.                                                                                                                                     |
| `ambit prune`                                         | Remove owned artifacts not in the current bundle.                                                                                                                                                                        |
| `ambit clean`                                         | Remove everything ambit owns.                                                                                                                                                                                            |
| `ambit validate`                                      | Validate everything this project configures, for CI — every catalog it lists, the project's own items among them. A catalog repo runs this too: it lists itself.                                                         |
| `ambit doctor`                                        | Check preconditions, the lock, ownership, drift, materialization mode, and harness limits.                                                                                                                               |

There is no `ambit catalog`. A catalog repo is a project that lists itself — three lines of
`ambit.yml`, which `ambit init` writes — so `ambit validate` reads its `skills/`, `mcps/` and `hooks/`
as an ordinary catalog and checks every item in it, selected or not. Scaffolding a catalog is
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
error: `requires` entry "tag:company/function.enginering" matches nothing (ambit.yml line 6)
       no skill, MCP server or hook in catalog "company" declares a tag matching "function.enginering"
       correct the pattern, tag an item with it (`ambit.tags`), or remove the entry

error: requirement cycle
       alpha → beta → gamma → alpha
       closed by `name:alpha` in skills/gamma/SKILL.md
       break the cycle by removing one `requires` entry

error: refusing to overwrite unowned path
       .agents/skills/close-crm exists but ambit did not create it
       move it aside, or run `ambit install --adopt` to take ownership
```

`validate`, `status --check` and `doctor` _report_ rather than throw: findings go to stdout, so
`--json` stays parseable, and the non-zero code travels out beside a full report.

## Migration

Selection used to work through _scopes_: dotted labels declared per item, registered per catalog in a
`scopes.yml`, and held by a project in a top-level `scopes:` list, where holding one also reached
everything beneath it. That is gone, along with the registry, the tree, and the second selection route
that sat beside it — a top-level `skills:` list naming items outright. Patterns over names and tags
replace all of it, in one grammar.

This is a hard break. The format is at version 1 with no compatibility promise, and nothing reads the
old spelling — two live grammars would leave every message ambiguous about which one it was answering
for. So each old spelling is _refused_, and the refusal is the migration path.

| Was                                          | Is now                                                                         | The refusal                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopes:` in `ambit.yml`                     | one `requires` entry per member: `tag:`, qualified, `capabilities` written out | Exit 2, printing the entry each member becomes, line by line. It also names the **second** entry a faithful rewrite needs — `<catalog>/<tag>.*` — because a held scope reached everything beneath it and a pattern does not.  |
| `skills:` in `ambit.yml`                     | one `requires` entry per member: `name:`, `capabilities: [skills]`             | Exit 2, the same shape, one entry per line.                                                                                                                                                                                   |
| `mcps:` or `hooks:` in `ambit.yml`           | `mcps/<name>.yml` and `hooks/<name>/HOOK.yml` in a catalog                     | Exit 2, naming both halves: the file to move the definition into, and the `catalogs:` entry — `- name: local`, `source: path:.` — that makes it reachable.                                                                    |
| a `skills:` entry carrying its own `source:` | a skill in a catalog the project lists                                         | Exit 2, but only as _`skills[0]` must be a string, found a mapping_ — the removed-key check reads the list as names and hits the mapping first. The rewrite is the row above's: move the skill into `skills/<name>/SKILL.md`. |
| `scopes.yml` in a catalog                    | deleted. A catalog is a directory and has no config file of its own            | Exit 2: _scopes are gone; tag items with `ambit.tags` and select them with `tag:`_ — then delete the file, carrying each scope over as a tag on the items that declared it.                                                   |
| `ambit.scopes:` in `SKILL.md` frontmatter    | `ambit.tags:`                                                                  | Exit 2 as an unknown key, listing `expects`, `requires`, `tags`. It does **not** name the rename: the check is the generic one, and nothing sits behind `scopes` to say more.                                                 |
| `scopes:` in `mcps/<name>.yml` or `HOOK.yml` | `tags:`                                                                        | The same unknown-key refusal, listing that file's accepted keys.                                                                                                                                                              |
| `- skill: company-context` in any `requires` | `- { name: "company-context", capabilities: [skills] }`                        | Exit 2, printing exactly that rewrite for the entry it found.                                                                                                                                                                 |

A catalog repo needs one thing it did not need before: an `ambit.yml`, three lines, listing itself.
`ambit init` writes it, and `ambit validate` then reads the repo's `skills/`, `mcps/` and `hooks/` as an
ordinary catalog. That is the price of `validate` not branching on whether a config is present.

Sixteen commands are gone, twenty-six down to ten. Everything that wrote into a catalog —
`catalog scope add|rm|mv`, `catalog skill new|rm|mv`, `catalog mcp new|rm`, `catalog hook new|rm`,
`catalog annotate` — is your editor now, and `ambit validate` after the fact is what replaces the
atomic-write-and-check-the-result guarantee those commands gave. `catalog tree` and `catalog audit` had
the registry as their only subject. `ambit scopes` was picker data whose payload was a scope's
description, and a tag has none. `catalog init` is `ambit init`, `catalog validate` is `ambit validate`,
and there is no `ambit catalog` left to put anything under.

**What you give up, stated plainly.** A misspelled tag is now undetectable. The registry's real job was
catching one the moment CI ran, because a scope that nothing had registered was an error; a free-form tag
misspelled in a catalog is silently a new tag, the item reaches nobody, and no surface says a word. The
consumer side still fails loudly — a project pattern matching nothing is exit 3 — but the authoring side
is unguarded, and there is nowhere left to put the check.

A catalog's layout also becomes public API. A `name:` pattern is a contract, so moving
`skills/foo/bar` breaks every project selecting it, where a scope label used to stay put while
directories moved underneath it. Tag-based selection is insulated from that; name-based selection is not,
and there is no longer a command that rewrites either.

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
