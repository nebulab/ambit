import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

/**
 * `src/` is layered. A module may import from the layers below it and from the ambient root
 * (`errors.ts`, `version.ts`), never from one above.
 *
 * Spelled out as an explicit table of what each layer may NOT reach for, rather than derived from
 * a linear order, because the layers are not a chain. `harness/` and `authoring/` are siblings that
 * never touch; `project/` sits above `harness/` and drives it, but is blind to `authoring/`. That
 * last pair is the load-bearing one: curating a catalog and installing into a project are the two
 * halves of the tool, and they meet only at `model/` and `resolution/`.
 *
 * Without this the directories are a filing decision that decays back into a flat graph the first
 * time someone is in a hurry.
 */
const FORBIDDEN = {
  model: ["resolution", "harness", "authoring", "project", "export", "cli"],
  resolution: ["harness", "authoring", "project", "export", "cli"],
  harness: ["authoring", "project", "export", "cli"],
  authoring: ["harness", "project", "export", "cli"],
  project: ["authoring", "export", "cli"],
  export: ["authoring", "project", "cli"],
  // cli/ is the composition root and may reach for anything.
};

const boundary = ([layer, forbidden]) => ({
  files: [`src/${layer}/**/*.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: forbidden.map((target) => ({
          group: [`**/${target}/**`],
          message: `src/${layer}/ may not import from src/${target}/ — that inverts the layering (see README "Source layout").`,
        })),
      },
    ],
  },
});

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "**/dist/**",
      "apps/desktop/out/**",
      "apps/desktop/release/**",
      "coverage/**",
      "test/**/tmp/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "@stylistic": stylistic },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: ["const", "let", "var"], next: "*" },
        { blankLine: "any", prev: ["const", "let", "var"], next: ["const", "let", "var"] },
        { blankLine: "always", prev: "block-like", next: "*" },
        { blankLine: "always", prev: "*", next: "return" },
      ],
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-console": "off",
    },
  },
  ...Object.entries(FORBIDDEN).map(boundary),
);
