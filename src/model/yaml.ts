/**
 * The shared YAML loader.
 *
 * Every ambit format goes through here — `ambit.yml`, `mcps/*.yml`, `hook.yml`, `SKILL.md`
 * frontmatter — so the rules are enforced once and cannot drift between parsers. The rules
 * exist because the alternative is silent corruption: a commit SHA like `1234567` parses as
 * an integer, a duplicate key quietly wins, a tab looks like indentation.
 *
 * Reading returns a {@link YamlMapping}, a positioned view over the document rather than a
 * plain object. Keeping the nodes around is what lets every downstream error name the line it
 * came from, which every message requires.
 *
 * Writing goes through {@link emitYaml}, in this module rather than beside whatever generates a
 * document, so the emit half of §3.0 is enforced once too — and so what ambit writes is
 * guaranteed readable by what ambit reads.
 *
 * There used to be a third half: `EditableYaml`, which kept the parsed node tree and re-emitted it so
 * that rewriting one key of a hand-maintained file left comments, unknown keys, key order and
 * formatting byte-for-byte intact. It is gone, because nothing rewrites such a file any more — its only
 * caller was the catalog editor, and authoring a catalog is hand-editing now. It was 170 lines and its
 * own emit options, kept alive by nothing but the possibility of a future caller; the git history holds
 * it, which is the better place for code with no user. A command that needs to edit a document ambit
 * did not write brings it back, and brings back a test for it at the same time.
 *
 * Nothing outside this module touches the `yaml` package, so read and emit cannot drift apart.
 */
import { readFile } from "node:fs/promises";

import matter from "gray-matter";
import type {
  CreateNodeOptions,
  Document,
  DocumentOptions,
  Pair,
  ParseOptions,
  SchemaOptions,
  ToStringOptions,
  YAMLMap,
} from "yaml";
import { LineCounter, isMap, isScalar, isSeq, parseDocument, stringify, visit } from "yaml";

import type { AmbitError } from "../errors.js";
import { at, configError } from "../errors.js";

/**
 * The tags the YAML 1.2 core schema resolves. A node carrying anything else is using a custom
 * tag, and the document is rejected — arbitrary type resolution is how `!!python/object`
 * constructs get in.
 */
const CORE_TAGS: ReadonlySet<string> = new Set([
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:seq",
  "tag:yaml.org,2002:str",
]);

function rangeOf(node: unknown): [number, number] | undefined {
  if (typeof node !== "object" || node === null || !("range" in node)) return undefined;
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || typeof range[0] !== "number" || typeof range[1] !== "number") {
    return undefined;
  }
  return [range[0], range[1]];
}

/**
 * The fix to suggest for an unquoted value: `ref: "1e5"` for a key, `- "1e5"` for a sequence
 * item, so the suggestion is something the reader can paste back.
 */
function quoteHint(label: string, written: string): string {
  if (label.endsWith("]")) return `- "${written}"`;
  return `${label.slice(label.lastIndexOf(".") + 1)}: "${written}"`;
}

/** How a value is described in a type-mismatch message. */
function describe(value: unknown): string {
  if (isMap(value)) return "a mapping";
  if (isSeq(value)) return "a sequence";
  if (value === null) return "nothing";
  if (isScalar(value)) {
    const inner = value.value;
    if (inner === null) return "null";
    if (typeof inner === "boolean") return "a boolean";
    if (typeof inner === "number") return Number.isInteger(inner) ? "an integer" : "a number";
    if (typeof inner === "string") return "a string";
  }
  return "an unsupported value";
}

/** The document, its text, and a line index — everything needed to position an error. */
class YamlSource {
  constructor(
    readonly file: string,
    private readonly text: string,
    private readonly counter: LineCounter,
    /**
     * Lines of the containing file that sit above the parsed text — the `---` delimiter of a
     * frontmatter block, and any blank lines under it. A reader told "line 4" must be able to go to
     * line 4 of the file named, and what was parsed is only part of that file.
     */
    private readonly lineOffset = 0,
  ) {}

