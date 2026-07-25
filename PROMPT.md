# Ralph loop — iteration prompt

You are running **one iteration** of the Ralph loop in this repository. You are invoked with no
context beyond this file, so everything you need to know is here or on disk.

## 1. Orient

Read, in this order:

1. **`PLAN.md`** — the complete build specification. Its §8 "Loop protocol" governs your
   behavior; follow it exactly. Everything else in the document is the brief the code must
   satisfy, and source comments reference it by section (`spec §3.0`, `§4.6`, …).
2. **`NOTES.md`** — the previous iteration's handoff: decisions that constrain you, traps, and
   anything left deliberately unfinished. Trust it, but verify against the code before relying
   on a detail.
3. **The code you are about to touch.** Never write into this repo without reading its
   neighbours first.

## 2. Take exactly one task

The topmost unchecked task in §8, skipping any whose `Depends` are unchecked. One task — not
two, not the easy half of a third.

Do **only** what the task says. No opportunistic refactoring, no work belonging to a later
task, no "while I'm here". If you notice something out of scope that matters, write it in
`NOTES.md` for a later iteration instead of doing it.

## 3. Match the house style

This codebase has a consistent voice. Read a neighbouring module and copy it:

- **Module-level doc comment** on every file, explaining *why* the module exists and what
  tradeoff it encodes — not a restatement of its exports. Reference the spec section it
  implements (`spec §4.6`).
- **JSDoc on exported functions**, with `@throws` wherever an error path exists.
- **Every error goes through `src/errors.ts`** and satisfies spec §6: name the offending file,
  name the offending identifier, and give one concrete next step. Never throw a bare `Error`
  on a user-reachable path.
- **Determinism is a requirement, not a preference** (spec §4): sort every collection before
  iterating, never depend on object key order, never emit a timestamp, never let filesystem
  read order reach output.
- **TypeScript:** no `any`, no non-null assertions you can avoid, `exactOptionalPropertyTypes`
  is on (build optional properties with `...(x !== undefined && { x })`),
  `noUncheckedIndexedAccess` is on.
- **Comments earn their place.** Explain the reasoning a reader cannot recover from the code.
  Do not narrate what the next line plainly does.

Tests live in `test/*.test.ts`, follow the existing `describe`/`it` phrasing (a full sentence
about behavior, not "works correctly"), and build the fixture catalog into an `mkdtemp`
directory. Everything runs offline (spec §7).

## 4. Prove it

Run every check under the task's **Done when**, plus all four of:

```
npm test
npm run typecheck
npm run lint
npm run build
```

Fix every failure before you tick anything.

**Do not weaken, skip, or delete an existing test to get green.** If a task legitimately
changes behavior an existing test pins, update that test *and say so explicitly in your
report*, with the reason it was wrong as written. Silently relaxing an assertion is the one
unrecoverable failure mode here: it destroys the guarantee that the suite means something.

Golden files live in `test/golden/` and regenerate with `UPDATE_GOLDEN=1 npm test`. If your
task legitimately changes what `resolve` selects, regenerate them, then **read the diff** and
confirm every change is one your task intended. Never hand-edit a golden file.

## 5. Land it

1. Tick the task's checkbox in `PLAN.md`.
2. Rewrite `NOTES.md` for your successor (see §6).
3. Commit **everything** on the current branch — `main`; every task so far was committed
   directly to it. Message format:

```
type(scope): description (Axx)

A short body explaining the substance of the change, and any decision a
reviewer would otherwise have to reverse-engineer.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

If you are genuinely blocked, add `> BLOCKED: <reason>` under the task, leave the checkbox
unchecked, commit that, and report it. A blocked task is a normal outcome; a task ticked
without its checks passing is not.

## 6. Hand off

Rewrite `NOTES.md` so the next iteration starts where you finished. Keep it short and
current — it is a handoff, not a changelog; `git log` already exists. Include only what would
cost the next agent real time to rediscover:

- Decisions that constrain later tasks (a type that gained a field, an invariant now relied on).
- Deliberate omissions, and which task owns them.
- Traps: a test that is subtle, a flag wired to a placeholder, a file that must stay out of
  some output surface.

Drop anything a later task has since made irrelevant.

## 7. Report

Your final message is all your caller sees, and it is read by someone who will not open your
transcript. Be compact and factual:

- The task ID and title.
- Files added and changed.
- Which **Done when** checks you ran, and their results — including the four commands above.
- The commit hash.
- Anything the caller must know: BLOCKED reasons, existing tests you changed and why, a
  decision worth a second opinion.

Report what actually happened. If a check failed and you could not fix it, say so plainly
with the output — an overstated report is worse than a failed iteration, because it spends the
next agent's time on a false premise.
