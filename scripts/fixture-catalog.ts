/**
 * Builds the fixture catalog every test resolves against (everything must be
 * testable offline).
 *
 * The catalog is a plain skills repo — skills at `skills/<name>/SKILL.md`, MCP
 * entities at `mcps/<name>.yml`, hooks at `hooks/<name>/hook.yml`, packs at `packs/<name>.yml`, and
 * no config of its own — so it doubles as the subject of the dotagents compatibility test (A26):
 * everything but `skills/` is additive, and a tool that reads only skills must be unbothered by it.
 *
 * The packs are what selection runs through. Nothing in a catalog labels itself any more, so a
 * consumer's entry names either an item outright or a **pack** — a document that names the items —
 * and the fixture ships four, one of them nested two directories deep so the `packs/**` walk and the
 * name it derives are both exercised.
 *
 * It also builds that same catalog as a **local bare git repository**, which is how the git-source
 * tests stay offline: a `file://` URL is a git URL like any other, so nothing in ambit needs a test
 * mode to be exercised against one.
 *
 * Tests call `buildFixtureCatalog()`. To eyeball the fixture, `bun run fixture <dir>` runs it
 * directly.
 */
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Written at the catalog root so a rebuild knows the directory is ours to delete. Dotfiles
 * are invisible to catalog parsing, which reads only `skills/**`, `mcps/*`, `hooks/**` and
 * `packs/**`.
 */
export const FIXTURE_MARKER = ".ambit-fixture";

const CORE_SKILL = `---
name: company-context
description: Canonical context about Acme — what it sells, to whom, and how it works.
---

# Acme company context

Reached through the \`core\` pack, and pulled in by \`requires\` from the project skill even when
nothing selects that pack at all.
`;

const ENGINEERING_SKILL = `---
name: code-review
description: How Acme reviews code — what reviewers look for, and in what order.
---

# Code review at Acme

A member of the \`function.engineering\` pack, and of no other. The \`core\` pack must not reach it.
`;

const FRONTEND_SKILL = `---
name: design-tokens
description: Acme's design tokens — color, spacing, and the type scale.
ambit:
  expects:
    - env: ACME_FIGMA_TOKEN
---

# Design tokens

Belongs to \`function.engineering.frontend\`, one dot below \`function.engineering\` and reached by
neither that pack nor an exact-name entry for it: a pattern without a \`*\` is an exact match, so
\`pack: function.engineering\` leaves this behind and \`pack: function.engineering.*\` leaves the
narrower one's parent behind. Both together is two entries. The dot is a character, not a level.
`;

const PROJECT_SKILL = `---
name: acme-brief
description: The Acme engagement brief — remit, contacts, and conventions.
ambit:
  # Unqualified, because a catalog author cannot write a consumer's alias — so each entry resolves
  # within this catalog. Exact names here: a pattern with no wildcard is one item, exactly.
  requires:
    - skill: company-context
    - mcp: fixture
    - hook: acme-standup
---

# Acme engagement brief

Reaches a skill, an MCP server and a hook that no entry a test writes selects on its own, so the
\`requires\` closure is the only thing that can pull them in — a skill's \`requires\` and a pack's
being the same grammar and the same closure.
`;

const REQUIRED_MCP = `name: fixture
# In no pack: reachable only because acme-brief requires it.

transport:
  stdio:
    command: npx
    args: ["-y", "@acme/fixture-mcp"]

expects:
  - env: FIXTURE_API_KEY
`;

const PACKED_MCP = `name: linter
# A member of the \`function.engineering\` pack, which is the only thing that reaches it.

transport:
  http:
    url: https://mcp.invalid/fixture
    headers:
      Authorization: "Bearer \${LINTER_API_KEY}"

expects:
  - env: LINTER_API_KEY
`;

const COMMAND_HOOK = `name: session-notes
description: Reminds a session that Acme's conventions apply.

event: SessionStart
# \`type: command\` means the harness runs this verbatim and nothing is looked for on disk. The
# hook's directory holds nothing but this file.
type: command
command: echo "acme conventions apply"
`;

const SCRIPT_HOOK = `name: guard-secrets
description: Inspects a Bash command before Acme's tooling runs it.

event: PreToolUse
matcher: Bash
# \`type: script\` names \`guard.sh\`, which this directory ships, so the script is materialized
# under \`.agents/hooks/guard-secrets/\` and the command is rewritten to point at it.
type: script
command: guard.sh
timeout: 10
`;