  /** The 1-based line `node` starts on, counted in the containing file. */
  lineOf(node: unknown): number | undefined {
    const range = rangeOf(node);
    return range === undefined ? undefined : this.counter.linePos(range[0]).line + this.lineOffset;
  }

  /**
   * The source text `node` was parsed from. Messages quote this rather than the parsed value,
   * so the fix for `ref: 1e5` reads `ref: "1e5"` and not `ref: "100000"`.
   */
  textOf(node: unknown): string | undefined {
    const range = rangeOf(node);
    if (range === undefined) return undefined;
    const slice = this.text.slice(range[0], range[1]).trim();
    return slice === "" ? undefined : slice;
  }
}

/** One string from a sequence, with where it was written. */
export interface PositionedString {
  readonly value: string;
  /** 1-based, absent when the document positioned neither the item nor its key. */
  readonly line?: number;
}

/**
 * A YAML mapping, with the accessors every ambit parser needs. Each one either returns a value
 * of the requested type or throws an {@link AmbitError} naming the key, the file, and the line.
 *
 * A key that is present must carry a value: an explicit `null` is an error, because the way to
 * take a default is to omit the key.
 */
export class YamlMapping {
  private readonly node: YAMLMap<unknown, unknown>;
  private readonly source: YamlSource;
  /** Dotted path from the document root, so nested errors read `catalogs[0].ref`. */
  private readonly prefix: string;

  constructor(node: YAMLMap<unknown, unknown>, source: YamlSource, prefix: string) {
    this.node = node;
    this.source = source;
    this.prefix = prefix;
  }

  /** The file this mapping came from, as named in error messages. */
  get file(): string {
    return this.source.file;
  }

  /** The 1-based line this mapping starts on. */
  get line(): number | undefined {
    return this.source.lineOf(this.node);
  }

  /** Keys in document order. Duplicates cannot occur: the loader rejects them. */
  keys(): readonly string[] {
    return this.node.items.flatMap((item) =>
      isScalar(item.key) && typeof item.key.value === "string" ? [item.key.value] : [],
    );
  }

  has(key: string): boolean {
    return this.pairFor(key) !== undefined;
  }

  /** The line `key` appears on, falling back to the mapping's own line. */
  lineOf(key: string): number | undefined {
    const pair = this.pairFor(key);
    return (pair === undefined ? undefined : this.source.lineOf(pair.key)) ?? this.line;
  }

  /** Builds an error positioned at `key`, for rules only the caller knows. */
  keyError(key: string, message: string, detail: readonly string[] = []): AmbitError {
    return configError(`${message} ${at(this.file, this.lineOf(key))}`, detail);
  }

  /**
   * Rejects any key outside `known`. Unknown keys are errors rather than warnings: a typo in
   * an ignored key is indistinguishable from a feature that silently does nothing.
   */
  rejectUnknownKeys(known: readonly string[]): void {
    const accepted = new Set(known);
    for (const key of this.keys()) {
      if (accepted.has(key)) continue;
      throw this.keyError(key, `unknown key "${this.label(key)}"`, [
        `accepted keys: ${[...accepted].sort().join(", ")}`,
        `remove \`${key}\`, or correct the spelling`,
      ]);
    }
  }

  requireString(key: string): string {
    return this.readString(this.require(key, "a string"), key, true);
  }

  optionalString(key: string): string | undefined {
    const pair = this.pairFor(key);
    return pair === undefined ? undefined : this.readString(pair, key, false);
  }

  requireInteger(key: string): number {
    const pair = this.require(key, "an integer");
    const value = this.value(pair, key, "an integer", true);
    if (isScalar(value) && typeof value.value === "number" && Number.isInteger(value.value)) {
      return value.value;
    }
    throw this.mismatch(key, "an integer", value);
  }

  optionalInteger(key: string): number | undefined {
    return this.has(key) ? this.requireInteger(key) : undefined;
  }

  /** A sequence of strings. An empty sequence is allowed and means exactly that. */
  optionalStringList(key: string): readonly string[] | undefined {
    return this.optionalPositionedStringList(key)?.map((entry) => entry.value);
  }

