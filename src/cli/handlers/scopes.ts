/**
 * `ambit scopes` — the merged scope registry, with descriptions.
 *
 * This is picker data: a consuming tool renders the list, a person picks from it, and the answers are
 * written back as `ambit.yml`'s `scopes`. So the description is the payload, not decoration — a scope
 * whose meaning a human cannot read is one nobody can hold on purpose.
 *
 * Each scope also carries whether this project *holds* it, which is what makes the command more than
 * a slice of `ambit catalog`: the picker needs its checkboxes pre-set, and the answer is a fact about
 * `ambit.yml` rather than about the catalog. `held` is literal membership in the config's list, not
 * selection — a project holding `function.engineering` reaches
 * `function.engineering.frontend`, but it does not hold it, and pre-checking the child
 * would tell the person they had chosen something they had not.
 *
 * Nothing here validates the held scopes. A scope listed in `ambit.yml` and registered nowhere is
 * exit 3 from `resolve` and a problem from `validate`, but it must not stop `scopes`: this is the
 * command someone reads *to fix that typo*, and a picker that refuses to render is a picker that
 * cannot correct anything. Such a scope simply appears in no row, since the registry is the subject.
 */
import { loadCatalogs, mergeCatalogs } from "../../model/catalog.js";
import type { CommandHandler } from "../commands.js";
import { jsonRequested, sourceContextOf } from "../commands.js";
import { loadProjectConfig } from "../../model/config.js";
import { ExitCode } from "../../errors.js";
import { keyed, printSections, section } from "../output.js";

/** The `held` column's two values, so the table lines up and neither reads as missing data. */
const HELD = "held";
const UNHELD = "-";

export const scopesHandler: CommandHandler = async (ctx) => {
  const context = sourceContextOf(ctx);
  const config = await loadProjectConfig(context.projectDir);
  const merged = mergeCatalogs(await loadCatalogs(config, context));
  const held = new Set(config.scopes);

  if (jsonRequested(ctx)) {
    const scopes = keyed(
      merged.scopes,
      (scope) => scope.name,
      (scope) => ({ description: scope.description, held: held.has(scope.name) }),
    );
    ctx.stdout(JSON.stringify({ scopes }, null, 2));
    return ExitCode.Success;
  }

  printSections(
    section(
      "scopes",
      merged.scopes.map((scope) => [
        scope.name,
        held.has(scope.name) ? HELD : UNHELD,
        scope.description,
      ]),
    ),
    ctx.stdout,
  );
  return ExitCode.Success;
};