const HOOK_SCRIPT = `#!/bin/sh
# Shipped by hooks/guard-secrets, which is what makes it the fixture's only hook that installs
# bytes rather than config values. Inert on purpose: it reads the tool call it is handed and
# allows it, so what is being exercised is materialization and not the guard.
cat >/dev/null
exit 0
`;

const REQUIRED_HOOK = `name: acme-standup
# In no pack: reachable only because acme-brief requires it.
description: Records what the session touched, for the Acme standup.

event: SessionEnd
type: command
command: echo "acme session ended"
`;

const CORE_PACK = `name: core
description: What every Acme session needs, whoever is in it.

requires:
  - skill: company-context
  - hook: session-notes
`;

const ENGINEERING_PACK = `name: function.engineering
description: Everything an Acme engineer needs — reviews, tooling, and the guards around them.

# A pack requires other packs as readily as it requires items, which is what lets a catalog build a
# large grouping out of small ones instead of restating the small one's membership.
requires:
  - pack: core
  - skill: code-review
  - mcp: linter
  - hook: guard-secrets
`;

const FRONTEND_PACK = `name: function.engineering.frontend
description: What an Acme engineer working on interfaces needs on top of the engineering pack.

requires:
  - pack: function.engineering
  - skill: design-tokens
`;

const PROJECT_PACK = `name: project.acme
description: The Acme engagement — its brief, and whatever the brief drags in.

requires:
  - skill: acme-brief
`;

/** Every file in the fixture, keyed by its path relative to the catalog root. */
export const FIXTURE_CATALOG_FILES: Readonly<Record<string, string>> = {
  [FIXTURE_MARKER]: "generated by scripts/fixture-catalog.ts — safe to delete\n",
  "hooks/session-notes/hook.yml": COMMAND_HOOK,
  "hooks/guard-secrets/hook.yml": SCRIPT_HOOK,
  "hooks/guard-secrets/guard.sh": HOOK_SCRIPT,
  "hooks/acme-standup/hook.yml": REQUIRED_HOOK,
  "mcps/fixture.yml": REQUIRED_MCP,
  "mcps/linter.yml": PACKED_MCP,
  // Flat, nested one deep, and nested two deep, so the `packs/**` walk and the name it derives from a
  // path are both exercised by the catalog every other test resolves against.
  "packs/core.yml": CORE_PACK,
  "packs/function/engineering.yml": ENGINEERING_PACK,
  "packs/function/engineering/frontend.yml": FRONTEND_PACK,
  "packs/project/acme.yml": PROJECT_PACK,
  "skills/company-context/SKILL.md": CORE_SKILL,
  "skills/code-review/SKILL.md": ENGINEERING_SKILL,
  "skills/design-tokens/SKILL.md": FRONTEND_SKILL,
  "skills/acme-brief/SKILL.md": PROJECT_SKILL,
};

/**
 * The files the fixture writes executable rather than `0o644`.
 *
 * A hook script the harness cannot execute is a hook that does not run — Claude Code dispatches it
 * and `/bin/sh` answers `Permission denied` — so the bit is part of what a catalog ships, exactly
 * like the bytes. Without it the fixture's one script-shipping hook installs correctly and still
 * cannot fire, which is what the manual end-to-end in `plan.md` §Verification found.
 */
export const FIXTURE_EXECUTABLE_FILES: readonly string[] = ["hooks/guard-secrets/guard.sh"];

async function isEmptyDirectory(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clears the target so a rebuild cannot leave stale files behind, refusing any directory the
 * builder did not create.
 */
async function clearTarget(dir: string): Promise<void> {
  if (!(await pathExists(dir))) return;

  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw new Error(`fixture target is not a directory: ${dir}`);
  }
  if (!(await isEmptyDirectory(dir)) && !(await pathExists(path.join(dir, FIXTURE_MARKER)))) {
    throw new Error(
      `refusing to overwrite ${dir}: it is not empty and has no ${FIXTURE_MARKER} marker`,
    );
  }

  await rm(dir, { recursive: true, force: true });
}

/**
 * Writes the fixture catalog into `dir`, replacing any previous build. Idempotent: the same
 * `dir` always ends up with byte-identical contents and nothing extra.
 *
 * @returns the catalog root, absolute.
 */
export async function buildFixtureCatalog(dir: string): Promise<string> {
  const root = path.resolve(dir);
  await clearTarget(root);

  const files = Object.entries(FIXTURE_CATALOG_FILES).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [relative, contents] of files) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    if (FIXTURE_EXECUTABLE_FILES.includes(relative)) {
      await chmod(target, 0o755);
    }
  }

  return root;
}