  /**
   * The same sequence, each item paired with the line it was written on.
   *
   * A rule enforced after parsing — a `requires` pattern no catalog's items match, say — has no YAML
   * node left to point at, and its error is still expected to name a line. Carrying the positions
   * forward is cheaper and less fragile than reparsing the document to find them again.
   */
  optionalPositionedStringList(key: string): readonly PositionedString[] | undefined {
    const items = this.sequence(key, "a sequence of strings");
    if (items === undefined) return undefined;
    return items.map((item, index) => {
      const value = this.readItemString(item, key, index);
      const line = this.source.lineOf(item) ?? this.lineOf(key);
      return { value, ...(line !== undefined && { line }) };
    });
  }

  requireMapping(key: string): YamlMapping {
    const pair = this.require(key, "a mapping");
    const value = this.value(pair, key, "a mapping", true);
    if (!isMap(value)) throw this.mismatch(key, "a mapping", value);
    return new YamlMapping(value, this.source, this.label(key));
  }

  optionalMapping(key: string): YamlMapping | undefined {
    return this.has(key) ? this.requireMapping(key) : undefined;
  }

  optionalMappingList(key: string): readonly YamlMapping[] | undefined {
    const items = this.sequence(key, "a sequence of mappings");
    if (items === undefined) return undefined;
    return items.map((item, index) => {
      if (!isMap(item)) throw this.itemMismatch(key, index, "a mapping", item);
      return new YamlMapping(item, this.source, `${this.label(key)}[${index}]`);
    });
  }

  /**
   * A sequence whose items are each a string or a mapping — the shape `requires` reads, where only
   * the mapping form is legal.
   *
   * The string form is handed back rather than rejected here so its caller can refuse it with the
   * rewrite it needs: a bare pattern says neither which field it matches nor which capabilities it
   * selects, and *must be a mapping* would read as a shape complaint rather than as the two missing
   * declarations it is.
   *
   * That form carries its line for the same reason
   * {@link YamlMapping.optionalPositionedStringList} does: an entry is judged long after this parse,
   * and its error is still expected to name the line it was written on.
   */
  optionalEntryList(key: string): readonly (PositionedString | YamlMapping)[] | undefined {
    const items = this.sequence(key, "a sequence of strings or mappings");
    if (items === undefined) return undefined;
    return items.map((item, index) => {
      if (isMap(item)) return new YamlMapping(item, this.source, `${this.label(key)}[${index}]`);
      const value = this.readItemString(item, key, index, "a string or a mapping");
      const line = this.source.lineOf(item) ?? this.lineOf(key);
      return { value, ...(line !== undefined && { line }) };
    });
  }

  /**
   * Every entry of this mapping as string→string, for free-form maps whose keys are not known
   * ahead of time (`transport.http.headers`).
   */
  stringEntries(): Readonly<Record<string, string>> {
    const entries: Record<string, string> = {};
    for (const key of this.keys()) entries[key] = this.requireString(key);
    return entries;
  }

  private label(key: string): string {
    return this.prefix ? `${this.prefix}.${key}` : key;
  }

  private pairFor(key: string): Pair<unknown, unknown> | undefined {
    return this.node.items.find((item) => isScalar(item.key) && item.key.value === key);
  }

  private require(key: string, expected: string): Pair<unknown, unknown> {
    const pair = this.pairFor(key);
    if (pair !== undefined) return pair;
    throw configError(`missing required key "${this.label(key)}" ${at(this.file, this.line)}`, [
      `expected ${expected}`,
      `add \`${key}:\` with a value`,
    ]);
  }

  /**
   * The value node behind `key`, rejecting an explicit null: the way to take a default is to
   * omit the key, so a written-out `null` is always a mistake.
   */
  private value(
    pair: Pair<unknown, unknown>,
    key: string,
    expected: string,
    required: boolean,
  ): unknown {
    const value = pair.value;
    if (value === null || (isScalar(value) && value.value === null)) {
      throw this.keyError(key, `"${this.label(key)}" must not be null`, [
        `expected ${expected}`,
        required ? "give it a value" : "give it a value, or remove the key to take its default",
      ]);
    }
    return value;
  }

