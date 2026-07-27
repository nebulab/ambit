# ambit

ambit is a dependency manager for your AI agent's capabilities: skills, MCP servers, and hooks.

All agent harnesses (Claude Code, Codex, Cursor, opencode, etc.) load skills, hooks, and MCP servers.
ambit makes picking them declarative. A project declares the **scopes** it holds; skills, MCP servers,
and hooks in a **catalog** declare which scopes they belong to; ambit resolves the two into a **bundle**
and writes it into each configured harness's own layout.

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

A catalog is a plain git repo. Scaffold one, register your scopes, then add skills, servers and hooks:

```
$ ambit catalog init --catalog acme-skills
created (6)
  .github/workflows/validate.yml
  README.md
  hooks/.gitkeep
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
$ ambit catalog skill new code-review \
    --description "How we review code" \
    --scope function.engineering \
    --requires skill:house-style
created (1)
  code-review  How we review code

files (1)
  skills/code-review/SKILL.md  created

next: write the skill's instructions in skills/code-review/SKILL.md
```

ambit writes the file and maintains its frontmatter; the instructions are yours.

`ambit catalog init` creates the root directory if it is missing, and scaffolds a GitHub Actions
workflow that runs `ambit catalog validate`. It refuses a directory that already has a `scopes.yml`.
Every other scaffolded file that already exists is left byte-identical and reported as `kept`.

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
$ ambit scopes                 # what the catalog offers, and what this project holds
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
| **Scope**           | A dotted, nestable label for _who needs a thing_: `function.engineering`, `project.vision-group`, `person.jane-doe`.                                            |
| **Project**         | A directory containing `ambit.yml`.                                                                                                                             |
| **Bundle**          | The resolved set of skills, MCP servers and hooks for a project.                                                                                                |
| **Harness adapter** | Code that writes a bundle into one agent tool's layout: `claude`, `codex`, `cursor`, `opencode`, `vscode`.                                                      |
| **Owned artifact**  | A file or directory ambit created, recorded in `.ambit/state.json`. ambit never touches anything else.                                                          |

## File formats

### `ambit.yml`: project config

```yaml
version: 1
harnesses: [claude]

# Scopes this project holds. Nothing is implicit: list everything, including the
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
    env: [SOME_TOKEN]

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
  scopes: [function.sales]
  requires:
    - skill: company-context
    - mcp: close
  env: [CLOSE_API_KEY]
---
```

| Key              | Type     | Required | Notes                                                                                            |
| ---------------- | -------- | -------- | ------------------------------------------------------------------------------------------------ |
| `ambit`          | map      | no       | Every annotation below. Absent means the skill declares nothing.                                 |
| `ambit.scopes`   | string[] | no       | Absent or empty: never selected by scope, reachable only via `requires` or an explicit listing.  |
| `ambit.requires` | map[]    | no       | One entry per requirement, each a single key naming its namespace: `skill:`, `mcp:`, or `hook:`. |
| `ambit.env`      | string[] | no       | Env vars the skill itself reads (not via an MCP).                                                |

A `requires` entry **declares** its namespace instead of encoding it in the name. The three namespaces
are flat and independent, so a skill at `skills/mcp/sentry/SKILL.md` is legitimately named `mcp.sentry`
— under a prefix convention that skill can never be required, and `mcp.sentry` silently resolves to a
server of the same name instead. Each entry is therefore one key, exactly as an MCP entity's
`transport` is: `skill:`, `mcp:`, or `hook:`, and never two of them.

Where only a string will do — a flag's value, a command's subject — the same pair is written
`<kind>:<name>`: `--add-requires mcp:close`, `ambit why skill:mcp.sentry`. One grammar, everywhere a
name is taken from a person: nothing guesses a namespace, so a bare name is refused rather than
resolved against whatever the catalog happens to hold today.

### `mcps/<name>.yml`: MCP entities

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
| `transport.http.headers`  | map      | no            | `${VAR}` becomes a reference in each harness's own syntax.          |
| `env`                     | string[] | no            | Env vars this server needs.                                         |

### `hooks/<name>/HOOK.yml`: hooks

A hook is always a directory, named from its path under `hooks/` the way a skill is. A hook that runs
a command line holds nothing but its `HOOK.yml`; a hook that ships a script holds that too.

