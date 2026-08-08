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