  private readString(pair: Pair<unknown, unknown>, key: string, required: boolean): string {
    const value = this.value(pair, key, "a string", required);
    return this.coerceString(value, this.label(key), this.lineOf(key), "a string");
  }

  private readItemString(item: unknown, key: string, index: number, expected = "a string"): string {
    const label = `${this.label(key)}[${index}]`;
    if (item === null || (isScalar(item) && item.value === null)) {
      throw configError(`"${label}" must not be null ${at(this.file, this.source.lineOf(item))}`, [
        `expected ${expected}`,
        "give it a value, or remove the entry",
      ]);
    }
    return this.coerceString(item, label, this.source.lineOf(item) ?? this.lineOf(key), expected);
  }

  /**
   * Enforces §3.0's central rule: anything that identifies something must arrive as a string.
   * A number or boolean is reported rather than stringified, because silently accepting
   * `ref: 1e5` as `"100000"` is how a config comes to point at the wrong commit.
   */
  private coerceString(
    value: unknown,
    label: string,
    line: number | undefined,
    expected: string,
  ): string {
    if (isScalar(value) && typeof value.value === "string") {
      if (value.value.trim() === "") {
        throw configError(`"${label}" must not be empty ${at(this.file, line)}`, [
          `expected ${expected}`,
          "give it a value, or remove the key",
        ]);
      }
      return value.value;
    }

    if (isScalar(value) && (typeof value.value === "number" || typeof value.value === "boolean")) {
      const written = this.source.textOf(value) ?? String(value.value);
      const kind = typeof value.value === "boolean" ? "a boolean" : "a number";
      throw configError(`"${label}" must be a string ${at(this.file, line)}`, [
        `YAML parsed \`${written}\` as ${kind}`,
        `quote it: \`${quoteHint(label, written)}\``,
      ]);
    }

    throw configError(`"${label}" must be ${expected} ${at(this.file, line)}`, [
      `found ${describe(value)}`,
      `give \`${label}\` ${expected}`,
    ]);
  }

  /** The items of an optional sequence-valued key, or `undefined` when the key is absent. */
  private sequence(key: string, expected: string): readonly unknown[] | undefined {
    const pair = this.pairFor(key);
    if (pair === undefined) return undefined;
    const value = this.value(pair, key, expected, false);
    if (!isSeq(value)) throw this.mismatch(key, expected, value);
    return value.items;
  }

  private mismatch(key: string, expected: string, value: unknown): AmbitError {
    return this.keyError(key, `"${this.label(key)}" must be ${expected}`, [
      `found ${describe(value)}`,
      `give \`${key}\` ${expected}`,
    ]);
  }

  private itemMismatch(key: string, index: number, expected: string, value: unknown): AmbitError {
    const label = `${this.label(key)}[${index}]`;
    const line = this.source.lineOf(value) ?? this.lineOf(key);
    return configError(`"${label}" must be ${expected} ${at(this.file, line)}`, [
      `found ${describe(value)}`,
      `give every \`${key}\` entry ${expected}`,
    ]);
  }
}

/** Rewrites a parser error into ambit's message shape, keeping the position. */
function syntaxError(
  source: YamlSource,
  error: { code?: string; message: string; pos: [number, number] },
): AmbitError {
  const line = source.lineOf({ range: error.pos });
  const where = at(source.file, line);

  if (error.code === "TAB_AS_INDENT") {
    return configError(`YAML does not permit tabs for indentation ${where}`, [
      "a tab is indistinguishable from indentation but is not indentation",
      "replace the tab with spaces",
    ]);
  }

  // yaml appends " at line N, column M:" and a source snippet; both are redundant here.
  const summary = error.message.split("\n")[0]?.replace(/ at line \d+, column \d+:?$/, "") ?? "";
  return configError(`invalid YAML ${where}`, [summary, "fix the syntax error"]);
}