```yaml
name: block-rm
description: Refuses a destructive rm before it runs
scopes: [function.engineering]

event: PreToolUse
matcher: Bash
type: script # or `command`
command: guard.sh # a file this directory ships, since `type` is `script`
timeout: 30

env: [SOME_TOKEN]
```

| Key           | Type     | Required | Notes                                                                                                                                     |
| ------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string   | yes      | Must match the directory path under `hooks/`, same rule as a skill.                                                                       |
| `description` | string   | no       | Carried into reports.                                                                                                                     |
| `scopes`      | string[] | no       | Same semantics as skills.                                                                                                                 |
| `event`       | string   | yes      | One of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`.               |
| `matcher`     | string   | no       | Tool-name filter. Meaningful only for `PreToolUse` and `PostToolUse`; on any other event it is an error rather than a value quietly lost. |
| `type`        | string   | yes      | `command` or `script` — how to read `command`.                                                                                            |
| `command`     | string   | yes      | What to run, per `type`.                                                                                                                  |
| `timeout`     | int      | no       | Seconds. Written where the harness has a field for it.                                                                                    |
| `env`         | string[] | no       | Env vars the hook needs, for `doctor` to check.                                                                                           |

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

### `scopes.yml`: the catalog's scope registry

At the catalog root.

```yaml
scopes:
  function.engineering:
    description: Building and shipping client software
  function.engineering.frontend:
    description: "Browser-side work: components, styling, accessibility"
  project.acme:
    description: The ACME project
```

## Resolution

1. **Load and validate config.** Malformed → exit 2 naming the field.
2. **Fetch catalogs**, each into the local cache, at its `ref`, resolved to a commit SHA.
3. **Parse each catalog:** `scopes.yml`, every `skills/**/SKILL.md`, every `mcps/*.yml`, every
   `hooks/**/HOOK.yml`. A skill or hook whose declared `name` disagrees with its directory path is an
   error.
4. **Merge registries** across catalogs. The same scope declared twice with identical descriptions
   merges silently; differing descriptions → exit 3 naming both catalogs.
5. **Merge catalogs.** On a duplicate skill, MCP or hook name the earlier catalog in config order wins,
   and the shadowing is recorded so `resolve --explain` and `validate` can report it.
6. **Expand held scopes.** For each held scope `s`, every registered scope equal to `s` or beginning
   with `s + "."`. A held scope absent from the merged registry → exit 3, suggesting the nearest
   registered scope by edit distance.
7. **Select by scope.** Any skill, MCP or hook with at least one declared scope in the expanded set.
8. **Add explicit entries** from the config's `skills`, `mcps` and `hooks`.
9. **Close over `requires`** to a fixpoint. Each entry declares its own namespace, so a `mcp:` entry
   resolves against MCP entities, a `hook:` entry against hooks, and a `skill:` entry against skills —
   nothing is read off the name. Servers and hooks are leaves: neither carries `requires`. Unresolvable
   → exit 3 naming the requirer and the missing target. A cycle → exit 3 printing the full cycle path.
10. **Union `env`** across every selected skill, server and hook.
11. **Emit the bundle**, sorted by name.

### Scope inheritance

**A held scope selects itself and every scope beneath it. Descendants only.**

Holding `function.engineering` selects things scoped `function.engineering` _and_
`function.engineering.frontend`. Holding `function.engineering.frontend` selects only that subtree; it
does **not** reach up to `function.engineering`.

That rule is the whole resolver, so the shape of your scope tree is load-bearing:

```
$ ambit catalog tree
scopes (3)
  core                             1 direct  0 inherited  The universal floor — what everyone here needs
  function.engineering             1 direct  1 inherited  Building and shipping software
    function.engineering.frontend  1 direct  0 inherited  Browser-side work
```

A project holding `function.engineering` gets both engineering skills, one directly and one inherited
from the child scope:

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

| Flag              | Notes                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--project <dir>` | The project to act on. Default: cwd. On consumer commands.                                                                |
| `--catalog <dir>` | The catalog root to act on. Default: cwd. On authoring commands.                                                          |
| `--json`          | Machine-readable output. Every command supports it.                                                                       |
| `--offline`       | Resolve from the cache alone. On consumer commands only: an authoring command reads one directory and resolves no source. |
| `--dry-run`       | On mutating commands: report what would happen and touch nothing.                                                         |
| `--help`          | Usage for the program or for any command, at any depth, on stdout at exit 0.                                              |
| `--version`       | Print the ambit version. Program-level.                                                                                   |

