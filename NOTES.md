# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A30 — subcommand exit-code inheritance** (the tip of `main`). `inheritSettings` in
`src/program.ts` copies the program's settings down the whole command tree, so a Commander-level usage
error anywhere below the root now travels out of `run()` as an exit code instead of calling
`process.exit`. **The whole spec §6 CLI surface is implemented** and both authoring sections are done.
Next task is **A31 — error message accuracy** (`Depends: A30`, now checked), then A26–A29 (Shipping).

## Constraints later tasks inherit

- **`catalog` is a command group whose default action is `dump`**, and **handlers are keyed by the
  words a user types**: `"catalog dump"`, `"catalog init"`, `"catalog scope add"`. Every command
  `COMMAND_SPECS` declares now has an entry in `HANDLERS`; one added without a handler throws
  `notImplemented(<the whole invocation>)` — exit **1**, message
  `command "catalog tree" is not implemented yet`. That path is still pinned, now by a case that runs a
  program built from `HANDLERS` minus one key (`test/catalog.test.ts`'s `invoke` takes an optional
  handler map for exactly that), so a spec added ahead of its behaviour cannot silently succeed.
- **`CommandSpec` gained `subject`, `subcommands` and `defaultSubcommand`, and `argument` became
  `args`** (a list, because `mv <old> <new>` needs two positionals; Commander takes one name per
  `.argument()` call).
- **`subject: "catalog"` swaps `--project <dir>` for `--catalog <dir>` and drops `--offline`** — an
  authoring command reads one directory and resolves no source (spec §6). **`catalogDirOf(ctx)` now sits
  beside `projectDirOf`** in `src/commands.ts`; every authoring handler goes through it.
  `validateHandler` deliberately still reads `ctx.options.catalog` itself, because it needs "absent" to
  mean "the subject is the project".
- **`enablePositionalOptions()` is set on the program *and* on every group, and both are load-bearing.**
  Without it Commander gives a flag to whichever command up the chain declares it, so
  `ambit catalog dump --json` leaves `--json` with the group and `dump` never sees it. Removing either
  one silently breaks every flag typed after a subcommand name.
- **`inheritSettings(program)` in `src/program.ts` copies the program's settings down the whole tree,
  and every command below the root depends on it.** `Command.addCommand` — unlike `.command()`, which
  ambit cannot use because each command is built from a spec — copies nothing, so without it a
  subcommand keeps Commander's defaults: a usage error writes to the real `process.stderr` and calls
  `process.exit`, bypassing spec §6's exit-code contract and killing the vitest worker. It must stay
  **after** the `addCommand` loop and stay **recursive** (a group's children are added inside
  `buildCommand`, before the program exists). It copies wholesale, so a per-command setting it also
  copies — `--help`, `enablePositionalOptions`, `showHelpAfterError` — is **overwritten by the
  program's**; those three already agree, but a future per-command setting must be applied after the
  copy or it will be lost. Consequences worth knowing: `--help` on any subcommand now returns from
  `run()` at exit 0 with the usage on **stdout** (so it is testable in-process), a Commander usage
  error is exit **2** (`CommanderError` → `ExitCode.Config` in `run`), and every subcommand's error now
  ends with the program's `(run \`ambit --help\` for usage)` hint. A `.makeOptionMandatory()` or
  `.conflicts()` on an authoring flag is therefore now *possible*; whether to move one there is a
  message question, not a mechanism one — see `--description` below.
- **A group with no `defaultSubcommand` (`scope`, `skill`, `mcp`) carries no global flags and prints
  its own help at exit 0** (`acts` in `buildCommand`). No flags because a group that declares one its
  children also declare is a group that eats it; help-not-error because bare `ambit` behaves the same
  way. Adding a default action to one of them means giving it the flag set back.
- **List-valued flags go through `repeatable()`**: absent when never given, `readonly string[]` in
  argv order otherwise. Deliberately no `[]` default — a handler can tell "not asked for" from
  "emptied", and the help stays free of `(default: [])`.
- **Every scaffold emits, it does not template.** `src/scaffold.ts` owns the one renderer:
  `renderScaffold(ScaffoldBlock[])`, where a block is prose plus at most one of `values` (emitted) or
  `example` (emitted, then commented out). Blocks sit in **sorted-key order**, so stripping the comment
  lines from a scaffolded file leaves exactly `emitYaml` of its values — `test/init.test.ts` and
  `test/catalog-init.test.ts` each pin that equality rather than a golden copy of the prose, so wording
  is free to change and the *shape* is not. `ambit.yml`, the catalog's `scopes.yml`, and the scaffolded
  GitHub workflow all go through it. **A new scaffolded file goes through it too**; do not hand-write YAML
  text. (The commented-out `catalogs` example in `ambit.yml` sits in the sorted position its key would
  occupy, so uncommenting it leaves the file sorted — also pinned.)
- **The scaffold holds `core` and no catalog, so `ambit install` on a freshly `init`ed project is
  exit 3 `unknown scope "core"`.** That is deliberate — `core` is a convention no resolver knows
  (spec §2) and the scaffold's job is to teach that before the bundle is silently empty — and the
  command's second output line is the warning: `next: add a catalog under \`catalogs\` …`.
- **`init` refuses a directory holding *either* config name, `--dry-run` included** (the same stance
  install takes: a preview of a refusal is a refusal), and it does **not** create a missing
  directory — an unwritable target is exit 2 `cannot write ambit.yml` naming the path.
  `existingConfigFiles(projectDir)` in `src/config.ts` is the shared "which names are present" check;
  `findConfigFile` now goes through it. `CONFIG_FILENAMES` is a **tuple** (`as const`) so
  `INIT_FILENAME = CONFIG_FILENAMES[0]` needs no fallback.
- **`ambit scopes` carries `held` per scope, and that is what makes it more than a slice of
  `ambit catalog`.** `held` is **literal membership in `ambit.yml`'s list**, never selection: holding
  `function.engineering` reaches `function.engineering.frontend` and does not hold it, and a picker
  that pre-checked the child would report a choice nobody made. Text is
  `name | held|- | description`; `--json` is `{ scopes: { <name>: { description, held } } }`.
- **`scopes` validates nothing.** It does not call `assertScopesRegistered`, so a held scope
  registered nowhere is exit 0 here (and still exit 3 from `resolve`, which a test asserts both
  halves of) — this is the command someone reads *to fix that typo*. Such a scope appears in no row,
  since the registry is the subject.