/**
 * The first structural violation, in document order: a custom tag, a non-string key, or a
 * duplicate key. These are all things the parser tolerates and ambit must not.
 */
function structuralProblem(source: YamlSource, root: unknown): AmbitError | undefined {
  const problems: AmbitError[] = [];

  const checkTag = (node: { tag?: string | null }): void => {
    const tag = node.tag;
    if (tag === undefined || tag === null || CORE_TAGS.has(tag)) return;
    const shorthand = tag.startsWith("tag:yaml.org,2002:")
      ? `!!${tag.slice("tag:yaml.org,2002:".length)}`
      : tag;
    problems.push(
      configError(
        `custom YAML tag \`${shorthand}\` is not permitted ${at(source.file, source.lineOf(node))}`,
        ["ambit parses YAML 1.2 with the core schema only", `remove \`${shorthand}\``],
      ),
    );
  };

  const checkKeys = (node: YAMLMap<unknown, unknown>): void => {
    const seen = new Map<string, number | undefined>();
    for (const item of node.items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string") {
        problems.push(
          configError(`mapping keys must be strings ${at(source.file, source.lineOf(item.key))}`, [
            `found ${describe(item.key)} as a key`,
            "quote the key",
          ]),
        );
        continue;
      }

      const key = item.key.value;
      const line = source.lineOf(item.key);
      const first = seen.get(key);
      if (seen.has(key)) {
        problems.push(
          configError(`duplicate key "${key}" ${at(source.file, line)}`, [
            first === undefined ? "already defined earlier" : `first defined on line ${first}`,
            "remove one of the two definitions",
          ]),
        );
        continue;
      }
      seen.set(key, line);
    }
  };

  visit(root as Parameters<typeof visit>[0], {
    Map: (_key, node) => {
      checkTag(node);
      checkKeys(node);
    },
    Seq: (_key, node) => checkTag(node),
    Scalar: (_key, node) => checkTag(node),
  });

  return problems[0];
}

/** How every ambit document is parsed. Shared, so no caller can loosen a rule. */
const PARSE_OPTIONS: DocumentOptions & ParseOptions & SchemaOptions = {
  schema: "core",
  version: "1.2",
  // Duplicates are found by `structuralProblem` instead, so the error can name both lines — yaml's
  // own DUPLICATE_KEY error reports only the second.
  uniqueKeys: false,
};

/** A document that has passed every §3.0 rule, with its mapping root and its line index. */
interface CheckedDocument {
  readonly document: Document.Parsed;
  readonly root: YAMLMap<unknown, unknown>;
  readonly source: YamlSource;
}

/**
 * Parses `text` and enforces every §3.0 rule on it, keeping the document rather than reducing it to
 * a value — which is what lets one caller read positions off it and another re-emit it unchanged.
 *
 * @param lineOffset lines of the containing file above `text`, for a frontmatter block.
 * @throws {AmbitError} exit 2, naming the offending file, identifier, and line.
 */
function parseChecked(text: string, file: string, lineOffset = 0): CheckedDocument {
  const counter = new LineCounter();
  const document = parseDocument(text, { ...PARSE_OPTIONS, lineCounter: counter });
  const source = new YamlSource(file, text, counter, lineOffset);

  const failure = document.errors[0];
  if (failure) throw syntaxError(source, failure);

  const problem = structuralProblem(source, document);
  if (problem) throw problem;

  if (document.contents === null) {
    throw configError(`${file} is empty`, [
      "expected a YAML mapping",
      "add the keys this format requires",
    ]);
  }
  if (!isMap(document.contents)) {
    throw configError(`root is not a mapping ${at(file, source.lineOf(document.contents))}`, [
      `found ${describe(document.contents)} at the document root`,
      "write the document as `key: value` pairs",
    ]);
  }

  return { document, root: document.contents, source };
}

