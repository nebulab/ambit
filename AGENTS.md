# AGENTS.md

Guidance for AI agents working in this repository.

## Documentation

### The readme

`README.md` is the only user-facing document. There is no `docs/` directory, and adding one is not
the fix for a long readme: fold the content in or cut it.

A readme answers three questions, in this order:

1. **What is this tool?**
2. **Why does it exist?**
3. **How do I use it?**

Everything in the file has to serve one of those three. If a paragraph serves none, delete it.

**Do not write:**

- **Internals.** How resolution is implemented, what is recorded in `.ambit/state.json`, how ambit
  identifies its own entries in a JSON array, which order the resolver walks in. A user does not
  read the readme to learn the algorithm.
- **Historical evolution.** What a feature replaced, what the syntax used to be, why a leftover file
  from an older version is refused. The readme documents the tool as it is today. Git history holds
  the rest.
- **Design justification.** Arguments defending a decision against alternatives the reader never
  proposed: why an entry names its namespace, why two lists instead of one, why there is no
  `ambit catalog` command. State the rule, show an example, move on.
- **Editorializing.** "That is deliberately the author's call." "Which is the answer you wanted."
  "The trade is deliberate." Describe behavior, not your feelings about it.

**Do write:**

- Working examples with real output. A reader copies these.
- Tables for every field, flag, and exit code. Reference material earns its length.
- One short sentence of rationale where a rule would otherwise look arbitrary. One sentence, not a
  section.

**Style:**

- Plain sentences. No em dashes.
- Behavior a user can observe, in the words they would use for it.
- Update the readme in the same change that alters the behavior it documents.

### Everything else

Comments in the source are where internals belong. A comment explaining why the code is shaped a
certain way is good and should stay in the code, not migrate to the readme.

## Code comments

Ambit is a commented codebase, but comments must earn their place. A comment exists to tell the
reader something the code cannot: keep the reasoning, cut the rhetoric.

### What to write

- **Doc comments on exported symbols.** TSDoc (`/** */`), one-sentence summary first. Describe the
  contract from the caller's side: constraints, return semantics, side effects, `@throws` with exit
  codes. Skip the doc comment entirely when the name already says everything.
- **Why, not what.** Rationale for a non-obvious decision, ordering requirements, invariants,
  units, what a sentinel value means, why the obvious alternative was rejected.
- **Negative information.** What is deliberately absent ("no lock here: callers already hold it"),
  so a future "fix" doesn't reintroduce a bug.
- **File headers only for real design.** A short block stating the module's design decisions and
  invariants, once. Most files need no header. Never repeat in the header what per-symbol docs
  already say.

### What not to write

- **Editorializing.** State the fact; don't argue for it or perform it. No flourishes, metaphors,
  or persuasion ("that is the point", "a standing bet that...", "the kind of waste a cache exists
  to avoid"). If a comment reads like an essay, cut it to the fact it contains.
- **Restating the code.** No doc comment that rephrases the symbol name
  (`/** Where skills live. */` on `SKILLS_DIRNAME = "skills"`). Delete, don't decorate.
- **Play-by-play.** Never narrate what the next line does.
- **Reviewer-directed commentary.** No comments explaining why a change is correct or what the code
  did before. That belongs in the PR description.
- **Commented-out code, change journals, section banners.**

### Style

- Short, plain, factual sentences. Capitalized and punctuated.
- Prefer separate sentences over clauses chained with em dashes.
- One canonical explanation per decision; elsewhere, point to it with `{@link}` instead of
  retelling it.
- Reference constants by name (`{@link STALE_THRESHOLD}`), never restate their value in prose.
- When changing code, update or delete every adjacent comment your change touches.