- **The editor moves and removes *directories* too, and that is a second change shape, not sugar.**
  `CatalogChange` is now a union: `CatalogFileChange { file, text }` (what it always was) and
  `CatalogTreeChange { directory, to }`, where `to: null` removes. A tree travels by **`rename`**, so a
  skill's `references/logo.png` survives a `mv` — reading it as a `string` to write it back would corrupt
  it, which is the whole reason the shape exists. `EditResult` therefore gained **`trees`**, and
  `diffSection(title, changes, trees?)` renders a tree as a header-only block (`treeChangeSummary` is the
  one wording for "removed"/"moved to x/", shared with the command's own report).
  Three consequences worth knowing: the overlay describes a tree by the files **parsing reads** only
  (`SKILL.md`, `*.yml`, `*.yaml`) and a **file change on the same path wins**, which is how a caller
  restates a moved skill's `name`; a file change aimed at a path a move is about to create takes the
  **source's** bytes as its `before`, so the preview reads as a one-line edit instead of a whole new file;
  and after a move or a removal the editor **prunes the emptied ancestor directories**, stopping at depth
  one so `skills/` and `mcps/` — the catalog's shape — always survive.
- **`src/editor.ts` is the whole of authoring's write path, and every B0x mutation is a caller.** Two halves:
  `CatalogDocument.open(root, file)` reads one document and gives back setters
  (`setString(path, value)`, `setStringList(path, values)`, `remove(path)`, `has(path)`, `text()`,
  `changed`, `change()`); `applyCatalogEdit(root, changes, { dryRun })` takes a list of
  `{ file, text }` — `text: null` removes the file — and does the four things every rule 5/4/6 promise
  needs. **Do not write into a catalog any other way**, and do not add a second validate-then-write.
- **Comments survive because the parsed node tree is what gets re-emitted.** `EditableYaml` in
  `src/yaml.ts` keeps the `yaml` `Document` and `toString()`s it under `EDIT_OPTIONS`, which is
  `EMIT_OPTIONS` minus `sortMapEntries` (sorting would reorder keys ambit never touched) plus
  **`flowCollectionPadding: false`** (without it `scopes: [core]` comes back `[ core ]` and every no-op
  round trip is a diff). A key ambit *adds* lands at the end in block layout — what `emitYaml` would
  write; an existing list keeps its own flow/block layout and its comment. `test/editor.test.ts` pins a
  byte-identical round trip of every fixture document.
- **Bytes the parser does not preserve are carried as bytes, not re-derived.** `splitFrontmatter` (now
  the single frontmatter locator, used by both `parseFrontmatterMapping` and the editor) cuts a
  `SKILL.md` into `open` + `block` + `close`, which concatenate back exactly — so the delimiters, the
  Markdown body, and blank lines above and below the block are untouched by construction. A whole YAML
  file is split the same way. `parseChecked(text, file, lineOffset)` is why a frontmatter error still
  cites the line of the *file*.
- **Validate-before-write reads through an overlay, not through disk.** `CatalogParseOptions.overlay`
  (a `ReadonlyMap<string, string | null>` keyed by catalog-relative path) makes
  `parseCatalogDirectory` — and so `validateCatalogDirectory(root, overlay)` — parse an edit's pending
  bytes, including files it creates (they appear in directory listings) and removes. Every catalog read
  now goes through the `CatalogFiles` class in `src/catalog.ts`; a new read must too, or it will not see
  a pending edit. This is what lets one edit span files that are only valid together — registering a
  scope and declaring it in the same run — and a test pins that.
- **The editor validates the *whole* result, so any pre-existing problem in a catalog blocks every
  mutation** (exit 3, nothing written). That is spec §6 rule 4 read literally. **Worth a second
  opinion:** the alternative is to refuse only problems the edit introduces, which would let someone fix
  one broken file while another is still broken.
- **An edit that changes no bytes writes nothing at all**, so re-running a mutation leaves even the
  mtime alone (asserted). `applyCatalogEdit` therefore skips validation entirely in that case.
- **`EditableYaml.renameKeys(path, renames)` / `CatalogDocument.renameKeys` is how a key changes name**,
  and it takes the whole set at once. It mutates the key scalar, so the entry keeps its position, its
  value, and the comment above it (which `remove` + `setString` would both lose); a set because a rename
  can pass through a name another entry still holds (`a` → `a.b` while `a.b` → `a.b.b`), so every pair is
  located before any is touched. Missing keys are ignored. `test/editor.test.ts` pins both halves.
- **`SCOPE_SEPARATOR` and `inSubtree` are exported from `src/resolve.ts`** because `catalog scope mv`
  renames exactly the scopes a held one would reach. If a rename and an expansion could disagree about
  what "beneath" means, a rename would silently change what holding a scope selects — so there is one
  answer, in one place.
- **`src/catalog-scope.ts` is the whole of `catalog scope`, and the three verbs are deliberately not
  symmetric.** `add` is **declarative**: it makes the registry say what it was asked whether or not the
  entry existed, so re-running it writes nothing and re-running it with new words is the only way to
  correct a description (nothing else edits one — **worth a second opinion**, since the alternative is to
  refuse an existing name). `rm` unregisters **one entry, never a descendant** (nothing requires a scope's
  parent to be registered — `person.jane` with no `person`), and refuses (exit 3) while any skill or server
  declares it, naming **every** declarer with its file. `mv` renames the scope **and its whole registered
  subtree**, rewriting every declarer of any renamed scope **in the same edit** — which is what makes the
  result validate through the overlay. A new entry lands at the end of the mapping, so a registry ambit
  appends to is no longer sorted; deliberate, since sorting would move entries the author placed.
- **Exit codes there follow spec §6's table, not the editor's habits:** an unknown scope, a still-declared
  scope, and a rename onto a registered name are all **3** (§6 lists "unknown scope" and "name conflict"
  under 3); a missing/blank `--description` and an empty name segment are **2**. `mv <old> <old>` and any
  no-op are exit 0 writing nothing.
- **`src/catalog-skill.ts` is the whole of `catalog skill`, and a skill's identity is its *path*.**
  `new` writes **one file** (the directories exist because it is written inside them), with the
  frontmatter through `emitYaml` — sorted keys, quoting, and **lists sorted and deduplicated**, so argv
  order is not information — and a Markdown body below it. A key it was given nothing for is left out
  entirely (absent and empty mean the same, §3.2). `rm` deletes the **directory**; `mv` moves it and the
  name follows from the new path, with the moved document's `name` and every `requires` naming the old
  name rewritten **in the same edit**. Exit codes: an invalid name is **2**; an existing name, an unknown
  skill, a still-required skill and a nested skill are all **3**.
- **`src/catalog-mcp.ts` is the whole of `catalog mcp`, and an entity is one file whose stem is its
  name.** `new` writes the *whole* file through `emitYaml` (ambit owns every byte of a document it
  creates), and **"exactly one transport" is a type, not a check**: `newMcp` takes an `McpTransport`, so
  the discriminator §3.3 insists on cannot be ambiguous below the handler. `rm` removes **the file the
  author wrote** — `mcpDocumentFile(root, name)` picks the extension that is actually on disk, since
  removing the `.yml` a name *would* take is a silent no-op against a catalog spelling it `.yaml`. Exit
  codes: an invalid name and every transport-flag problem are **2**; an existing name, an unknown server
  and a still-required one are **3**.
- **`--env` is sorted and deduplicated; `--arg` is not.** A set of env vars carries no order, and a
  program's positional arguments are nothing but order. `--header k=v` splits at the **first** `=`, and a
  repeated key is refused rather than overwritten.
- **Every command that *edits* an existing MCP entity goes through `mcpDocumentFile(root, name)`**
  (`src/catalog-mcp.ts`), which picks the §3.3 extension actually on disk: `mcp rm`, `annotate`, and — since
  B07 — `catalog scope mv`. The editor's `mcpDocumentPath` still always says `.yml`, and is right only where
  ambit is *creating* the file or naming one in a message about a name no file carries yet.
- **A flag belonging to the transport kind that was not named is exit 2, not ignored** (`--header` with
  `--stdio`, `--arg` with `--http`), as is an empty `--stdio`/`--http` value. The stance is that a flag
  someone typed which would be written nowhere is worse than an error. Every transport refusal names
  `supported kinds: http, stdio` from `MCP_TRANSPORT_KINDS`, so it cannot drift from what parsing says.
- **`MCP_EXTENSIONS` is now exported from `src/catalog.ts`**, so the authoring side and the parser agree
  about which extensions define an entity.
- **Neither `rm` nor `mv` will touch a skill directory that holds another skill** (`skills/a/b/SKILL.md`
  plus `skills/a/b/c/SKILL.md` is legal). Moving one would rename a skill nobody named and removing one
  would delete it, so both are refused naming what is in the way. That refusal is what lets the editor
  assume a moved tree carries at most the one `SKILL.md` its caller restates.
- **`assertRegisteredScopes(catalog, scopes)` is exported from `src/catalog-scope.ts`** and is how every
  command that *declares* a scope refuses an unregistered one: `skill new` and `annotate --add-scope`, its
  only two callers, and no command left to add. (`mcp new` does not: the surface spec §6 gives it has no
  `--scope`, so it declares none.) The editor would refuse such a write anyway (a declared scope nothing
  registers is a validation problem), but `refusedByValidation` quotes only each problem's **message**,
  not its detail, so the "did you mean" is lost; the pre-check is what makes a typo answerable.
  `--requires` deliberately has **no** such pre-check — validation's own message already names an
  unresolvable requirement and there is no better advice to add. **`annotate --remove-scope` is
  deliberately not pre-checked either**: an unregistered scope is precisely what someone runs it to clear,
  and refusing would leave the one command that can fix such a catalog unable to run against it.
- **`src/catalog-annotate.ts` is the whole of `catalog annotate`, and it is the only command that edits a
  document's *contents***, so authoring rule 2 is under the most pressure here. Two rules split the work:
  a list ambit rewrites comes out **sorted and deduplicated** (argv order is not information, unlike a
  stdio `args`), and a list whose **membership** the request would not change is left byte-for-byte alone —
  layout, comment, and a hand-written duplicate included. That second half is what makes annotating twice a
  true no-op *and* confines reordering to the keys the reader asked about. Emptying a list writes `[]`
  rather than removing the key: "declares none" is a statement the author made. **An MCP entity has no
  `requires`** (§3.3's key list), so a `--add-requires`/`--remove-requires` aimed at one is exit **2**
  naming the skill-side flag that does what was meant, not silently dropped.
- **`unknownSkill` (`catalog-skill.ts`) and `unknownMcp` (`catalog-mcp.ts`) are now exported**, so
  `annotate` refuses a missing item in the same words `rm` does. One identity, one wording — reword one
  side only and the two commands start disagreeing about what a catalog does not have.
- **Two of `annotate`'s refusals are argv-shaped and live in the handler**: an invocation that names no
  change at all (exit 2 — a mutating command reporting success having been given nothing is
  indistinguishable from one whose flags a shell ate) and adding *and* removing the same entry (exit 2).
  Both name a **directory** (`skills`/`mcps`) rather than a file, because neither has read the catalog yet
  and a guessed `.yml` would send the reader to a file that may not exist.
- **`positional(ctx, index, usage)` and `optionList(ctx, name)` now live in `src/commands.ts`**
  (`positional` moved out of `src/handlers/catalog-scope.ts`, which imports it back). `optionList` reads a
  `repeatable()` flag: `undefined` when never given, `readonly string[]` otherwise — which is how
  `annotate` tells "leave this list alone" from "empty it".
- **An authoring handler's heading follows `--dry-run`, not `written`** (`src/handlers/catalog-scope.ts`),
  unlike `catalog init`'s: a mutation that had nothing to do is a no-op, not a preview, so a second
  `scope add` prints `registered (1)` with `files (0)`. Every scope command prints exactly two sections —
  what the registry now holds, then `files` (or the `diff` under `--dry-run`) — and `mv` adds a closing
  line telling the reader to update each project's `ambit.yml`, since a catalog command edits none.
- **`src/diff.ts` is the only diff renderer, and every authoring `--dry-run` prints through it.**
  `diffSection(title, changes)` takes `applyCatalogEdit`'s `EditedFile[]` straight and returns a counted
  section in `src/output.ts`'s shape; `diffLines(before, after)` is the body. It is an exact LCS with
  removals ordered before additions at every tie (so one edit renders one way), three lines of context,
  `...` for an elided run, and a `<file> (created|removed|updated)` header per file. **It is a reading
  aid, not a patch** — nothing about a missing final newline or an intra-line change is shown, and the
  bytes travel in `--json` for anything that wants to apply them. Do not add a second renderer inside a
  command.
- **`src/catalog-tree.ts` is the whole of `catalog tree`, and `buildScopeTree(catalog)` is pure** — one
  read-only command, so there is no editor path, no `--dry-run`, and no diff. Three decisions in it that a
  later task must not quietly reverse. **A node's parent is its longest *registered* ancestor**, not its
  dotted prefix, because that is exactly what `expandHeldScopes` walks: the fixture's
  `function.engineering` is a root, since `function` is registered nowhere and a parent nobody registered
  is not a scope. **`direct` and `inherited` partition what a scope selects** — `direct` is what declares
  the scope, `inherited` is what a registered descendant declares *minus* `direct` — so the two counts sum
  to what holding the scope brings in, and an item declaring both a scope and its child is counted once.
  **Nothing here follows `requires`**, so the fixture's `mcp.fixture` (declared by no scope) appears in no
  row and in no golden entry; `catalog audit` is what reports an item no scope reaches.
- **`src/catalog-audit.ts` is the whole of `catalog audit`, and it is the report about a catalog's
  *health* where `validate` is the report about its *validity*.** The split is load-bearing in both
  directions: audit reports nothing about correctness (a dangling `requires` is an edge that reaches
  nothing here, not a finding) and validate reports nothing about reachability, so neither duplicates
  the other. Its own fixture — built by the authoring commands in `test/catalog-audit.test.ts` —
  passes `ambit validate` with zero problems while the audit reports three findings, and that pair is
  the claim. Three kinds in one declared order, which is also the report order:
  `dead-scope`, `unreachable-skill`, `unreachable-mcp`. Two rules inside that must not be quietly
  reversed. **Reachability is transitive**, closed over `requires` from what a *registered* scope
  selects, so a skill required only by an unreachable skill is itself unreachable (a one-step rule
  would call that pair fine). **A scope is dead only when its whole registered subtree selects
  nothing** — the count comes from `buildScopeTree`, so audit and `tree` cannot disagree about what a
  scope selects, and a registered parent nobody declares directly is not reported.
- **`auditCatalog(catalog, { mcpFiles })` is pure and takes the entity filenames as data**, because
  `McpEntity` carries none and a finding must name a file that is there (spec §6). The I/O wrapper
  `auditCatalogDirectory(root)` fills the map from `mcpDocumentFile`, so a `.yaml` entity is cited as
  `.yaml` — deliberately *not* the `.yml`-only shortcut `validate`'s `mcpFile` still takes, which is
  A31's. Absent, the map falls back to `.yml`.
- **`catalog audit` exits 0 however much it found; `--check` is what turns findings into exit 6**
  (`ExitCode.Doctor`, whose comment now covers both callers). Plain audit is a report, and one that
  broke a build by existing is one nobody adds to CI. The verdict helper is `isTidy(report)` and the
  `--json` key is `tidy` — a fourth word beside `status`'s `clean`, `validate`'s `valid` and
  `doctor`'s `healthy`, since `src/index.ts` re-exports all of them and two `isClean`s cannot coexist
  there.
- **`catalog tree --json` nests, where every other command's JSON is flat**, because the nesting is the
  answer: each entry carries `children` (a name-keyed map of the same shape), `description`, `direct`, and
  `inherited`, keys sorted as everywhere else. **Keys are full dotted names at every depth**, so one can be
  pasted straight into an `ambit.yml` `scopes` list. Text is one indented row per scope:
  `name | N direct | N inherited | description`, counts only — the itemization lives in `--json`, since a
  scope whose subtree holds forty skills would bury the shape the report exists to show.
- **`src/catalog-init.ts` is the whole of `catalog init`, and it goes through `applyCatalogEdit` like
  every other mutation** — so the scaffold gets the root check, atomic writes, `--dry-run`, and
  validation of the *result*. It therefore writes **files only**: `skills/` and `mcps/` exist because a
  `.gitkeep` is written inside them, which is also what makes them survive the first commit. The five
  files are `.github/workflows/validate.yml`, `README.md`, `mcps/.gitkeep`, `scopes.yml`,
  `skills/.gitkeep`.
- **`scopes.yml`'s presence is what "already a catalog" means**: it alone is refused (exit 2, nothing
  written, `--dry-run` included). **Every other scaffold file that already exists is `kept`** — left
  byte-identical and reported in its own section — because a catalog is normally initialized inside a repo
  that already has a README, and overwriting one would be the reformatting authoring rule 2 forbids one
  file up. A second `catalog init` is therefore exit 2, not a no-op.
- **`catalog init` creates a missing root, where `ambit init` refuses one.** Deliberate: the scaffold
  creates three directories regardless, so "this command creates no directories" was never a stance it
  could hold, and `ambit catalog init --catalog acme-skills` is the ordinary first use.
- **The scaffolded README is where spec §2 lives for a catalog author** — descendants-only, nothing
  implicit, and nest-vs-sibling. `test/catalog-init.test.ts` pins those ideas by regex and nothing else
  about the prose. It is the one scaffolded file that is not emitted YAML, since nothing parses it back.
- **The scaffolded workflow's keys come out sorted** (`jobs`, then `name`, then `on`) because it goes
  through `emitYaml` like everything else. GitHub does not care; a reader might find it odd. Keep it —
  the alternative is a hand-written file that can drift.
- **`src/doctor.ts` is the whole of `doctor`, and it runs one resolution.** `diagnoseProject` calls
  `planInstall` (bundle, artifacts, prior state, lock bytes) and then `statusOfPlan` — newly exported
  from `src/status.ts` — so `doctor` and `status` cannot disagree about an artifact and `doctor` and
  `install --frozen` cannot disagree about the lock. **Do not call `projectStatus` from a command that
  already has a plan**; that would resolve twice.
- **`doctor` has five checks, in a declared order that is also the report order** (`DOCTOR_CHECKS` =
  `env, lock, ownership, drift, mode`), and **two severities**. Only `fail` reaches exit 6; `warn`
  exits 0. Mode divergence is the only warning, which is what settles A20's objection: a project
  installed with `--copy` reports three warnings and still passes. An unset env var *is* a failure —
  spec §5's "warning, not a failure" governs install, and doctor exists precisely to fail on it.
- **The `drift` check owns the managed `.gitignore` block**, since it has no state entry and therefore
  no `status` row. It asks `updateGitignoreText` whether the file would change, exactly as
  `previewInstall` does. `unowned` is deliberately excluded from `drift` — it is the `ownership`
  check's, and reporting it twice would double every finding about a crashed install.
- **`doctor` writes its own lock message rather than reusing `assertLockCurrent`**, whose text names
  `--frozen` and interpolates the project's **absolute path**. Nothing in a report may carry a machine
  path (a test asserts it). The two say the same thing in different words; keep them in step by hand.
- **`envPlaceholders(value)` is exported from `src/adapters/claude.ts`** so `doctor` reads leftover
  `${VAR}`s off the *planned* config values instead of re-deciding what a placeholder is. Anything that
  changes interpolation must keep the two in one place.
- **The `mode` check only looks at artifacts `status` called `ok`**, and reads the mode off disk with
  `lstat` (not off state's recorded `mode`), so it cannot contradict what `status` reports.
- **`src/validate.ts` is the whole of `validate`, and `validateCatalog(merged, { config, parsed })` is
  pure** — that is the function every authoring mutation reaches through the editor, to satisfy spec §6
  authoring rule 4 ("validate before writing"). Two I/O wrappers sit beside it: `validateProject(context)` runs the same
  `loadCatalogs → mergeCatalogs → mergeConfigEntities` pipeline `resolve` does (minus resolution), and
  `validateCatalogDirectory(root)` parses one directory and reads **no `ambit.yml`, no other catalog,
  no cache**. `validateProject` takes a **`SourceContext`**, deliberately, so `--offline` still has
  exactly three construction sites.
- **A problem is a finding, not a throw.** `validateHandler` prints the report and *returns*
  `ExitCode.Resolution`, the way `status --check` returns `Drift`. So the problem list goes to
  **stdout** (it is the report, and `--json` has to be parseable) and nothing reaches stderr.
- **Every problem reuses resolution's own error builder**, now exported from `src/resolve.ts`:
  `unknownScopeError`, `scopeSuggestion`, `missingRequirement`, `cycleError`,
  `unknownExplicitSkill`, `skillFile`. A problem therefore reads identically whether `validate`
  listed it or `resolve` threw it — **do not re-word one side only**. `unregistered-scope` and
  `shadowed-name` are the two validate builds itself, since nothing else reports them.
- **Parsing can be told to collect instead of throw**: `CatalogParseOptions.collect`, threaded
  through `parseCatalogDirectory` and `loadCatalogs`, both of which take it as a trailing optional
  argument. **Exactly one problem takes that route** — a skill whose frontmatter `name` disagrees
  with its path — and `parseSkill` now always returns the **path-derived** name, which is a no-op on
  the strict path. Everything else still throws exit 2 at the first offender: malformed YAML, a
  missing `scopes.yml`, an MCP filename↔`name` disagreement, a `skills` entry whose source
  disagrees. So `validate` on an unparseable catalog is exit **2** with one error, and a test pins
  that boundary.
- **Two multi-problem gaps are deliberate and exit 3 one at a time**, because both are refusals to
  build a merged view at all: a config declaration a catalog also provides (`mergeConfigEntities`),
  and one scope two catalogs describe differently (`mergeCatalogs`).
- **`validate` calls shadowing a problem** even though resolution has a well-defined answer for it
  (spec §4 lists "no name shadowing"). A project that deliberately overlays a personal catalog on a
  company one therefore *fails* `validate` while installing fine. **Worth a second opinion**; the
  alternative reading is that shadowing is only a problem in `--catalog` mode.
- **`validate` reports nothing about env vars, the lock, ownership, or drift** — all four are
  `doctor`'s, and all four are now built.
- **Everything up to the first write is `planInstall` in `src/install.ts`** — config, catalogs,
  resolution, the lock bytes, `readState`, and every adapter's plan — and `previewInstall` is that
  plan rendered for `--dry-run` rather than applied. `installProject` and `pruneProject` both start
  from it, which is what keeps the three commands from disagreeing about what the current bundle is
  (the same argument `status.ts` makes for `adaptersFor`). **A new mutating command should call
  `planInstall`, not re-run the pipeline.** One ordering changed with it: `--frozen` is now checked
  *after* `readState`, so an unreadable state file is exit 2 where it used to be exit 5. Both write
  nothing.
- **A new mutating command is given `--dry-run` by `buildCommand` automatically**, so a handler that
  ignores it silently mutates under a flag that promises not to — read `dryRunRequested(ctx)` or you
  have shipped that bug. Every authoring mutation is already declared `mutating: true`, and authoring
  rule 6 wants a *diff* out of it, not just silence.
- **`--dry-run` checks ownership and `--frozen` on purpose.** A preview of an install that would be
  refused is refused, with the same message and exit code, because "what would happen" includes
  stopping. Neither check writes.
- **Deciding what to prune is split from doing it**: `planPrune(plan, prior)` is pure and answers from
  state alone, `pruneArtifacts` acts on its answer. `install`, `--dry-run`, `prune` and `clean` all go
  through `planPrune`, and **`clean` is `planPrune`/`pruneArtifacts` against an empty plan** — there is
  no separate "remove everything" traversal. Managed-key validation moved into `planPrune`, so the
  "nothing has been deleted yet" promise on a malformed `managedKeys` entry is now actually true (it
  was not: skill dirs sort before `.mcp.json`).
- **`remainingArtifacts(prior, pruned)` is what a standalone prune records**, subtracting the
  *planned* removals rather than the writes that happened — so a key state claimed in a file someone
  had already emptied by hand stops being claimed. Install needs none of this: it records what it
  applied.
- **`ambit prune` writes nothing when nothing is stale.** Not even state or the `.gitignore` block:
  pruning an untouched project must not create the records of an install that never happened. When it
  does prune, the write order mirrors install — filesystem, state, then the block.
- **`ambit prune` does not touch `ambit.lock`.** The lock is install's record of a resolution, so after
  a prune it can name skills that are no longer installed; `--frozen` then reports exit 5, which is
  the honest answer ("run install"). `status` still reads clean, because it compares artifacts only.
- **`ambit clean` resolves nothing.** It answers from `.ambit/state.json` alone (no config, no
  catalog, no network), so it works on the project someone actually reaches for it with — deleted
  `ambit.yml`, unreachable catalog. A test pins that. It lives with `pruneProject` in `src/clean.ts`;
  neither could go in `prune.ts`, which `install.ts` imports.
- **What `clean` deliberately leaves behind, all three for one reason — ambit deletes only what it
  owns (spec §5 rule 1):** `ambit.lock` (a record, not an artifact, and a file teams commit — deleting
  a tracked file would be the worse surprise), a `.mcp.json` left holding `{"mcpServers": {}}` (the
  document is co-owned, §3.6), and the empty `.claude/skills` directory (the harness's, and git does
  not track an empty directory anyway). It *does* remove `.ambit/` and the managed `.gitignore` block,
  both ambit's by definition. This is the call A18 and A14 left to A22; **worth a second opinion**,
  since PLAN.md's "otherwise identical to before the first install" can be read as reaching all three.
- **Block removal is `removeGitignoreText` (pure) / `removeGitignoreBlock` (I/O), and it takes the
  blank line above the block with it** — that separator is `updateGitignoreText`'s own, so install then
  clean returns a hand-written file byte-for-byte. The cost is that a file whose author ended it with a
  blank line loses that line. A file that was *only* the block is deleted rather than truncated
  (`removeGitignoreText` returns `""` as the caller's cue). `readGitignoreText(projectDir)` is now
  exported for the preview to read through.
- **`.gitignore` is written by install but is *not* an owned artifact.** `src/gitignore.ts` owns the
  two marker lines (`# BEGIN ambit` … `# END ambit`) and everything between them, and that record is
  **in band** — a text file has no keys for state to claim. So there is no state entry, no
  `PlannedArtifact`, no prune branch, no `status` row and no install-output row for it, and an
  existing `.gitignore` is a normal input rather than an ownership conflict (the same stance
  `.mcp.json` takes, one level down). Each install re-renders the whole block from the artifacts it
  just applied, so **pruning it is free**. Worth a second opinion, since spec §5 rule 1 is phrased in
  terms of state.
- **The block lists `.ambit/` plus every `skill-dir` path, sorted and deduplicated — never
  `.mcp.json` and never `ambit.lock`**, both of which a team may commit (spec §3.5). Skill paths carry
  **no trailing slash on purpose**: a `path:` skill installs as a symlink, git does not match a
  `dir/` pattern against a symlink, and `dir/` would therefore leave every linked skill tracked.
- **Two shapes of `.gitignore` are exit 2, both leaving the file byte-identical:** more than one
  `# BEGIN ambit` line, and a begin marker with no `# END ambit` after it. Detection matches the
  **sentinel prefix**, not the full opening line. Lines are split on `\n` only, so a CRLF file keeps its
  `\r` on every line ambit does not own. `clean` refuses the same two shapes, which is why it removes
  the block *before* `.ambit/`: state stays until the last step, so a fixed `.gitignore` makes the
  whole command retryable.
- **`src/handlers/artifacts.ts` holds the shared output projections**: `artifactJson`, `artifactRows`
  (path, kind, **mode**) and `removalRows` (path, kind, **managed keys**). The two row shapes are
  deliberately not one function — install's text output is pinned byte-for-byte with `-` in the mode
  column for `.mcp.json`, and a removal's useful third column is which keys went.
- **A skill's materialization mode is derived from `MergedSkill.commit`** (`modeOf` in
  `src/adapters/claude.ts`): absent means a `path:` source, which is a working tree someone edits, so
  it is **linked**; present means a pinned commit, so it is **copied** (spec §5). That is the only
  signal, and it is exact. The override rides on **`ProjectPaths.mode` / `InstallOptions.mode`**
  (`--copy`/`--link`), absent meaning "follow each source"; a new construction site of `ProjectPaths`
  therefore decides the mode by omission, so set it deliberately.
- **The fixture catalog is a `path:` source, so the default install of it is symlinks.** Every install
  test's state, text, and `--json` assertions read `mode: link`; the tests that are about a directory
  of ambit's own bytes pass `--copy` (see Traps).
- **Links are relative** (`linkSkillDir`), resolved against the link's own directory, so a project and
  its catalog move together and no absolute machine path lands in the working tree. `--link` against a
  remote source deliberately links into the shared cache checkout.
- **`status` compares a skill by the shape on disk, not by the plan's `mode`** (`skillVerdict`,
  `linkVerdict` in `src/status.ts`). So a project installed with `--copy` whose copies are intact reads
  **clean** even though a plain `install` would relink it: mode is a per-run choice, both modes put
  identical bytes in front of the harness, and treating divergence as drift would leave anyone who uses
  the flag with a `status --check` that can never pass. **Mode divergence is `doctor`'s, as a warning**
  that never reaches exit 6.
- **Editing a linked skill edits the catalog, and that is never drift.** Content drift is only a
  question about a copy.
- **`--copy`/`--link` mutual exclusion is Commander's, through `.conflicts("link")` on `--copy`**
  (`src/commands.ts`), so the refusal is `error: option '--copy' cannot be used with option '--link'`
  either way round and arrives before `installHandler` runs. `modeOverride` therefore no longer
  refuses anything and `install.ts` imports no `AmbitError`.
- **`src/status.ts`'s `projectStatus(projectDir, { offline })` plans through the adapters exactly as
  install does** and then compares, writing nothing. Every row is one artifact and one `ArtifactState`
  (`missing | modified | ok | stale | unowned`), so the whole report answers one question: would
  `ambit install` change this? **Drift is never an error**: `statusHandler` prints the table and
  *returns* `ExitCode.Drift` under `--check`. **`statusOfPlan(plan, prior)` is that comparison without
  the resolution**, exported for `doctor`; a third caller with a plan in hand should use it too.
- **A copied skill's contents are compared against its `source`, so status reports upstream change,
  not only local edits.** One difference is reported, the first in sorted order, and a file that cannot
  be read counts as differing.
- **`.mcp.json` is compared key by key and the first problem in plan order wins the row.** Key order
  inside a server is *not* a difference (`jsonEqual`); foreign keys are invisible.
- **New helpers exist so status cannot drift from install:** `sectionOf` (`src/harness-config.ts`) and
  `ownedKeys` (`src/ownership.ts`). Use them rather than re-deriving "what does ambit own in this file".
- **A new artifact kind means a new branch in `compareArtifacts`** (`status.ts`) *and* in `planPrune`
  (`prune.ts`), both of which switch on `skill-dir` vs `harness-config` and nothing else.
- **`removeConfigKeys` returns `undefined` when the document held none of the keys**, and pruning skips
  the write entirely in that case. That is what keeps a run with nothing to prune byte-identical and
  what stops pruning from recreating a `.mcp.json` someone deleted by hand.
- **Pruning removes managed keys, never the config file**, and never the directories that held pruned
  skills. **A state entry's `managedKeys` are split at the *first* dot** (`mcpServers.acme.internal` is
  one server named `acme.internal`), and a key naming no section at all is exit 2
  `cannot prune "<key>" from <file>`.