/**
 * Parses `text` as a YAML mapping under every §3.0 rule.
 *
 * @param file how the document is named in error messages — a project-relative path, not the
 *   absolute one, since that is what the reader recognizes.
 * @throws {AmbitError} exit 2, naming the offending file, identifier, and line.
 */
export function parseYamlMapping(text: string, file: string): YamlMapping {
  const checked = parseChecked(text, file);
  return new YamlMapping(checked.root, checked.source, "");
}

/**
 * Neutralizes gray-matter's own parsing. It is used only to find where the frontmatter block
 * starts and ends; the block's contents go through {@link parseYamlMapping}, so that js-yaml
 * never sees ambit's YAML and cannot accept what §3.0 rejects.
 */
const NO_PARSE = { parse: (): object => ({}) };

const FRONTMATTER_LANGUAGE = "yaml";

/**
 * gray-matter sets `isEmpty` for a block that holds nothing but comments, which its own types
 * omit. Worth keeping: it is the difference between "empty frontmatter" and a parse error.
 */
type ParsedFrontmatter = matter.GrayMatterFile<string> & { readonly isEmpty?: boolean };

/**
 * A Markdown document cut into its frontmatter block and the bytes around it.
 *
 * The three pieces concatenate back to the document exactly, which is what lets an edit rewrite the
 * block and leave the body byte-for-byte alone. `block` carries no
 * surrounding blank lines, because the parser does not preserve those on re-emit and they therefore
 * have to survive as bytes rather than as parsed structure.
 */
export interface FrontmatterSplit {
  /** The opening delimiter, its language tag if any, and every blank line under it. */
  readonly open: string;
  /** The YAML block itself. */
  readonly block: string;
  /** The block's trailing blank lines, the closing delimiter, and the whole Markdown body. */
  readonly close: string;
}

/** How many lines `text` occupies above whatever follows it. */
function lineCount(text: string): number {
  return text.split("\n").length - 1;
}

/**
 * Finds the frontmatter block of a Markdown document — `SKILL.md`'s, in practice.
 *
 * gray-matter locates the block and nothing else does, so reading and editing cannot disagree about
 * where it ends. Its own parsing is neutralized ({@link NO_PARSE}); what it reports is the raw block,
 * which then goes through ambit's §3.0 rules.
 *
 * @param text the whole document, frontmatter included.
 * @param file how it is named in error messages.
 * @throws {AmbitError} exit 2 if there is no frontmatter block, or it is empty, or it is not YAML.
 */
export function splitFrontmatter(text: string, file: string): FrontmatterSplit {
  const missing = configError(`${file} has no frontmatter block`, [
    "expected the document to open with a `---` delimited YAML block",
    "add one, starting on the first line",
  ]);

  let document: ParsedFrontmatter;
  try {
    document = matter(text, {
      language: FRONTMATTER_LANGUAGE,
      engines: { javascript: NO_PARSE, json: NO_PARSE, yaml: NO_PARSE },
    });
  } catch (error) {
    // Reached only by an unrecognized language tag, which gray-matter rejects on its own terms.
    throw configError(`cannot read the frontmatter of ${file}`, [
      error instanceof Error ? error.message : String(error),
      "write it as a plain `---` delimited YAML block",
    ]);
  }

  // `isEmpty` distinguishes a block holding nothing from a document with no block at all — for
  // `---` immediately followed by `---`, gray-matter reports both, and the former is the useful
  // thing to say.
  if (document.isEmpty === true) {
    throw configError(`${file} has an empty frontmatter block`, [
      "expected a YAML mapping between the `---` delimiters",
      "add the keys this format requires",
    ]);
  }
  if (document.matter === "") throw missing;
  if (document.language !== FRONTMATTER_LANGUAGE) {
    throw configError(`${file} declares its frontmatter as "${document.language}"`, [
      "ambit reads frontmatter as YAML",
      `remove the language tag after the opening \`---\`, or write \`---${FRONTMATTER_LANGUAGE}\``,
    ]);
  }

  // The raw block sits between the opening delimiter and the newline that begins the closing one, so
  // the two ends of the document are simply what remains around it. Located by search rather than by
  // arithmetic over the delimiter's length, which also keeps a leading byte-order mark — stripped by
  // gray-matter, still present in `text` — on the `open` side where it belongs.
  const raw = document.matter;
  const blockStart = text.indexOf(raw);
  const leading = /^\n*/.exec(raw)?.[0] ?? "";
  const trailing = /\n*$/.exec(raw.slice(leading.length))?.[0] ?? "";

  return {
    open: text.slice(0, blockStart) + leading,
    block: raw.slice(leading.length, raw.length - trailing.length),
    close: trailing + text.slice(blockStart + raw.length),
  };
}

