/**
 * ambit's build: two entry points, three kinds of artifact.
 *
 * - `dist/cli.js` and `dist/index.js`, bundled for **Node**. The npm package is still how `npx
 *   @nebulab/ambit` works and how the library export is consumed, and `npx` runs Node. That is the
 *   constraint keeping `src/` on `node:` APIs with no Bun global in it: everything here would still
 *   build, and then fail at runtime on the one platform ambit does not ship a binary for.
 * - `dist/types/`, from `tsc`. Bun does not emit declarations.
 * - `release/ambit-<os>-<arch>`, standalone executables — Bun's runtime with the bundle inside it,
 *   so a user needs neither Node nor Bun. Cross-compiled, so one machine builds all of them and the
 *   release job needs no matrix. Beside `dist/` rather than inside it, because `dist/` is what the
 *   npm package ships and hundreds of megabytes of executables are not part of a tarball.
 *
 * The executables are built only when asked for (`--binaries`), because each is ~60 MB and the first
 * build for a target downloads that target's Bun runtime. That is a release cost, not a cost to pay
 * on every `bun run build`.
 */
import { rm } from "node:fs/promises";

import { $ } from "bun";

/** Where the executables land, and what a release attaches. */
const BINARY_DIR = "release";

/**
 * The platforms a release ships a binary for, and the name each one gets.
 *
 * The names are `<os>-<arch>` as `install.sh` spells them from `uname`, so the two files have to
 * agree. The Windows one carries `.exe` because Bun appends it to a `bun-windows-*` output whether
 * or not the name asks for it, and a checksum line has to match the filename that ships.
 */
const BINARIES: readonly { readonly target: string; readonly name: string }[] = [
  { target: "bun-darwin-arm64", name: "ambit-darwin-arm64" },
  { target: "bun-darwin-x64", name: "ambit-darwin-x64" },
  { target: "bun-linux-x64", name: "ambit-linux-x64" },
  { target: "bun-linux-arm64", name: "ambit-linux-arm64" },
  { target: "bun-windows-x64", name: "ambit-windows-x64.exe" },
];

/**
 * Bundles both entry points for Node, and emits the declarations for the library one.
 *
 * `--packages=external` leaves the four runtime dependencies to npm, which is what `dependencies` in
 * `package.json` already promises a consumer. Bundling them here would resolve each one the way Node
 * does — by `main`, so jsonc-parser's UMD build rather than its ESM one — and a UMD wrapper's inner
 * `require` survives the bundle unresolved. The executables below have no npm to fall back on, so
 * they bundle everything, and Bun's own resolution takes the ESM builds.
 */
async function buildPackage(): Promise<void> {
  await $`bun build src/index.ts --target=node --packages=external --outdir dist --sourcemap=linked`;
  // Only the bin gets a shebang, and a banner applies to every output of one invocation.
  await $`bun build src/cli.ts --target=node --packages=external --outdir dist --sourcemap=linked --banner ${"#!/usr/bin/env node"}`;
  await $`bunx tsc -p tsconfig.build.json`;
}

async function buildBinaries(): Promise<void> {
  await rm(BINARY_DIR, { recursive: true, force: true });
  for (const { target, name } of BINARIES) {
    await $`bun build src/cli.ts --compile --target=${target} --outfile ${`${BINARY_DIR}/${name}`}`;
  }
}

const binaries = process.argv.includes("--binaries");

await rm("dist", { recursive: true, force: true });
await buildPackage();
if (binaries) await buildBinaries();
