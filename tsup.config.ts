import type { Options } from "tsup";
import { defineConfig } from "tsup";

const shared: Options = {
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
};

export default defineConfig([
  {
    ...shared,
    entry: { index: "src/index.ts" },
    clean: true,
  },
  {
    ...shared,
    entry: { cli: "src/cli.ts" },
    // Only the bin gets a shebang.
    banner: { js: "#!/usr/bin/env node" },
  },
]);