/**
 * Parses the frontmatter block of a Markdown document — `SKILL.md`'s, in practice — under the
 * same §3.0 rules as a standalone YAML file.
 *
 * Reported lines are lines of the whole document rather than of the extracted block, because a
 * reader told "line 4" must be able to go to line 4 of the file named.
 *
 * @param text the whole document, frontmatter included.
 * @param file how it is named in error messages.
 * @throws {AmbitError} exit 2 if there is no frontmatter, or it violates a §3.0 rule.
 */
export function parseFrontmatterMapping(text: string, file: string): YamlMapping {
  const split = splitFrontmatter(text, file);
  const checked = parseChecked(split.block, file, lineCount(split.open));
  return new YamlMapping(checked.root, checked.source, "");
}

async function readText(target: string, file: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    throw configError(`cannot read ${file}`, [
      error instanceof Error ? error.message : String(error),
      "check the path and its permissions",
    ]);
  }
}

/**
 * Reads and parses a YAML file.
 *
 * @param path the file to read.
 * @param file how it is named in error messages. Defaults to `path`.
 */
export async function readYamlMapping(path: string, file = path): Promise<YamlMapping> {
  return parseYamlMapping(await readText(path, file), file);
}

/**
 * Reads a Markdown file and parses its frontmatter block.
 *
 * @param path the file to read.
 * @param file how it is named in error messages. Defaults to `path`.
 */
export async function readFrontmatterMapping(path: string, file = path): Promise<YamlMapping> {
  return parseFrontmatterMapping(await readText(path, file), file);
}

/**
 * How ambit writes YAML. Every option here answers a rule, so none of them is a
 * preference:
 *
 * - `sortMapEntries` makes the byte order a function of the keys rather than of whichever order a
 *   generator happened to build its object in — the property that lets a lock be diffed at all.
 * - `singleQuote: false` makes quoting consistent, so a value that needs quotes always gets the
 *   same ones and a diff never shows a changed quote style as a change.
 * - `blockQuote: false` and `lineWidth: 0` between them forbid every form of rewrapping: a long
 *   value stays on its line, and an awkward one is escaped inside double quotes rather than
 *   turned into a block scalar whose indentation carries meaning.
 * - `aliasDuplicateObjects: false` forbids anchors and aliases, so two entries that happen to
 *   hold equal values stay two entries instead of one and a back-reference.
 * - `schema`/`version` match {@link parseYamlMapping}'s, which is what makes the two halves
 *   agree about when a string needs quoting: an emitter on a laxer schema would leave `1e5`
 *   bare for a parser that reads it as a float.
 */
const EMIT_OPTIONS: DocumentOptions & SchemaOptions & CreateNodeOptions & ToStringOptions = {
  schema: "core",
  version: "1.2",
  sortMapEntries: true,
  singleQuote: false,
  blockQuote: false,
  lineWidth: 0,
  aliasDuplicateObjects: false,
};

/**
 * Renders a document as the bytes ambit writes: keys sorted at every depth, strings that would
 * otherwise coerce double-quoted, no anchors, no aliases, no rewrapping, and a trailing newline.
 *
 * Byte-stable by construction: the output is a function of the values alone, so the same inputs
 * produce the same file and a lock that has not changed shows as no diff.
 *
 * @param document the value to emit, conventionally a plain object.
 */
export function emitYaml(document: unknown): string {
  return stringify(document, EMIT_OPTIONS);
}
