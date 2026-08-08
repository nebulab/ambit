# ambit

**ambit is a dependency manager for AI coding agents.**

Every agent harness (Claude Code, Codex, Cursor, opencode, VS Code) loads skills, hooks, and MCP
servers. Today you copy those files between projects by hand, and they drift. ambit lets you keep
them in a git repo, declare which ones a project wants, and install them into whatever harness your
team uses.

You write a few lines of config. ambit fetches, resolves, and writes the files.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [What you can select](#what-you-can-select)
- [Configuring your project](#configuring-your-project)
- [Authoring a catalog](#authoring-a-catalog)
- [Staying up to date](#staying-up-to-date)
- [CLI reference](#cli-reference)
- [Development](#development)
- [License](#license)

## Install

Nothing to install. You need Node 20+ and `git` on your `PATH`.

```
npx @nebulab/ambit --help
```

## Quick start

Start a project:

```
$ ambit init
created (5)
  ambit.yml
  hooks/.gitkeep
  mcps/.gitkeep
  packs/.gitkeep
  skills/.gitkeep
```

That writes `ambit.yml` plus the four item directories. Point it at a catalog and say what you want
from it:

```yaml
version: 1
harnesses: [claude]

catalogs:
  - name: company
    source: acme/skills
    ref: main

requires:
  - pack: "company/engineering" # everything that pack names, transitively
  - skill: "company/core.*" # every skill under the `core` prefix
```

Then install:

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

Your agent now sees those skills. ambit only touches files it created, so anything you wrote by hand
survives `install`, `prune`, and `clean`.

Three commands cover most of what you will do next:

```
$ ambit search "*"          # everything the catalogs offer, whether you selected it or not
$ ambit resolve --explain   # what you would get, and why
$ ambit outdated            # has any catalog moved, and would it change anything?
```

## What you can select

A **catalog** is a git repo (or a local directory) holding up to four kinds of thing:

| Kind      | Lives in                 | What it is                                                                   |
| --------- | ------------------------ | ---------------------------------------------------------------------------- |
| **Skill** | `skills/<name>/SKILL.md` | Instructions the agent can load                                              |
| **MCP**   | `mcps/<name>.yml`        | A server definition                                                          |
| **Hook**  | `hooks/<name>/hook.yml`  | A command that runs on one harness event                                     |
| **Pack**  | `packs/<name>.yml`       | A named group of the other three. ambit's own idea, invisible to the harness |

An item's name is its path inside its directory, with `/` read as `.`. So
`skills/close-crm/SKILL.md` is the skill `close-crm`, and `packs/function/engineering.yml` is the
pack `function.engineering`.

Your project is also a catalog. `ambit init` lists it as one, so a skill you write locally is
selected exactly like a skill from a shared repo.

Supported harnesses: `claude`, `codex`, `cursor`, `opencode`, `vscode`.

## Configuring your project

Everything a project declares lives in `ambit.yml`:

```yaml
version: 1
harnesses: [claude]

# Where items come from. Order carries no meaning.
catalogs:
  - name: company
    source: git@github.com:acme/skills.git
    ref: "a1b2c3d4" # tag, branch, or commit. Quote it. Omit for the default branch.
  - name: personal
    source: git@github.com:jane/skills-private.git
    ref: main
  - name: local
    source: path:. # this project's own packs/, skills/, mcps/, hooks/

# What this project selects. Nothing is implicit: an item no entry reaches is
# not installed. Each entry names its kind and carries `<catalog>/<pattern>`.
requires:
  - pack: "company/function.engineering"
  - skill: "company/core.*"
  - skill: "personal/luma"
  - hook: "company/guards.*"
```

| Field       | Type         | Required | Notes                                                                                                                              |
| ----------- | ------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `version`   | int          | yes      | Must be `1`.                                                                                                                       |
| `harnesses` | string[]     | no       | Any of `claude`, `codex`, `cursor`, `opencode`, `vscode`. Default `[claude]`.                                                      |
| `catalogs`  | list of maps | no       | `name`, `source`, `ref?`. `name` must be unique and hold no `/`, since it is the first half of an address. Dots are fine.          |
| `requires`  | list of maps | no       | Each entry: exactly one key of `pack`/`skill`/`mcp`/`hook`, carrying `<catalog>/<pattern>`. An entry matching nothing is an error. |

**Source formats:** `owner/repo`, `owner/repo@ref` (GitHub shorthand),
`https://github.com/owner/repo`, `git@host:owner/repo.git`, `git:<any-git-url>`,
`path:./relative/dir`.

## Authoring a catalog

A catalog is a plain git repo with some of `packs/`, `skills/`, `mcps/`, and `hooks/` in it. There is
no config file and no command that writes into one: it is Markdown and YAML, so use your editor and
run `ambit validate` to check the result.

### Skills

A skill is a directory holding `SKILL.md`. ambit reads two optional keys from its frontmatter:

```yaml
---
name: close-crm
description: "Calls the Close CRM REST API…"
ambit:
  requires: # pulled into the bundle alongside this skill
    - skill: company-context
    - hook: guards.*
  expects: # checked by `ambit doctor`
    - env: CLOSE_API_KEY
---
```

`requires` says what this skill cannot work without, so a project that takes the skill gets a
working bundle rather than a broken one. `expects` says what must be true of the machine. Patterns
here are **bare**, with no catalog name, and resolve within the catalog that ships the skill. A
catalog can only require what it ships.

### MCP servers

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

| Key                       | Type     | Required      | Notes                                                       |
| ------------------------- | -------- | ------------- | ----------------------------------------------------------- |
| `name`                    | string   | yes           | Must match the filename stem. `.yml` and `.yaml` both work. |
| `transport`               | map      | yes           | Exactly one key: `stdio` or `http`.                         |
| `transport.stdio.command` | string   | yes for stdio | Executable to spawn.                                        |
| `transport.stdio.args`    | string[] | no            | Arguments, in order.                                        |
| `transport.http.url`      | string   | yes for http  | Server endpoint.                                            |
| `transport.http.headers`  | map      | no            | `${VAR}` becomes a reference in each harness's own syntax.  |
| `expects`                 | map[]    | no            | Preconditions. Today only `env:`.                           |

### Hooks

A hook is a directory holding `hook.yml`, plus a script if it ships one.

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

| Key           | Type   | Required | Notes                                                                                                                       |
| ------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string | yes      | Must match the directory path under `hooks/`.                                                                               |
| `description` | string | no       | Carried into reports.                                                                                                       |
| `event`       | string | yes      | One of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PreCompact`, `SessionEnd`. |
| `matcher`     | string | no       | Tool-name filter. Valid only on `PreToolUse` and `PostToolUse`.                                                             |
| `type`        | string | yes      | `command` or `script`, saying how to read `command`.                                                                        |
| `command`     | string | yes      | What to run.                                                                                                                |
| `timeout`     | int    | no       | Seconds.                                                                                                                    |
| `expects`     | map[]  | no       | Preconditions. Today only `env:`.                                                                                           |

`type: command` is a command line the harness runs as written, like `npx prettier --write`.
`type: script` names a file this directory ships, optionally with arguments: `guard.sh --strict`.
ambit copies the script next to the harness config and rewrites the path, leaving your arguments
untouched. `${VAR}` in a `command` is left as written, since the harness runs it through a shell.

Hook support varies by harness:

| Harness            | Written to              | Notes                                                                                         |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------- |
| `claude`, `vscode` | `.claude/settings.json` | VS Code reads Claude's file natively, so it is written once.                                  |
| `cursor`           | `.cursor/hooks.json`    | Different event names, and no `matcher` field, so a matcher is dropped.                       |
| `codex`            | `.codex/hooks.json`     | Experimental: needs `[features] codex_hooks = true` in the user's own config. `doctor` warns. |
| `opencode`         | —                       | No declarative hooks. A selected hook is skipped with a warning and the install succeeds.     |

### Packs

**A pack is ambit's own invention.** Skills, MCP servers, and hooks are things your harness already
understands. A pack is not: it exists only inside ambit, ships no files, and installs nowhere. No
harness ever sees one. What it does is give a group of the other three a name, so one `requires`
entry takes the lot.

```yaml
# packs/function/engineering.yml
name: function.engineering
description: Everything an Acme engineer needs — reviews, tooling, and the guards around them.

requires:
  - pack: core # packs compose
  - skill: code-review
  - skill: guides.*
  - mcp: linter
  - hook: guard-secrets
```

| Key           | Type   | Required | Notes                                                                      |
| ------------- | ------ | -------- | -------------------------------------------------------------------------- |
| `name`        | string | yes      | Must match the path under `packs/`, extension dropped and `/` read as `.`. |
| `description` | string | no       | What the pack is for. Shown by `ambit search`.                             |
| `requires`    | map[]  | no       | Same grammar as a skill's: one key per entry, bare patterns, same catalog. |

`packs/` may nest, so `packs/function/engineering.yml` and `packs/function.engineering.yml` both
declare `function.engineering`. Declaring the same name both ways is an error.

## Staying up to date

`ambit.lock` records the exact commit each catalog resolved to, and every later command uses that
commit rather than asking what the `ref` points at now. So `ref: main` keeps meaning one commit,
`ambit install` run twice a week apart installs the same bytes, and a lock committed on one machine
installs the same bytes on another. Commit it.

A catalog with no recorded commit resolves its `ref` against the remote. That happens on a first
install, when you add a catalog, and when you edit a `ref`.

`ambit outdated` asks each remote where its `ref` points now and reports what moving there would
change. It changes nothing itself:

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

**The report is about capabilities, not commits.** A branch that advanced two hundred commits
without touching anything you selected reports a moved commit and an empty diff.

| Freshness     | Meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `outdated`    | The `ref` points at a different commit than the project uses now.    |
| `current`     | It points at the same one.                                           |
| `pinned`      | The `ref` is a commit, so it cannot point anywhere else.             |
| `unversioned` | A `path:` source. It has no revision, so use `ambit status` instead. |

`ambit update` is the command that moves the pins forward and then installs. `ambit update
--dry-run` is `ambit outdated` limited to the catalogs you named.

## CLI reference

### Commands

| Command                                                             | What it does                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ambit init`                                                        | Scaffold `ambit.yml`, the four item directories, and a `catalogs:` entry naming the project itself. Refuses a directory that already has a config.   |
| `ambit search [--catalog <name>…] [--capability <kind>…] <pattern>` | Search every catalog the project lists, whether anything selects the item or not. Same patterns as `requires`. A pattern matching nothing is exit 0. |
| `ambit resolve [--explain]`                                         | Compute the bundle and print it. `--explain` prints why each item is in it.                                                                          |
| `ambit why <kind:name>`                                             | Explain why one item is in the bundle, as a chain back to the entry that asked for it.                                                               |
| `ambit install [--frozen] [--adopt] [--copy\|--link]`               | Resolve, write `ambit.lock`, install the files, remove what is no longer selected.                                                                   |
| `ambit outdated`                                                    | Ask each remote where its `ref` points now, and report what moving there would change.                                                               |
| `ambit update [<catalog>…] [--adopt] [--copy\|--link]`              | Move those pins forward, then install. Every catalog when none is named.                                                                             |
| `ambit status [--check]`                                            | Compare what is installed against what resolve produces. `--check` exits 5 on drift.                                                                 |
| `ambit prune`                                                       | Remove installed files that are no longer selected.                                                                                                  |
| `ambit clean`                                                       | Remove everything ambit installed.                                                                                                                   |
| `ambit validate`                                                    | Validate the config and every catalog the project lists. A catalog repo runs this too, since it lists itself.                                        |
| `ambit doctor`                                                      | Check preconditions, the lock, ownership, drift, and harness limits.                                                                                 |

### Global flags

| Flag              | Notes                                                                   |
| ----------------- | ----------------------------------------------------------------------- |
| `--project <dir>` | The project to act on. Default: the current directory.                  |
| `--json`          | Machine-readable output. Every command supports it.                     |
| `--offline`       | Resolve from the local cache alone. Refused by `outdated` and `update`. |
| `--dry-run`       | On mutating commands: report what would happen and touch nothing.       |
| `--help`          | Usage for the program or for any command.                               |
| `--version`       | Print the ambit version.                                                |

### Exit codes

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Success                                                                                 |
| 1    | Unexpected internal error                                                               |
| 2    | Config or ownership error, including a usage error                                      |
| 3    | Resolution error: a pattern matching nothing, missing requirement, cycle, name conflict |
| 4    | Network or cache error                                                                  |
| 5    | Drift detected (`status --check`, `install --frozen`)                                   |
| 6    | A health check found something (`doctor` failures)                                      |

Every error names the file, the identifier, and one concrete next step:

```
error: `requires` entry "pack:company/function.enginering" matches nothing (ambit.yml line 6)
       no pack in catalog "company" has a name matching "function.enginering"
       correct the pattern, add the item to a catalog, or remove the entry

error: refusing to overwrite unowned path
       .agents/skills/close-crm exists but ambit did not create it
       move it aside, or run `ambit install --adopt` to take ownership
```

## Development

```
npm install
npm test          # vitest, offline apart from the one compatibility test
npm run typecheck
npm run lint
npm run format    # prettier --write; `format:check` is the CI variant
npm run build
```

`test/golden/` holds recorded program output and is exempt from Prettier. Regenerate it with
`UPDATE_GOLDEN=1 npm test` and read the diff. `npm run fixture` builds the fixture catalog the suite
resolves against. `AMBIT_SKIP_NETWORK_TESTS=1` skips the dotagents compatibility test.

## License

MIT