/** The branch the fixture repository's `HEAD` points at, so an absent `ref` finds something. */
export const FIXTURE_GIT_BRANCH = "main";

/** A tag on the same commit, so a test can ask for a ref that is not a branch. */
export const FIXTURE_GIT_TAG = "v1";

/** The bare repository, within the directory the builder is given. */
const BARE_DIRNAME = "catalog.git";

/** The working tree the bare repository is cloned from. */
const WORK_DIRNAME = "catalog-work";

/**
 * Fixed identity and dates, and neither user nor system config, so the fixture's commit SHA is the
 * same in every run on every machine — which is what lets a test name the cache path it produces.
 */
const FIXTURE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "ambit fixtures",
  GIT_AUTHOR_EMAIL: "fixtures@ambit.invalid",
  GIT_AUTHOR_DATE: "2024-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "ambit fixtures",
  GIT_COMMITTER_EMAIL: "fixtures@ambit.invalid",
  GIT_COMMITTER_DATE: "2024-01-01T00:00:00+00:00",
};

/** The fixture catalog as a git repository ambit can fetch without a network. */
export interface FixtureGitCatalog {
  /** Absolute path to the bare repository. */
  readonly repo: string;
  /** A `file://` URL for it — a git URL like any other, so no test mode is needed. */
  readonly url: string;
  /** The commit both the branch and the tag point at. */
  readonly commit: string;
  readonly branch: string;
  readonly tag: string;
  /** The working tree the bare repository was cloned from, so a test can commit a second revision. */
  readonly work: string;
}

const execFileAsync = promisify(execFile);

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: { ...process.env, ...FIXTURE_GIT_ENV },
    encoding: "utf8",
  });
  return stdout.trim();
}

/**
 * Builds the fixture catalog as a bare git repository inside `dir`, replacing any previous build.
 *
 * The tree committed is exactly {@link buildFixtureCatalog}'s, so a git-source install and a
 * `path:`-source install of the same fixture must produce identical results — which is the claim the
 * git-source tests make.
 */
export async function buildFixtureGitCatalog(dir: string): Promise<FixtureGitCatalog> {
  const root = path.resolve(dir);
  const work = path.join(root, WORK_DIRNAME);
  const repo = path.join(root, BARE_DIRNAME);

  await rm(work, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
  await buildFixtureCatalog(work);

  await git(["init", "--quiet"], work);
  // `symbolic-ref` rather than `init -b`: it names the initial branch the same way to every git.
  await git(["symbolic-ref", "HEAD", `refs/heads/${FIXTURE_GIT_BRANCH}`], work);
  await git(["add", "--all"], work);
  await git(["commit", "--quiet", "--message", "the fixture catalog"], work);
  await git(["tag", FIXTURE_GIT_TAG], work);
  const commit = await git(["rev-parse", "HEAD"], work);

  await git(["clone", "--mirror", "--quiet", "--", work, repo], root);

  return {
    repo,
    url: `file://${repo}`,
    commit,
    branch: FIXTURE_GIT_BRANCH,
    tag: FIXTURE_GIT_TAG,
    work,
  };
}

/**
 * Commits an edit to the fixture repository and pushes it, moving the branch.
 *
 * What `ambit outdated` and `ambit update` need and no other suite does: a repository whose `ref`
 * points somewhere new since a project last resolved it. The working tree the builder committed from
 * is reused rather than re-cloned, so the second commit's parent is the first and the branch fast-
 * forwards exactly as a real one would.
 *
 * The tag is deliberately left where it was, so one repository can serve both a moving ref and a
 * standing one.
 *
 * @param files the edit, keyed by repo-relative `/`-separated path; `null` deletes a file.
 * @returns the commit the branch now points at.
 */
export async function commitFixtureGitRevision(
  fixture: FixtureGitCatalog,
  files: Readonly<Record<string, string | null>>,
  message = "a second revision",
): Promise<string> {
  for (const [relative, text] of Object.entries(files)) {
    const target = path.join(fixture.work, relative);
    if (text === null) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }

  await git(["add", "--all"], fixture.work);
  await git(["commit", "--quiet", "--message", message], fixture.work);
  const commit = await git(["rev-parse", "HEAD"], fixture.work);
  await git(["push", "--quiet", fixture.repo, FIXTURE_GIT_BRANCH], fixture.work);
  return commit;
}

const DEFAULT_DIR = "test/tmp/fixture-catalog";

async function main(argv: readonly string[]): Promise<void> {
  const dir = argv[0] ?? DEFAULT_DIR;
  const root = await buildFixtureCatalog(dir);
  console.log(`fixture catalog written to ${root}`);
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
