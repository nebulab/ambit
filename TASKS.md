# Tags and pattern addressing — carpaccio backlog

Execution plan for [#42](https://github.com/nebulab/ambit/issues/42), sliced into independently
shippable increments. **The issue is the design authority**: every task below cites the section that
justifies it and adds no decisions of its own. Read it with `gh issue view 42 --repo nebulab/ambit`.

## Loop protocol

One iteration = one task.

1. Read the issue (the design) and this file. Pick the **first unchecked task**.
2. Implement only that task. Do not pull work forward from a later one, even when it looks adjacent —
   if the task genuinely cannot close without it, append a `> blocked:` note under the task and stop.
3. Run the gate: `npm run lint && npm run format:check && npm run typecheck && npm test`.
4. Commit with `tags(N): <title>`, tick the checkbox, stop. The next iteration starts clean.

### Invariants after every task

- The five CI checks pass. A task is not done with a skipped or `.todo` test.
- `ambit install` twice leaves every written file byte-identical.
- No harness config file loses a byte ambit does not own.
- Golden files are regenerated with `UPDATE_GOLDEN=1 npm test` and the **diff is read**, not accepted.
  A golden diff that surprises you is a bug in the task, not in the golden.
- Every deletion the issue names is a deletion, not a deprecation. Nothing is kept "just in case",
  and no compatibility shim reads the old spelling — the format is at version 1 with no compatibility
  promise, so a refusal that names the rewrite is the whole of the migration path.

### Slicing rationale

The issue is one coherent change whose diff is overwhelmingly deletion, and taken literally it is a
single commit touching most of `src`. This backlog cuts it so that the **independent deletions land
first** — each one removing a mechanism whose absence is observable on its own — and the new
addressing grammar lands against a codebase that has already shed everything it replaces.

Tasks 1–4 delete four mechanisms that do not depend on patterns existing: the authoring CLI, the
scope registry, shadowing, and inline definitions. Selection still runs on held scopes throughout,
which keeps every step green. Task 5 builds the matcher against nothing. Tasks 6–7 swap selection
over to it, consumer side then catalog side. Tasks 8–9 collapse the consumer/authoring split that is
left with no surfaces on either side of it. Tasks 10–12 settle what the collapse exposes, document
it, and pin the result.

Two intermediate states are deliberately odd and deliberately short-lived:

- After task 2, items carry free-form `tags:` that held **scopes** still select by the subtree rule.
  The registry is what task 2 removes; the selection grammar is task 6's.
- After task 3, two catalogs may provide one name and the collision is refused at resolve — before
  there is any way to address either copy individually. That is the order the issue's own argument
  runs in: collision moves to materialization first, addressing arrives to make it avoidable.

---

## 1. Delete the authoring mutation commands

- [x] Every command that writes into a catalog, minus the two that need a home first.

Per §_The authoring CLI goes_. Gone: `catalog scope add|rm|mv`, `catalog skill new|rm|mv`,
`catalog mcp new|rm`, `catalog hook new|rm`, `catalog annotate`, `catalog tree`, `catalog audit`, and
`ambit scopes`.

Deletes `src/authoring/{annotate,audit,hook,mcp,scope,skill,tree}.ts`, their handlers under
`src/cli/handlers/`, `src/cli/handlers/scopes.ts`, their entries in `HANDLERS`/`RULES`/`COMMAND_SPECS`,
their re-exports from `src/index.ts`, and their tests — including `test/golden/catalog-tree.json`.

`catalog init` and `catalog validate` survive this task, so `editor.ts`, `cli/diff.ts` and
`CatalogOverlay` all stay alive for now; tasks 8 and 9 are what kill them.

**Slice** — the CLI offers ten authoring commands fewer, and nothing a consumer runs changed.

## 2. Delete the scope registry; items carry tags

- [x] `scopes.yml` is gone, a catalog is a directory, and `scopes:` on an item becomes `tags:`.

Per §_`scopes` becomes `tags`_ and §_A catalog is a directory, and nothing else_.

- `SCOPES_FILENAME`, `parseScopeRegistry`, `ScopeDefinition`, `RegisteredScope`,
  `scopeDescriptionConflict`, and `MergedCatalog.scopes` are deleted. `parseCatalogDirectory` no
  longer requires or reads any catalog-side config, and ignores `ambit.yml` if it finds one.
- `ANNOTATION_KEYS`' `scopes` becomes `tags` in `SKILL.md` frontmatter, in `mcps/<name>.yml`, and in
  `hook.yml`. The field on `CatalogSkill`/`MergedMcp`/`MergedHook` is renamed with it. Free-form:
  unregistered, undescribed, no tree the author has to agree with.
- Selection keeps working: `expandHeldScopes` expands held scopes over the tags items **declare**
  rather than over a registry, and the subtree rule is untouched. `assertScopesRegistered` becomes
  the check that a held scope no item declares is exit 3, keeping the edit-distance suggestion
  retargeted at declared tags. Both die in task 6; they are kept here so this task is green.
- `validate` loses `unregistered-scope` and `dead-scope`.
- A catalog still holding a `scopes.yml` is refused, naming the rewrite: _scopes are gone; tag items
  with `ambit.tags` and select them with `tag:`_ (§_Migration_).

**Slice** — an author tags an item and it reaches a consumer with nothing registered anywhere.

## 3. Delete shadowing; two catalogs may provide one name

- [x] The merged catalog keeps every catalog's copy, and a collision is refused at resolve.

Per §_Collision moves from selection to materialization_.

- `mergeCatalogs` stops collapsing one name to the earliest catalog. Every copy survives into
  `MergedCatalog`, identified by catalog **and** name, so `catalogs:` order stops meaning anything —
  drop the "in priority order" comment on `ProjectConfig.catalogs` and everywhere it is restated.
- `Shadowing`, `Shadowings`, `recordShadowing`, `formatShadowing`, `MergedCatalog.shadowing`, its
  `--explain` column and `validate`'s `shadowed-name` are all deleted.
- Two selected items of one kind sharing a name is **exit 3 at resolve**, naming both and the catalog
  each came from, because they materialize to one harness path. The remedy the message gives is to
  narrow a pattern or drop an entry — which reads as advice for the config task 6 introduces, so
  phrase it so it is true of held scopes too.
- Everything downstream that keyed on "one name per kind" — `install`, `prune`, `status`, `doctor`,
  the lock, `dump-catalog` — is checked against the new shape rather than assumed to still hold.

**Slice** — a personal catalog's copy of a company skill is no longer silently dropped.

## 4. Delete inline definitions

- [x] Every definition lives in a file: no top-level `mcps:`, no top-level `hooks:`, no `skills:` entry carrying a `source`.

Per §_Every definition lives in a file_.

Deletes `mergeConfigEntities`, `loadSourceSkill`, `SkillRequest`/`CatalogSkillRequest`/
`SourceSkillRequest` (a `skills:` entry is a bare name until task 6 deletes the key outright),
`declarationConflict`, `assertNotScript`, and `ConfigOrigin`'s `mcpLines`/`hookLines`.
`MergedMcp.file`, `MergedHook.path` and `MergedHook.catalogRoot` stop being optional, and `validate`'s
"declared in `ambit.yml`" fallbacks (`mcpFile`, `hookFile`) go with them.

Each refusal carries the rewrite: the file to move the definition into, and the `catalogs:` entry to
add (§_Migration_).

Closes #37 and PR #38 as a side effect — both are entirely about inline hooks.

**Slice** — one way to declare a thing, wherever it lives.

## 5. The glob matcher and the entry grammar

- [x] `src/model/pattern.ts`, pure, wired to nothing.

Per §_The entry grammar: field, pattern, capabilities_ and §_Glob rules_.

- `*` matches any run of characters, **including `.`**, and may appear anywhere. A pattern with no
  `*` is an exact name. `core.*` matches `core.a` and `core.a.b` but **not** `core` itself.
- An entry is `{field, pattern, capabilities}`: `field` is `name` or `tag`, `capabilities` is a
  non-empty list drawn from `skills`, `mcps`, `hooks`. Both are declared, neither is guessed and
  neither is defaulted — `capabilities` is required because hooks execute.
- Two spellings parse: qualified `<catalog>/<pattern>` for a project config, and unqualified for a
  catalog's own `requires`. A qualifier where it is refused, and a missing one where it is required,
  are exit 2 naming the key and the line.
- `matches(entry, item)` for one item of one kind, and literal equality for deduplicating a list.
  Deduplication is exact-only: no subsumption normalizing.
- No negation (that is #24's), and no bare shorthand omitting either key.

Unit-tested directly and imported by nothing. Nothing observable changes.

**Slice** — the vocabulary exists and rejects bad input.

## 6. `requires:` replaces `scopes:` and `skills:`

- [x] A project selects by pattern, and the two selection routes become one.

Per §_Proposal_, §_Addressing: qualified in a project, unqualified in a catalog_ and §_Selection reasons_.

- Project config: `scopes:` and `skills:` are deleted, `requires:` is added — a list of task 5's
  entries, each qualified with a `catalogs:` alias. `ConfigOrigin` carries the line each entry was
  written on, so a later refusal still names one.
- `expandHeldScopes`, `inSubtree`, `heldAncestor`, `scopeReason`, `selectedByScope`,
  `SCOPE_SEPARATOR`, `assertScopesRegistered`, `unknownScopeError`, `scopeSuggestion` and the whole
  edit-distance machinery (`suggestionThreshold`, `editDistance`, `nearestScope`) are deleted, along
  with `explicitNames`, `unknownExplicitSkill` and `ExplicitNames`.
- **A pattern matching nothing is exit 3**, naming the pattern and the line — the successor to
  `unknown-scope`/`unregistered-scope`.
- `SelectionReason` drops to two cases: selected by an entry, or required by a skill. `formatReason`
  prints field and pattern (`tag:company/core`, `name:company/function.*`), never the capability
  list. Two entries matching one item tie-break on sorted order.
- `Bundle.scopes` is deleted. The lock records the new reason string, so its format changes and every
  `test/golden/resolve/*.json` churns — regenerate and **read the diff**.
- `BundleItem = Requirement` stops being true: `BundleItem` becomes `Reference<ItemKind>`.
- Refusals carry the rewrite for the deleted keys, per line, since the catalog alias is in the same
  file (§_Migration_).

**Slice** — one addressing scheme, and `resolve --explain` answers "why is this here?" in it.

## 7. A skill's `requires` has the same expressive power

- [x] A catalog's `requires` is task 5's entry minus the qualifier, and the closure goes set-valued.

Per §_A skill's `requires` has the same expressive power_.

- A `requires` entry inside a catalog may wildcard and may match on `tag`, and resolves **within its
  own catalog** — a catalog is self-contained and can only require what it ships.
- `closeOverRequires` walks a set-valued closure rather than a map lookup. `missingRequirement`
  becomes the shared pattern-matched-nothing error, one finding kind at both altitudes.
- `sameRequirement` splits: literal equality for deduplication, `matches` for the closure and for
  reasons. `requiredByReason` uses `matches` and names the first requirer in name order.
- The cycle error keeps its path of names and gains one line naming the entry that closed the loop,
  and its file.
- The accepted cost is recorded, not fixed: a wildcard `requires` means adding a skill to a catalog
  silently changes what an unrelated skill pulls in.

**Slice** — an author says _everything tagged `guards`, as hooks_ from inside a skill.

## 8. `ambit init` absorbs `catalog init`

- [x] One command scaffolds both halves, and `editor.ts` dies with the last mutator.

Per §_`ambit init` scaffolds both halves_.

Scaffolds `ambit.yml`, `skills/.gitkeep`, `mcps/.gitkeep`, `hooks/.gitkeep`, and a `catalogs:` entry
naming the project itself (`name: local`, `source: path:.`). The six decisions the merge forces are
the issue's, not this task's:

- The three directories are always created, in every project, not behind a flag.
- `local` is scaffolded live; a `requires` entry selecting it is **commented**, because a pattern
  matching nothing is exit 3 and a fresh project's `local` is empty.
- No CI workflow is scaffolded — it goes in the README as a paste-able block running `ambit validate`.
- A missing project root is still refused, keeping `ambit init`'s stance.
- An existing `ambit.yml` is refused; an existing `.gitkeep` is reported as `kept`.
- `INIT_SCOPE` and `CATALOG_INIT_SCOPE` both go.

Deletes `src/authoring/init.ts`, `src/authoring/editor.ts`, `src/cli/diff.ts`, the whole
`CatalogOverlay` mechanism (including `CatalogFiles`' pending-file handling and every parameter
threading an overlay through), `catalog-init.ts`, and their tests. `src/model/scaffold.ts` survives.
`--dry-run` survives on `init`, `install`, `prune` and `clean`, minus the catalog-edit diff.

**Slice** — `ambit init` in an empty directory produces a project that is also a catalog.

## 9. `ambit validate` absorbs `catalog validate`; the `catalog` group goes

- [x] One flat command surface, and `src/authoring/` is gone as a directory.

Per §_`ambit validate` validates the catalog too, and `ambit catalog` goes_.

- `validateCatalogDirectory` (with its synthesized name-and-source and its `overlay` parameter),
  `catalogValidateHandler`, `catalogDirOf`, the `--catalog <dir>` option and the `catalog` command
  group are all deleted. `ValidateOptions.config` stops being optional, which takes the "a catalog is
  not a project" branch out of `validateCatalog`.
- `--offline` applies uniformly to every remaining command.
- Two findings are added: a pattern matching nothing (if task 6 left it resolve-only, `validate`
  reports every one of them rather than the first), and **a configured catalog nothing selects
  from** — which must fire only for a catalog that _has items_, or it would fail `validate` on every
  freshly initialized project.
- `src/authoring/` is deleted as a directory. Assert nothing outside `src/cli/` ever imported from it.
  > done in task 8: `catalog validate` reads `src/resolution/validate.ts`, never `src/authoring/`, so
  > removing `editor.ts` and `init.ts` emptied the directory outright.

> decided in task 9, because the issue's two halves collide: _configured catalog nothing selects from_
> takes a **second** exemption beyond _has items_ — the catalog whose root **is** the project
> directory. With only the has-items guard, §_`ambit validate` validates the catalog too_ stops being
> true the moment a catalog repo holds one skill: it lists itself, selects nothing, and would fail its
> own CI. Publishing is not consuming. `ValidateOptions.own` carries the fact, since which catalog the
> project _is_ is a fact about where a source resolved to; the argument is in
> `unselectedCatalogProblems`' own comment.

> the nested-usage-error coverage task 8 flagged: the two cases in `test/model/catalog.test.ts` that
> asserted the exit-code contract _two_ levels down had `catalog validate` as their only subject, and
> the surface is flat now. The one-level cases stay, `CommandSpec.subcommands` stays as a seam with
> nothing declaring it (as `CommandRule` does with `RULES` empty), and the seam's own behaviour — a
> group printing usage, a child keyed by the whole invocation — is pinned directly against
> `buildCommand`. What is genuinely gone is the assertion that `inheritSettings` **recurses**: that
> needs a nested command inside the real program, and there is none to build one from.

**Slice** — a catalog repo lists itself and `ambit validate` checks it, with no `catalog` in the surface.

## 10. Settle what the collapse exposes

- [x] `reference.ts`'s parameterization, and `requirementYaml`.

Per the two structural consequences at the end of §_Deleted, concretely_ — the issue asks for a
decision here rather than dictating one, so make it and record it in the code's own comments.

- `reference.ts` (337 lines) exists to share the `<kind>:<name>` grammar between `requires` and
  `expects`; `requires` now has its own shape. Decide whether the generic `ReferenceGrammar`
  parameterization still pays for itself with `expects` and `ambit why`'s subject as its only
  callers, and either collapse it or write down why it stays.
- `requirementYaml` emits `- skill: company-context` on one line, quoted in advice like _"or remove
  the `- mcp: sentry` entry"_. A two-key entry does not fit block style on one line — naming the
  pattern and the file is probably better advice than quoting YAML. Restructure accordingly.

**Slice** — no abstraction is left standing on an argument that no longer holds.

> decided in task 10, four ways. **`reference.ts` collapses**: not because two callers are too few, but
> because the two turned out to share no _reader_ — a document list of one-key mappings and a
> command-line `<kind>:<name>` string are two grammars, and every function the grammar parameterized had
> exactly one caller once `requires` left and the projections' wrappers went with `src/authoring/`, so
> collapsing duplicated nothing. `parseReferenceList` is `expectation.ts`' own, `parseSubject` becomes
> `requirement.ts`' `parseItemSubject`, and 337 lines become 45 holding the shape both parse to and the
> argument for why nothing else is shared. `KIND_NOUNS` goes with the example line it fed.
> **`requirementYaml` was already resolved by deletion** in task 7 — verified: no caller, and
> `entryYaml`'s own comment records the flow-mapping decision the issue asked for, while
> `unmatchedEntryError` names the pattern and the file.
> Two more the earlier tasks left standing, since this task's remit is exactly that: **`copiesByName`
> goes** — a task-3 artifact no caller wanted, because `why` wants a filter and the collision check wants
> a grouping keyed by catalog; and **`EditableYaml` goes** — dead since task 8 deleted its only caller,
> with no test of its own, kept alive by nothing but a possible future caller. Each deletion leaves its
> argument behind in the surviving module's comments.

## 11. Documentation

- [x] The README, the package description, and the fixture catalog.

- The README is rewritten for tags and pattern addressing: the `requires` grammar and why both keys
  are declared, the glob rules including `core.*` excluding `core`, qualified-versus-unqualified
  addressing, the ten-command surface, the paste-able CI block task 8 stopped scaffolding, and the
  migration table. Everything the registry held up goes: the descendants-only rule, the "only fixable
  by restructuring the tree" note, `catalogs:` priority order, and every `scopes.yml` mention. Keep
  the table of contents in step.
- `package.json`'s description still says _"selected by scope"_.
- `scripts/fixture-catalog.ts` and `test/fixture-catalog.test.ts` are brought over to tags.
- Nothing in `src` still says "scope" except where the word is being refused.

**Slice** — a reader who has never seen a scope can use ambit.

## 12. Verification gate

- [x] The whole thing, pinned.

- `npm run lint && npm run format:check && npm run typecheck && npm test`, clean.
- `grep -rin "scope" src test README.md` returns only migration refusals and their tests.
- The command surface is exactly the ten the issue lists, with exactly the global flags it lists:
  `--project <dir>`, `--json`, `--offline`, `--dry-run`, `--help`, `--version`.
- A fresh `ambit init` in an empty directory passes `ambit validate` with no edits.
- `ambit install` twice leaves every written file byte-identical.
- Determinism: `resolve --json` is byte-stable across runs and across filesystem orderings.

**Slice** — the issue is closed.

> verified in task 12, by re-audit rather than by trusting the earlier reports. All six checks pass,
> every file and symbol §_Deleted, concretely_ names is absent, and the surface is the ten commands
> with exactly the six global flags — driven against `dist/cli.js`, not the source.
>
> One defect found and fixed: **a `catalogs:` alias holding a `/` was accepted and addressable by
> nothing.** An alias is the qualifier half of `<catalog>/<pattern>`, so every entry qualified with
> `a/b` read as two separators and was refused at exit 2, while `validate` reported the catalog as one
> nothing selects from and advised qualifying an entry with `a/b/` — two refusals pointing at each
> other. Now refused where the alias is written. A dot is still fine, which is the whole reason the
> separator is `/` (§_Addressing_), and so is a `*`, matched literally, which is what
> `unmatchedEntryError`'s "a qualifier is an alias, not a pattern" line already claimed.
>
> Corrected counts for the `grep -rin "scope"` audit: 11 in `src`, **22** in `test`, **14** in
> `README.md`, 0 in `package.json` — every one re-read and justified as a refusal's literal string, a
> comment explaining what a refusal prints, or the README's own refusal and migration prose.
>
> Escalated rather than answered: a `skills:` entry carrying a `source:` earns
> _`skills[0]` must be a string_ and not the two-line rewrite the other removed keys print, because
> `assertNoRemovedSelection` reads the list as names and the string coercion throws first. §_Migration_
> asks every refusal to carry the rewrite; which of the two rewrites a key that was both a selection
> route and a definition site should print is a decision, not a bug, and the README already documents
> the behaviour honestly.
>
> Recorded, not fixed: tasks 10 (`7992cbd`) and 11 (`e4f578c`) carry no `gpgsig` header — 1Password's
> agent was unreachable. Every other commit on the branch is signed. History is left alone.

---

## Follow-up, not in this branch

The issue asks for four things to be closed that are not code: #35 and #37 as superseded, and PRs #40
and #38 with them. Left to a human — a branch cannot close someone else's PR.
