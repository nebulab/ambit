# Carry-forward notes

Rewritten by each Ralph iteration for the next one. Short, current, and only what would cost
real time to rediscover — see `PROMPT.md` §6.

Last iteration: **A08 — Unknown-scope detection** (`d12505f`).

## Constraints later tasks inherit

- **`ProjectConfig` carries `origin: ConfigOrigin { file, scopeLines }`.** Resolution runs after
  parsing, so no YAML node survives to cite; `origin` carries the config's filename (`ambit.yml`
  vs `ambit.yaml`) and the 1-based line of each held scope. Later post-parse errors — A11's
  unresolvable explicit skill, A15's conflicting descriptions — should extend `ConfigOrigin` the
  same way (`skillLines`, …) rather than re-reading the document.
- **`at(file, line)` lives in `src/errors.ts`** (degrades to `(file)`), not in `yaml.ts`. Any
  module raising a positioned error uses it. Deliberately not re-exported from `src/index.ts`.
- **`YamlMapping.optionalPositionedStringList(key)`** returns `PositionedString { value, line? }`;
  `optionalStringList` is defined in terms of it. Use it for any list whose entries a later
  stage judges.
- **`assertScopesRegistered(config, registered)`** is exported from `src/resolve.ts` and runs
  first inside `resolveBundle`, so `install` is guarded too. It throws on the first
  (alphabetically first) offender — **A23's `validate` needs a multi-problem variant.**
  `expandHeldScopes` stays total: an unregistered scope still expands to nothing.
- Suggestion policy for unknown scopes: exact Levenshtein, threshold `max(2, floor(len/3))`,
  ties broken by the registry's sorted order. Holding an unregistered *parent* (bare `function`
  when only `function.engineering` is registered) is an unknown scope — the registry, not the
  dotted-name shape, decides what may be held.
- **`MergedSkill.catalogRoot` (absolute) must stay out of every output surface.** It exists so
  the adapter can copy skill directories, and is excluded from `resolve --json` and
  `catalog --json` so golden files stay machine-independent.
- **`Bundle.scopes` reports the held scopes as configured, not the expansion.** A12's
  `--explain`/`why` must derive the chain held → descendant → item from `config.scopes` plus the
  registry.
- **`expandHeldScopes(held, registered)` expands against the registry**, so `scopes.yml` stays
  the only authority on tree shape. Subtree matching is separator-aware on purpose:
  `function.engineering` must never swallow `function.engineering-legacy`.
- **`PlannedArtifact` carries both `path`** (project-relative — the state identity) **and
  `target`** (absolute), which is what lets `apply(plan, prior)` match the spec §5 signature
  without a project argument. A10 extends this union with a `harness-config` variant;
  `src/state.ts` already models `managedKeys`.

## Deliberate omissions, and who owns them

- `apply` removes a target only when `prior` state already owns it. Refusing unowned targets and
  `--adopt` are **A17**; pruning is **A18**. `install` adds and overwrites but never removes.
- No `.gitignore` handling at all — **A21**.
- Unimplemented flags throw exit 1 "not implemented yet" from an `UNIMPLEMENTED` map in
  `src/handlers/install.ts` (`--dry-run`, `--frozen`, `--adopt`, `--copy`, `--link`) and from the
  handler itself for `resolve --explain`. **When your task implements one, delete its entry from
  that map — and `test/install.test.ts` has a loop asserting all five, so remove the matching
  case there too.**

## Traps

- `test/resolve.test.ts` pins `resolve --json` for six scope profiles against
  `test/golden/resolve/*.json`. One selection change touches several at once; regenerate with
  `UPDATE_GOLDEN=1 npm test` and read the whole diff.
- The text output of `resolve` and `catalog` is asserted with exact column padding, built by
  `src/output.ts`. Adding an artifact to a fixture profile shifts those assertions.
- Whole-object `toEqual` assertions on `ProjectConfig` in `test/config.test.ts` must be updated
  whenever the config type gains a field.
