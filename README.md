# ambit

ambit is a dependency manager for your AI agent's harness.

All agent harnesses (Claude Code, Codex, Cursor, opencode, etc.) load skills, hooks, and MCP servers.
ambit makes picking them declarative:

1. An ambit catalog declares the capabilities it offers (skills, hooks, and MCP servers).
2. An ambit project declares the catalogs it wants to pull and the scopes it wants from each catalog.
3. ambit resolves the scopes into a bundle and writes it into your harness's configuration.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Concepts](#concepts)
- [File formats](#file-formats)
- [Resolution](#resolution)
- [CLI reference](#cli-reference)
- [Development](#development)

## Install

No install step. Node 20+ and `git` on `PATH` are the only requirements.

```
npx @nebulab/ambit --help
```

## Quick start

### Authoring a catalog

A catalog is a plain git repo, and a catalog is a directory: three item directories, and no config
file of its own. Scaffold one, then write its skills, servers and hooks with your editor:

```
$ ambit catalog init --catalog acme-skills
created (5)
  .github/workflows/validate.yml
  README.md
  hooks/.gitkeep
  mcps/.gitkeep
  skills/.gitkeep

kept (0)
  (none)

next: add a skill in `skills/<name>/SKILL.md`, tagged with who needs it — see `README.md`
```

Add a skill by writing `skills/<name>/SKILL.md`, a server by writing `mcps/<name>.yml`, a hook by
writing `hooks/<name>/HOOK.yml`, and tag each with the labels that say who needs it. Every format is
documented below, and `ambit catalog validate` checks the result. There is no command that writes into
a catalog: it is Markdown and YAML, and you have an editor.

Tags are free-form: nothing registers one, nothing describes one, and no file in the catalog has to
agree about which tags exist. The cost is that a misspelled tag is silently a new tag, reaching
nobody — nothing can catch that.

`ambit catalog init` creates the root directory if it is missing, and scaffolds a GitHub Actions
workflow that runs `ambit catalog validate`. Every scaffolded file that already exists is left
byte-identical and reported as `kept`, which makes a second run a no-op.

### Consuming a catalog

```
$ ambit init
created ambit.yml
next: add a catalog under `catalogs`, edit `scopes`, then run `ambit install`
```

The scaffold holds `core` and no catalog, so `ambit install` fails until you point it at one. Add a
catalog and list the scopes this project holds:

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

## Concepts

| Term                | Meaning                                                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Catalog**         | A source of skills, MCP definitions and hooks: a git repo or a local directory.                                                                                 |
| **Skill**           | A directory containing `SKILL.md`. Its name is its path under `skills/`, so `skills/close-crm/` is `close-crm`. A nested directory joins its segments with `.`. |
| **MCP entity**      | A server definition in the catalog's `mcps/` directory.                                                                                                         |
| **Hook**            | A directory containing `HOOK.yml`, named from its path under `hooks/` the way a skill is. It runs a command on one harness event.                               |
| **Tag**             | A dotted, nestable label a catalog item carries, saying _who needs it_: `function.engineering`, `project.vision-group`, `person.jane-doe`. Free-form.           |
| **Scope**           | A tag a project holds. Holding one selects every item tagged with it, or with anything beneath it.                                                              |
| **Project**         | A directory containing `ambit.yml`.                                                                                                                             |
| **Bundle**          | The resolved set of skills, MCP servers and hooks for a project.                                                                                                |
| **Harness adapter** | Code that writes a bundle into one agent tool's layout: `claude`, `codex`, `cursor`, `opencode`, `vscode`.                                                      |
| **Owned artifact**  | A file or directory ambit created, recorded in `.ambit/state.json`. ambit never touches anything else.                                                          |

## File formats

### `ambit.yml`: project config

```yaml
version: 1
harnesses: [claude]

# Scopes this project holds — each one a tag a catalog's items carry. Nothing is
# implicit: list everything, including the tag everything shared carries.
scopes:
  - core
  - function.engineering
  - project.vision-group

# Catalogs. The order carries no meaning: every catalog's items are addressable,
# and none takes precedence over another.
catalogs:
  - name: company
    source: git@github.com:acme/skills.git
    ref: "a1b2c3d4" # tag, branch, or commit. Quote it. Omit for the default branch.
  - name: personal
    source: git@github.com:jane/skills-private.git
    ref: main

# Extra skills, regardless of scope. A string is a name looked up in the configured
# catalogs; a mapping declares a skill from a source that isn't a full catalog.
skills:
  - luma
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
    expects:
      - env: SOME_TOKEN

# Ad-hoc hooks not defined in any catalog. Same shape as a catalog hook, minus the
# shipped script: an inline hook has no directory, so `type` must be `command`.
hooks:
  - name: session-notes
    event: SessionStart
    type: command
    command: cat NOTES.md
```

| Field       | Type                    | Required | Notes                                                                                                                                            |
| ----------- | ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`   | int                     | yes      | Must be `1`.                                                                                                                                     |
| `harnesses` | string[]                | no       | Any of `claude`, `codex`, `cursor`, `opencode`, `vscode`. Default `[claude]`. An unknown name is an error naming the five.                       |
| `scopes`    | string[]                | no       | Held scopes, exactly as listed. Nothing is added implicitly. Absent or empty means nothing is selected by scope, only explicit `skills` entries. |
| `catalogs`  | list of maps            | no       | `name`, `source`, `ref?`. `name` unique.                                                                                                         |
| `skills`    | list of strings or maps | no       | String: a name from a catalog. Map: `name`, `source`, `ref?`, `path?`.                                                                           |
| `mcps`      | list of maps            | no       | Inline server definitions, in the shape below.                                                                                                   |
| `hooks`     | list of maps            | no       | Inline hook definitions, in the shape below.                                                                                                     |

**Source formats:** `owner/repo`, `owner/repo@ref` (GitHub shorthand), `https://github.com/owner/repo`,
`git@host:owner/repo.git`, `git:<any-git-url>`, `path:./relative/dir`. A `@ref` shorthand that
contradicts the entry's own `ref` is an error.

### `SKILL.md` frontmatter: skill annotations

```yaml
---
name: close-crm
description: "Calls the Close CRM REST API…"
ambit:
  tags: [function.sales]
  requires: # resolved into the bundle; exit 3 if unsatisfiable
    - skill: company-context
    - mcp: close
  expects: # checked by `doctor`; exit 6 if unsatisfied
    - env: CLOSE_API_KEY
---
```

| Key              | Type     | Required | Notes                                                                                                                                  |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ambit`          | map      | no       | Every annotation below. Absent means the skill declares nothing.                                                                       |
| `ambit.tags`     | string[] | no       | Free-form labels a project selects on. Absent or empty: never selected by scope, reachable only via `requires` or an explicit listing. |
| `ambit.requires` | map[]    | no       | One entry per requirement, each a single key naming its namespace: `skill:`, `mcp:`, or `hook:`.                                       |
| `ambit.expects`  | map[]    | no       | One entry per precondition, each a single key naming its kind. Today: `env:`.                                                          |

A `requires` entry **declares** its namespace instead of encoding it in the name. The three namespaces
are flat and independent, so a skill at `skills/mcp/sentry/SKILL.md` is legitimately named `mcp.sentry`
— under a prefix convention that skill can never be required, and `mcp.sentry` silently resolves to a
server of the same name instead. Each entry is therefore one key, exactly as an MCP entity's
`transport` is: `skill:`, `mcp:`, or `hook:`, and never two of them.

Where only a string will do — a flag's value, a command's subject — the same pair is written
`<kind>:<name>`: `--add-requires mcp:close`, `ambit why skill:mcp.sentry`. One grammar, everywhere a
name is taken from a person: nothing guesses a namespace, so a bare name is refused rather than
resolved against whatever the catalog happens to hold today.

#### `requires` vs. `expects`

They share that grammar and nothing else. **`requires` is resolved**: every entry names a catalog item,
resolution closes over it to a fixpoint, and an entry nothing provides fails the install at exit 3
rather than leaving a bundle missing what a skill said it could not work without. **`expects` is
checked**: nothing provides an environment variable, so there is no lookup, no collision, no cycle
and nothing to close over. `ambit doctor` asks the machine, and a machine that says no fails at exit 6 with
the install left exactly as it was.

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
A hook declared inline in `ambit.yml` has no directory, so it must be `type: command`.

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
5. **Expand held scopes.** For each held scope `s`, every tag any item declares that is equal to `s`
   or begins with `s + "."`. A held scope whose whole subtree is empty → exit 3, suggesting the
   nearest declared tag by edit distance.
6. **Select by scope.** Any skill, MCP or hook with at least one declared tag in the expanded set.
7. **Add explicit entries** from the config's `skills`, `mcps` and `hooks`.
8. **Close over `requires`** to a fixpoint. Each entry declares its own namespace, so a `mcp:` entry
   resolves against MCP entities, a `hook:` entry against hooks, and a `skill:` entry against skills —
   nothing is read off the name. Servers and hooks are leaves: neither carries `requires`. Unresolvable
   → exit 3 naming the requirer and the missing target. A cycle → exit 3 printing the full cycle path.
9. **Union `expects`** across every selected skill, server and hook, grouped by kind. Nothing is
   resolved here: an expectation names no catalog item, so the union is the list `doctor` later
   checks the machine against.
10. **Refuse a collision.** Two selected items of one kind sharing a name → exit 3, naming both and
    the catalog each came from. A harness's layout is flat — Claude reads `.claude/skills/<name>` — so
    both copies would be installed at one path, and ambit will not choose one on the project's behalf.
    Narrow what selects them, or drop the catalog that should not provide it.
11. **Emit the bundle**, sorted by name.

### Scope inheritance

**A held scope selects the tag itself and every tag beneath it. Descendants only.**

Holding `function.engineering` selects things tagged `function.engineering` _and_
`function.engineering.frontend`. Holding `function.engineering.frontend` selects only that subtree; it
does **not** reach up to `function.engineering`.

That rule is the whole resolver, and it runs over the tags items actually carry: nothing registers a
label, so a tag one level deeper than anything a project foresaw is still reached by whichever held
scope sits above it. Given a catalog whose items are tagged `core`, `function.engineering` and
`function.engineering.frontend`, a project holding `function.engineering` gets both engineering
skills, one directly and one from the nested tag:

```
$ ambit resolve --explain
scopes (2)
  core
  function.engineering

skills (3)
  house-style  company  scope:core
  code-review  company  scope:function.engineering
  storybook    company  scope:function.engineering.frontend
```

A project holding only the child gets only the child:

```
$ ambit resolve
scopes (1)
  function.engineering.frontend

skills (1)
  storybook  company
```

## CLI reference

### Global flags

| Flag              | Notes                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--project <dir>` | The project to act on. Default: cwd. On consumer commands.                                                             |
| `--catalog <dir>` | The catalog root to act on. Default: cwd. On catalog commands.                                                         |
| `--json`          | Machine-readable output. Every command supports it.                                                                    |
| `--offline`       | Resolve from the cache alone. On consumer commands only: a catalog command reads one directory and resolves no source. |
| `--dry-run`       | On mutating commands: report what would happen and touch nothing.                                                      |
| `--help`          | Usage for the program or for any command, at any depth, on stdout at exit 0.                                           |
| `--version`       | Print the ambit version. Program-level.                                                                                |

`--dry-run` still checks ownership and `--frozen`: a preview of an install that would be refused is
refused, with the same message and exit code.

### Consumer commands

| Command                                               | What it does                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ambit init`                                          | Scaffold an `ambit.yml`. Refuses a directory that already has one, `--dry-run` included, and does not create a missing directory. |
| `ambit dump-catalog`                                  | Dump the merged catalog: every catalog the project lists, merged with its own declarations.                                       |
| `ambit resolve [--explain]`                           | Compute the bundle and print it.                                                                                                  |
| `ambit why <kind:name>`                               | Explain why one item is in the bundle, as a chain. The subject declares its namespace, as everything that names an item does.     |
| `ambit install [--frozen] [--adopt] [--copy\|--link]` | Resolve, write `ambit.lock`, materialize the bundle, prune what left it.                                                          |
| `ambit status [--check]`                              | Compare what is installed against what resolve produces. `--check` exits 5 on drift.                                              |
| `ambit prune`                                         | Remove owned artifacts not in the current bundle.                                                                                 |
| `ambit clean`                                         | Remove everything ambit owns.                                                                                                     |
| `ambit validate`                                      | Validate everything this project configures, for CI. One catalog on its own is `ambit catalog validate`.                          |
| `ambit doctor`                                        | Check preconditions, the lock, ownership, drift, materialization mode, and harness limits.                                        |

### Catalog commands

```
ambit catalog init                              scaffold a catalog repo
ambit catalog validate                          validate this catalog on its own terms, for CI
```

Nothing here writes into a catalog's items. A catalog is Markdown and YAML in a git repo, and it is
maintained the way the rest of the repo is: with an editor, and with `ambit catalog validate` in CI.

### Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Success                                                                    |
| 1    | Unexpected internal error                                                  |
| 2    | Config or ownership error                                                  |
| 3    | Resolution error: unknown scope, missing requirement, cycle, name conflict |
| 4    | Network or cache error                                                     |
| 5    | Drift detected (`status --check`, `install --frozen`)                      |
| 6    | A health check found something (`doctor` failures)                         |

A usage error (an unknown flag, a missing argument) is exit 2 at any depth.

### Error messages

Every error names the offending file, the offending identifier, and one concrete next step.

```
error: unknown scope "function.enginering" (ambit.yml line 6)
       no item in any configured catalog declares it, or anything beneath it
       did you mean "function.engineering"?

error: requirement cycle
       alpha → beta → gamma → alpha
       break the cycle by removing one `requires` edge

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