`--dry-run` still checks ownership and `--frozen`: a preview of an install that would be refused is
refused, with the same message and exit code.

### Consumer commands

| Command                                               | What it does                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ambit init`                                          | Scaffold an `ambit.yml`. Refuses a directory that already has one, `--dry-run` included, and does not create a missing directory. |
| `ambit scopes`                                        | List the merged registry with descriptions, marking which scopes this project holds.                                              |
| `ambit dump-catalog`                                  | Dump the merged catalog: every catalog the project lists, merged with its own declarations.                                       |
| `ambit resolve [--explain]`                           | Compute the bundle and print it.                                                                                                  |
| `ambit why <kind>:<name>`                             | Explain why one item is in the bundle, as a chain. The subject declares its namespace, as everything that names an item does.     |
| `ambit install [--frozen] [--adopt] [--copy\|--link]` | Resolve, write `ambit.lock`, materialize the bundle, prune what left it.                                                          |
| `ambit status [--check]`                              | Compare what is installed against what resolve produces. `--check` exits 5 on drift.                                              |
| `ambit prune`                                         | Remove owned artifacts not in the current bundle.                                                                                 |
| `ambit clean`                                         | Remove everything ambit owns.                                                                                                     |
| `ambit validate`                                      | Validate everything this project configures, for CI. One catalog on its own is `ambit catalog validate`.                          |
| `ambit doctor`                                        | Check env vars, the lock, ownership, drift, materialization mode, and harness limits.                                             |

### Authoring commands

```
ambit catalog init                              scaffold a catalog repo
ambit catalog tree [--json]                     the scope tree, and what each scope selects
ambit catalog audit [--check]                   find dead scopes and unreachable items
ambit catalog validate                          validate this catalog on its own terms, for CI

ambit catalog scope add <name> --description <text>
ambit catalog scope rm <name>
ambit catalog scope mv <old> <new>

ambit catalog skill new <name> [--description <text>] [--scope <s>…]
                               [--requires <kind>:<name>…] [--env <v>…]
ambit catalog skill rm <name>
ambit catalog skill mv <old> <new>

ambit catalog mcp new <name> (--stdio <command> [--arg <a>…] | --http <url> [--header <k=v>…])
                             [--env <v>…]
ambit catalog mcp rm <name>

ambit catalog hook new <name> --event <event> (--command <cmd> | --script <path>) [--matcher <tool>]
                              [--description <text>] [--timeout <seconds>] [--env <v>…]
ambit catalog hook rm <name>

ambit catalog annotate <kind>:<name>
                              [--add-scope <s>…]              [--remove-scope <s>…]
                              [--add-requires <kind>:<name>…] [--remove-requires <kind>:<name>…]
                              [--add-env <v>…]                [--remove-env <v>…]
```

### Exit codes

| Code | Meaning                                                                              |
| ---- | ------------------------------------------------------------------------------------ |
| 0    | Success                                                                              |
| 1    | Unexpected internal error                                                            |
| 2    | Config or ownership error                                                            |
| 3    | Resolution error: unknown scope, missing requirement, cycle, name conflict           |
| 4    | Network or cache error                                                               |
| 5    | Drift detected (`status --check`, `install --frozen`)                                |
| 6    | A health check found something (`doctor` failures, `catalog audit --check` findings) |

A usage error (an unknown flag, a missing argument) is exit 2 at any depth.

### Error messages

Every error names the offending file, the offending identifier, and one concrete next step.

```
error: unknown scope "function.enginering" (ambit.yml line 6)
       not found in the merged registry
       did you mean "function.engineering"?

error: requirement cycle
       alpha → beta → gamma → alpha
       break the cycle by removing one `requires` edge

error: refusing to overwrite unowned path
       .agents/skills/close-crm exists but ambit did not create it
       move it aside, or run `ambit install --adopt` to take ownership
```

`validate`, `status --check`, `doctor` and `catalog audit --check` _report_ rather than throw: findings
go to stdout, so `--json` stays parseable, and the non-zero code travels out beside a full report.

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