- **`src/ownership.ts`'s `authorizePlan(plan, prior, { adopt })` is the safety core**, called once
  before any adapter applies, and read-only (which is why `previewInstall` can call it). It returns the
  `State` `apply` must act with: `prior`, plus an owned entry per target `--adopt` just took over.
  **That is the whole of `--adopt` for skill dirs.** Its `exists` check is `lstat`, so a symlink —
  including a dangling one — counts as something ambit did not create unless state says otherwise.
- **`applySkillDir` removes an owned target before writing it**, which is also what makes a mode change
  between runs work. An *unowned* target is still merged into in copy mode (a case install never
  reaches; deliberate, so `apply` called directly cannot destroy a stranger's directory) — link mode has
  no merge, so there it is exit 2 `cannot symlink <path>`.
- **Ownership granularity follows the artifact kind.** `skill-dir` is owned as a path; `harness-config`
  is checked **per key**, so a `.mcp.json` full of hand-added servers is a normal input and only a
  colliding server *name* is a conflict.
- **Refusal is on the first conflict, in plan order** (skills sorted, then the config file), not a list
  of every conflict — `--adopt` clears all of them at once, and multi-problem reporting is A23's. The
  two messages are exit 2 and read `refusing to overwrite unowned path` / `unowned key`; the path one is
  byte-for-byte spec §6's example, so **do not reword it without changing the spec**.
- **A crash mid-`apply` still costs a `--adopt`.** State is written last (§5 rule 4), so artifacts from
  a failed run are present-but-unowned and the next plain `install` refuses them — `status` reports them
  as `unowned` before that happens, and **`doctor`'s `ownership` check explains it and names `--adopt`**.
- **Shadowing is *not* a `SelectionReason`.** `MergedCatalog` carries `shadowing: { skills, mcps }` —
  name-keyed maps of `Shadowing = { name, catalog, shadows[] }`, `shadows` in config order — and
  `formatShadowing` renders spec §6's `catalog:company (shadows personal)`. Deliberately *beside* the
  reason: the two answer different questions, and folding them would cost a shadowed item its reason in
  `--explain` **and** in `ambit why`'s chain. `formatReason` is still an exhaustive three-arm `switch`
  and **`ambit.lock`'s `reason:` is untouched**.
- **`--explain` and `validate` are the two surfaces that report shadowing** (spec §4.5 names exactly
  those two). `--explain`'s text gets a **fourth** cell and its `--json` gets `shadows: [catalog…]`;
  `validate` lists one `shadowed-name` problem per colliding name. **`ambit why` and `catalog dump`
  deliberately do not report it.**
- **A config `skills`/`mcps` declaration colliding with a catalog is still exit 3, not precedence**
  (spec §3.1); catalog-vs-catalog is the only place first-wins applies.
- **`mergeCatalogs` throws** (exit 3) when two catalogs describe one scope differently; identical
  descriptions merge silently.
- **`install` writes `ambit.lock`, and the lock is *not* an owned artifact.** Absent from state, from
  install's output, from `status`, from every `PlannedArtifact`, from pruning, from the gitignore block,
  and from `clean`. Nothing parses it: `--frozen` compares *bytes*.
- **`src/lock.ts` owns the whole lock.** `buildLock(loaded, bundle)` is pure and takes the **unmerged**
  `readonly Catalog[]`, `serializeLock` renders it, `assertLockCurrent` is `--frozen`. The lock is
  serialized once in `planInstall` and compared before anything is applied; the write happens after
  `apply` and after pruning. **The lock records no mode.**
- **`emitYaml` in `src/yaml.ts` is the only sanctioned way to write YAML ambit owns the shape of**
  (spec §3.0): sorted keys at every depth, double quotes when quoting is needed, no anchors/aliases,
  core schema 1.2. The lock and both scaffolds go through it (via `renderScaffold`), as does a new
  `SKILL.md`'s frontmatter, and **so should the whole file B06 writes**. Editing a file someone else
  wrote is the other case — see the editor below. `renderScaffold` is for a file whose prose is
  *comments*; a new skill's prose is its Markdown body instead, since the frontmatter is a block other
  tools parse.
- **Top-level lock keys are sorted, so the file reads `catalogs, mcps, skills, version`.** Empty
  sections stay as `mcps: {}` rather than vanishing.
- **A source-declared skill's lock `catalog:` is its `source` as written** (`path:../extra`, a git URL),
  and an inline MCP's is the config filename.
- **`MergedSkill` carries `commit?`**; absent for `path:`, which is what decides the install mode. Not in
  `resolve --json` or `catalog --json`, both of which build records from explicit key lists, so
  **anything that starts spreading a `MergedSkill` into output must exclude `catalogRoot` and think
  about `commit`.**
- **`Catalog` carries `ref?`**, attached by `loadCatalogs` after `parseCatalogDirectory` returns — a fact
  about the config entry, not the directory, so a catalog parsed straight off disk
  (`validate --catalog`) has none.
- **Every command and every flag spec §6 declares is implemented**, consumer and authoring alike, so
  A28's README has the whole surface to document and nothing in `COMMAND_SPECS` is a placeholder.
- **Every source resolves through `src/sources.ts`** (§3.1 grammar) returning
  `ResolvedSource = { root, commit? }`. `loadCatalogs`, `mergeConfigEntities`, `loadSourceSkill` and
  `resolveCatalogRoot` take a `SourceContext` (`{ projectDir, env }`); `env` is where the cache location
  comes from, read once at the boundary (`sourceContextOf(ctx)`, or `process.env` in `planInstall` and
  `projectStatus`).
- **The cache is refreshed only when it cannot resolve the ref** (`src/git.ts`), so `ref: main` pins to
  the commit first seen and a cache hit touches nothing. A refresh needs a new flag, not a change here.
- **`--offline` rides on `SourceContext.offline?: boolean`**, set in exactly three places —
  `sourceContextOf(ctx)`, `planInstall`, and `projectStatus`. It is optional, so **absent means fetching
  is allowed**: a fourth construction site that forgets it would silently reach the network.
- **Offline refuses the clone and the fetch, nothing else** (`notCached` / `refNotCached`, both exit 4).
  `path:` sources never consult the cache at all — which is also why `clean` needs no offline branch.
  Offline turns an unresolvable ref into exit **4** where the fetching path calls it exit 2.
- **Clones are `--mirror`**; checkouts are `git worktree add --detach` into `sources/<key>/<commit>` with
  a `<commit>.ready` sentinel written last. **Nothing ambit does removes anything from the cache,
  `clean` included.**
- Exit codes for sources: **2** for an unrecognized/empty source, a missing `path:` directory, or an
  unusable/unknown ref; **4** for git missing from PATH or a failed clone/fetch/checkout.
- **`Bundle` carries `reasons: SelectionReasons`**, one entry per selected item. Precedence
  **explicit > scope > required-by**. A whole-object `toEqual` on a `Bundle` must include `reasons`.
- **The resolve pipeline is three steps and every call site must run all three**
  (`src/install.ts`, `src/status.ts`, `src/handlers/{resolve,why}.ts`):
  `mergeCatalogs(await loadCatalogs(...))` → `await mergeConfigEntities(...)` → `resolveBundle(...)`.
  Skip the middle one and inline MCPs and source skills silently drop out. `ambit catalog` deliberately
  skips it; its golden JSON is catalog-only.
- **`ProjectConfig.origin` carries `scopeLines`, `skillLines`, `mcpLines`** (name → 1-based line).
  Catalog entries have no line of their own, so their errors say `(ambit.yml)` alone.
- **Duplicate names inside one config list are exit 2 at parse time**, via `nameTracker` in
  `src/config.ts`. Later lists should use it too.
- **`closeOverRequires` throws on the first cycle**, and `resolve` hard-validates the **closure only**
  (spec §4 validation split) — a skill nothing selects may carry a dangling `requires`. `validate`
  walks the **whole** catalog instead, reporting one cycle per back edge (two independent cycles are
  two problems; two cycles sharing a back edge collapse into one).
- **`at(file, line)` lives in `src/errors.ts`.** Errors inside a catalog or skill source cite the
  source-relative path and get a prepended `in catalog "x" (root)` line from `inSource` — for a git
  source that root is the cache checkout, machine-specific, so it must stay out of golden output.
- **`assertScopesRegistered`** runs first inside `resolveBundle`. Suggestions: exact Levenshtein,
  threshold `max(2, floor(len/3))`, ties by the registry's sorted order. **Explicit skill names and
  `ambit why` arguments get no suggestion.**
- `${VAR}` in http `headers` is interpolated at install (spec §5); an unset variable leaves its
  placeholder rather than emptying the value, and **`doctor`'s `env` check reports it**, reading the
  leftover placeholder off the plan. `status` interpolates
  from the same `process.env`, so a variable that changed between two runs *is* drift.
- **`ProjectPaths` carries `env` and `mode?`**, both supplied by `planInstall` (and `env` by
  `projectStatus`), so `claudeAdapter.plan` stays pure.

## Deliberate omissions, and who owns them

- **Every *other* flag rule A30 unblocked stays in its handler**, and only `install`'s
  `--copy`/`--link` moved onto Commander (that is all A30's Done-when named). `catalog scope add`'s
  required `--description`, `mcp new`'s "exactly one transport" and every transport-flag refusal, and
  `annotate`'s add-and-remove contradiction are all still handler checks — deliberately, because each
  message names a file and gives a next step where Commander's would say
  `error: required option '--description <text>' not specified` and nothing else. Nobody owns moving
  them, and their tests pin the current wording.
- **A Commander usage error ends with the program's `(run \`ambit --help\` for usage)`**, even when the
  error was in `catalog scope add`, because `showHelpAfterError` is one of the settings inherited
  wholesale. Accurate but coarse; a per-command hint would mean re-applying the setting after the copy
  with the command's full name. Nobody owns it.
- **Nothing removes a catalog's top-level directories**, `skills/` and `mcps/` included, even when the
  last thing inside one goes away — see the editor's ancestor pruning. Nobody owns changing that.
- **`skill new` writes no scope registration and `skill rm` removes none.** A skill declaring a scope
  nothing registers is refused, not fixed; the registry is `catalog scope`'s.
- **`mcp new` declares no scopes**, because the surface spec §6 gives it has no `--scope`: what it writes
  is reachable only through a skill's `requires` until someone gives it a `scopes` entry, and the
  command's closing line says exactly that. `annotate --add-scope` is now how a server gets one, but that
  closing line still says "add a `scopes` entry to `mcps/<name>.yml`" rather than naming the command —
  nobody owns changing it, and `test/catalog-mcp.test.ts` pins the line byte-for-byte. `mcp rm` closes with
  **nothing**, deliberately: no project's `ambit.yml` can name a catalog's server (§3.1's `mcps` declares
  one rather than selecting one), so there is nothing for its author to update.
- **`declarersOf` in `src/catalog-scope.ts` still names an entity through `mcpDocumentPath`**, so `scope rm`
  refusing because a `.yaml` entity declares the scope cites `mcps/<name>.yml` — a file that is not there.
  Message-only (nothing is written on that path), one call site, and it needs `declarersOf` to become
  async. Nobody owns it.
- **Removing an entity file prunes no directory.** `pruneEmptyAncestors` runs for tree changes only, so a
  catalog whose last server was removed keeps an empty `mcps/` — which is its shape, not its contents.
- **`scope rm`'s refusal still tells the reader to edit each declarer by hand**, though
  `annotate --remove-scope` now does exactly that. Naming it there would be an improvement nobody owns;
  `test/catalog-scope.test.ts` pins the current wording.
- **`catalog init` scaffolds no example skill and no example MCP entity**, so a fresh catalog installs
  nothing: `catalog skill new` is the next step and the command's own output says so. It also runs
  no `git init` and writes no `.gitignore` — a catalog has nothing generated to ignore, and the directory
  is usually already a repo. Nobody owns changing either.
- Nothing prunes the cache, and nothing locks it against a concurrent ambit (`loadCatalogs` is
  sequential for that reason). No task owns cache GC; raise it if it matters.
- **`prune` leaves `ambit.lock` stale**, and `doctor`'s `lock` check is the only thing that says so;
  `clean` leaves the lock, an emptied `mcpServers`, and an empty `.claude/skills`, and nothing reports
  any of those three. All deliberate (see above).
- **Nothing persists a materialization mode.** `--copy`/`--link` are per-run (spec §5) and there is no
  config key for them. Fixing that is a config change and a spec change, not an adapter change.
- `status` reports artifacts only: no lock drift, no env vars, no mode divergence — those three are
  `doctor`'s. **No command reports the configured harnesses**, and none owns that; `validate` adds none
  of the four.
- **Nothing says which catalog registered a scope.** `mergeCatalogs` keeps that only long enough to
  raise the description conflict (`RegisteredScope` is internal), so `scopes` cannot report it and
  neither can `catalog`. `catalog tree` and `catalog audit` work on **one catalog directory**, so they need
  none of this; a merged view that wanted per-scope provenance would have to widen `ScopeDefinition`.
- **`ambit scopes` still says nothing about what a scope *selects*** — no counts, no item lists. That is
  `catalog tree`, which is per-catalog and takes `--catalog`; nothing merges the two views, and nobody owns
  doing so.
- **`validate` still says nothing about reachability and `audit` still says nothing about validity**,
  and neither should learn the other's findings — see the audit bullet above. `catalog tree` shows the
  *shape* only, so an empty scope reads as `0 direct  0 inherited` there and is a *finding* only in
  `audit`.
- **`catalog audit` judges one catalog directory, so it cannot see a project.** An item a project lists
  explicitly in `skills`, or one an *other* catalog's skill requires, is reachable in that project and
  still reported here — the honest answer for a catalog repo's own CI, and the reason the command takes
  `--catalog` rather than `--project`. Nobody owns a merged-view audit. It also reports nothing about a
  scope that is registered and *held nowhere*: no catalog can know that.

## Traps

- **`test/editor.test.ts` asserts whole files, deliberately.** Its round-trip case loops over every
  entry of `FIXTURE_CATALOG_FILES` bar the marker, so adding a fixture file adds a case for free — and a
  fixture written in a style the editor cannot re-emit (a block scalar, an anchor) will fail there
  first. Its annotated-skill fixture (`ANNOTATED_SKILL`) carries `allowed-tools`, a comment above it, a
  flow list, a block list, and a body precisely because those are the five things rule 2 protects.
- **The editor's refusal messages are pinned byte-for-byte** in that file, including
  `refusing to write outside the catalog: "<path>"` and
  `refusing to write: the result would not validate`. Reword one and update the test in the same commit.
- **`test/catalog-init.test.ts` pins the scaffold's file list *and* the command's exact stdout.** Adding
  or renaming a scaffolded file means editing `SCAFFOLD_FILES` there — deliberately, since a scaffold
  that quietly grows a file is a scaffold nobody reviewed. `REGISTRY_VALUES` and the workflow's values
  are restated in the test rather than imported, so the emitted-shape claim is independent of the source.
- **`test/diff.test.ts` asserts the renderer's exact lines**, elision marker and context width included.
  Changing `CONTEXT_LINES` or the tie-break rewrites several of its cases; that is the point.
- **`test/catalog.test.ts`'s `UNBUILT` table is gone** — B09 built the last row. The guarantee it
  carried lives on as one case that removes `"catalog tree"` from `HANDLERS` and asserts exit 1, so the
  `notImplemented` path stays covered now that no real gap exists. Its `SUBCOMMANDS` list still pins
  that `ambit catalog --help` names all eight subcommands.
- **`test/catalog-audit.test.ts` builds its subject with the authoring commands** (`catalog init`,
  `scope add`, `skill new`, `mcp new`, `annotate`), which makes it a round trip over B03–B07: a command
  that stops writing something the parser reads back fails here too. Two cases are load-bearing beyond
  their assertions — one asserts `ambit validate --catalog` is clean on the same catalog the audit
  reports three findings against (the split), and one renames a fixture entity to `.yaml` before
  auditing it (the claim `mcpFiles` exists for). The first case pins the whole text report
  byte-for-byte, wording of all three next-step lines included.
- **`test/catalog-tree.test.ts` pins the text report's exact column padding** and carries its own copy of
  `expectGolden` (`test/golden/catalog-tree.json`, regenerated by the same `UPDATE_GOLDEN=1 npm test` the
  resolve goldens use — read it, it is short). Its last case is the load-bearing one: it rebuilds the tree
  in-process and asserts, per scope, that `direct ∪ inherited` equals what `expandHeldScopes` selects, so
  the view cannot drift from the resolver. Two cases deepen the fixture's registry by appending to
  `scopes.yml` in the per-test copy (`function`, `person.jane`); the shared fixture's four scopes are
  untouched, which `test/validate.test.ts` depends on.
- **`test/catalog-mcp.test.ts` restates the values it expects emitted** rather than importing them, so the
  "the whole file is `emitYaml` of these values" claim is independent of the source — the `catalog init`
  trick. Two cases are load-bearing beyond their assertions: one renames a fixture entity to `.yaml`
  before `rm` (the claim `mcpDocumentFile` exists for), and one asserts `--arg` order survives while
  `--env` is sorted, which is the only place that asymmetry is pinned.
- **`test/catalog-annotate.test.ts` asserts whole documents with exactly one substitution**, which is the
  only way to catch an edit that also reflowed a list or moved a key. It carries its own annotated-skill
  fixture (`CLOSE_SKILL_TEXT`, the same shape `test/editor.test.ts` uses) rather than adding one to
  `scripts/fixture-catalog.ts`, so the shared fixture's counts stay put. Three cases are load-bearing
  beyond their assertions: one renames the fixture entity to `.yaml` before annotating it, one asks to add
  an entry an *unsorted* list already holds and asserts the file is byte-identical (the claim that only a
  membership change is written), and one removes an unregistered scope from a skill it first breaks — the
  reason `--remove-scope` has no registry pre-check. Anything pointing a new `requires` at
  `acme.projects.use-acme-brief` will hit the fixture's own cycle; use `acme.engineering.use-code-review`.
- **`test/catalog-skill.test.ts` asserts what happened to *paths*, not only to bytes.** Its `snapshot()`
  is files-with-bytes and its `directories()` is the directory list, and both are load-bearing: the
  "writes one SKILL.md and nothing else" case asserts the whole file list, and two cases assert that an
  emptied namespace directory is gone while `skills/` is not. One case writes a **non-UTF-8** file into a
  skill and compares the buffer after a `mv` — that is the claim the tree machinery exists for, and it
  fails the moment anything reads a skill's assets as text. Its `halves()` splits a `SKILL.md` so the
  frontmatter can be compared against `emitYaml` of restated values (the `catalog init` trick) while the
  body's prose stays free to change.
- **`test/editor.test.ts`'s no-op case does a whole-object `toEqual` on `EditResult`**, so it now names
  `trees: []`; a further field on that type means editing it again.
- **`test/catalog-scope.test.ts` asserts whole files against `FIXTURE_CATALOG_FILES`' own text**, and its
  `mv` case names each expected file separately *on purpose*: two fixture skill bodies mention
  `function.engineering` in prose, so a blanket `replaceAll` over the fixture would pass against an edit
  that rewrote the body — the exact bug rule 2 forbids. One assertion pins that prose explicitly. Its
  `refused()` helper snapshots the whole tree around every rejection, so a refusal that half-wrote
  something fails there rather than in a later case.
- **`test/catalog.test.ts`'s `describe("usage errors below the top level")` is the guard on
  `inheritSettings`**, and it is asserted two levels down (`catalog scope add`) on purpose: a top-level
  command could pass by accident. Four cases — an unknown flag (with Commander's own "did you mean"),
  a missing positional, an unknown flag on a top-level command, and `--help` — plus the byte check that
  the refused mutation left `scopes.yml` alone. Delete `inheritSettings` and all four fail by taking the
  worker down rather than by reporting, which is the shape of the failure to expect.
- **A test may now omit a declared positional or misspell a flag and still get an exit code back.**
  Before A30 that killed the vitest worker; the old discipline ("every invocation supplies all
  positionals") is no longer load-bearing, though nothing depends on breaking it either.
- **`ambit catalog --help` and each subcommand's usage are read by running `--help` through `run()`**
  (the `usage(...)` helper in `test/catalog.test.ts`), which is what A30 made possible; the
  `helpInformation()`-off-`buildProgram` workaround is gone, and `buildProgram` is no longer imported
  there.
- **`test/catalog.test.ts`'s `cli()` appends `--project`, which an authoring command does not accept.**
  Use `invoke(argv)` for anything under `catalog` other than `dump`, or Commander will reject the flag —
  now as exit 2 rather than by exiting the worker.
- **Two tests pin that `ambit catalog` and `ambit catalog dump` emit identical stdout**, text and
  `--json`. They are the guard on the group's default action, so a change to either path must keep
  going through `catalogHandler`.
- **Nothing may reach the network (spec §7).** Git tests use `buildFixtureGitCatalog`'s local bare repo,
  whose commit SHA is fixed by pinned dates and `GIT_CONFIG_GLOBAL=/dev/null`. A test needing a
  *rejected* source must pick one no fetch can be attempted for — a bare relative path like
  `../catalog` is unrecognized (`path:` is the prefix), whereas `acme/skills` resolves to a GitHub URL.
- **Every test walker follows symlinks** — `tree`/`snapshot`/`installedSkills` in
  `test/install.test.ts`, `snapshot` in `test/status.test.ts` and `test/clean.test.ts`, `installed` in
  `test/git-source.test.ts`. A `readdir`-dirent walk reads a linked skill as a *file* and then fails with
  `EISDIR`, so a new walker must `stat` (not `lstat`) each entry.
- **Three places deliberately pass `--copy`, and the claim collapses without it:**
  `test/install.test.ts`'s "replaces an owned skill directory rather than merging into it",
  `test/status.test.ts`'s whole `describe("ambit status after a manual edit")` block, and
  `test/git-source.test.ts`'s byte-for-byte git-vs-path comparison.
- `test/install.test.ts`'s **`describe("idempotence")`** snapshots *every file in the project* and
  asserts the file list too, in `PROJECT_FILES` — eight entries. The test is meant to fail when a new
  file appears, so extend the list deliberately rather than loosening it.
- `test/install.test.ts`'s **`describe("ambit install --dry-run")`** asserts that the preview's stdout is
  the real install's stdout plus exactly two sections (`pruned`, `files`). That is the claim that a dry
  run is a print of the same plan and not a second rendering of it, so if install's text output changes,
  fix install — do not relax this. Its "writes nothing at all" case asserts the whole project snapshot,
  because a preview that wrote only the lock or only state would pass a narrower check.
- `test/clean.test.ts` pins the exact text and `--json` of both `prune` and `clean`, including the
  padded three-column rows and `clean`'s two sections (`removed`, `records`). Its two strongest cases
  are the negative ones: `prune` on a never-installed project writes **no** files at all, and `clean`
  succeeds with `ambit.yml` deleted.
- `test/status.test.ts` asserts the exact four-cell table with the detail cell trimmed away on a clean
  project, and most cases assert the **whole** report through `states()` so a new row cannot appear
  unnoticed.
- `test/install.test.ts`'s **`describe("pruning")`** narrows a profile between two installs and asserts
  *both* directions every time. Its managed-key error case has to keep owning `mcpServers.scoped` in the
  state it writes, or ownership enforcement refuses the install before pruning is reached.
- `test/catalog.test.ts` owns the **second-catalog fixture**: `writeShadowingCatalog(name, coreDesc?)`
  and `writeCatalogOrder(extra, scopes)`. Its `core` and `function.engineering` descriptions must stay
  byte-identical to `scripts/fixture-catalog.ts`'s or every multi-catalog test fails with the §4.4
  conflict.
- `test/git-source.test.ts`'s `--offline` block proves "no fetch" **by leaving the remote in place**;
  two of its tests instead delete `fixture.repo` to prove the cache alone answered. Keep both
  directions. Its `installed()` skips **`PER_SOURCE_FILES` = `ambit.yml` + `ambit.lock`**.
- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. **Plain `--json` carries neither `reason` nor `shadows`.** One selection
  change touches several goldens, so regenerate with `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- `test/lock.test.ts` asserts the **exact bytes** of the lock for two profiles.
- `writeProfile` differs per file: `(scopes, extra?)` in `test/resolve.test.ts` and `test/lock.test.ts`,
  `(scopes, harnesses?, extra?)` in `test/install.test.ts`, `(scopes)` in `test/status.test.ts` and
  `test/clean.test.ts`; `extra` lines always land **after** the scopes list so the
  `FIRST_SCOPE_LINE`/`FIRST_EXTRA_LINE` line math holds. `test/git-source.test.ts` has its own
  `writeProject`.
- `test/install.test.ts`'s **`describe("ownership")`** asserts what is still on disk after every refusal,
  not just the exit code. Because the check reads `.mcp.json` before anything is written, a malformed
  `.mcp.json` fails before any skill lands.
- `test/install.test.ts`'s, `test/status.test.ts`'s and `test/clean.test.ts`'s default profile is
  `[core, function.engineering]`, which selects the `scoped` http server — so it writes `.mcp.json` too,
  and four artifacts set the column widths. Those three files stub `SCOPED_API_KEY` to `undefined` in
  `beforeEach` because the fixture interpolates it into a header. Any new test that installs and asserts
  file contents needs the same discipline.
- **`test/doctor.test.ts` stubs env vars per `describe`, not in the shared `beforeEach`**, because which
  of them are set is the subject of the first check. The trap is the interaction with the others: the
  env-failure block installs with **both vars unset** so `.mcp.json` holds the placeholder and the
  `drift` check stays quiet, while every other block sets both **before** installing. Set a var after
  the install and `.mcp.json` becomes `modified`. Its healthy case pins the whole five-row `checks`
  table plus both empty finding lists byte-for-byte, so a new check means editing `HEALTHY_REPORT`.
- **The fixture catalog must stay cycle-free, dangling-free, reachable-in-full, and exactly 4 scopes /
  4 skills / 2 mcps**: `test/validate.test.ts` asserts `ambit validate` against it reports byte-for-byte
  `checked 4 scopes, 4 skills, 2 mcps` and `problems (0)`, `test/catalog-audit.test.ts` asserts
  `audited 4 scopes, 4 skills, 2 mcps` and `findings (0)` — so a new fixture skill needs a registered
  scope or a requirer, and a new fixture scope needs a declarer — and several of validate's cases add
  one item and assert the count went up by one. Adding anything to `scripts/fixture-catalog.ts` means updating the
  three constants at the top of that file. Every golden profile resolves it too. Tests needing extra
  catalog shapes write them into the per-test copy
  rather than into `scripts/fixture-catalog.ts`. **Under link mode a test that edits an installed skill
  edits the fixture copy**, which is per-test and disposable — but the edit is visible to the catalog
  immediately.
- **`test/init.test.ts` asserts the scaffold's *shape*, never its prose**, except for two regexes on
  the comment block directly above `scopes:` (`/nothing is implicit/i`, `/descendants only/i`). Reword
  the comments freely; keep those two ideas in that block. Its `uncommented()` helper spots the
  commented-out example by `/^# (?:catalogs:| )/`, which works only because prose lines never begin
  with a space after `# ` — a reflowed comment starting with an indent would break it.
- **`test/scopes.test.ts` writes a second catalog that is a `scopes.yml` and nothing else**, whose
  `core` description must stay byte-identical to `scripts/fixture-catalog.ts`'s or `mergeCatalogs`
  raises the §4.4 conflict. It also hardcodes all four fixture descriptions, so renaming one there
  means updating them here.
- The text output of every command is asserted with exact column padding from `src/output.ts`.
  `--explain` adds a **third and a fourth** cell to the skills and mcps rows; `why`'s chain pads the name
  column across skills and MCPs together.
- `ambit why` reads a bare name as a skill and an `mcp.`-prefixed one as a server — the same
  disambiguation `requires` uses. `MCP_REQUIREMENT_PREFIX` is exported from `src/resolve.ts` for it.
