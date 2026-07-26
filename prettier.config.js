/**
 * Formatting is not a matter of taste here, it is a matter of not spending review attention on it.
 * Every default is taken as-is — double quotes, semicolons, 2-space indent, trailing commas, always
 * parenthesised arrow params — because they already describe what `src/` looks like, and a config
 * that restates the defaults is a config that has to be re-argued every time Prettier changes one.
 *
 * `printWidth` is the single deviation. The 80-column default would fold most of this codebase's
 * signatures and import lists onto three lines each; 100 is where the existing code already sits.
 * It does not touch the prose in the doc comments — Prettier leaves comment interiors alone — so the
 * ~100-column wrapping in those is a hand convention that this file happens to agree with rather
 * than something enforced.
 */

/** @type {import("prettier").Config} */
export default {
  printWidth: 100,
};
