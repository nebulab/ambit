/**
 * MCP entity parsing.
 *
 * One shape, one place it can be written: `mcps/<name>.yml` in a catalog. A project that defines a
 * server of its own lists itself as a catalog and puts it there, so this parser has one caller and no
 * variant to reconcile.
 */
import type { Expectation } from "./expectation.js";
import { parseExpectations } from "./expectation.js";
import type { YamlMapping } from "./yaml.js";

/** A locally-spawned server. */
export interface StdioTransport {
  readonly kind: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Variables the spawned process is given, each name mapped to what supplies it.
   *
   * A server reads the names its own author chose, which are not always the names a machine sets. An
   * entry joins the two, so two servers reading one variable name can be given different values.
   * `${VAR}` is treated as in {@link HttpTransport.headers}, and an `expects` entry a value
   * references is not also passed under its own name.
   */
  readonly env: Readonly<Record<string, string>>;
}

/** A server reached over HTTP. */
export interface HttpTransport {
  readonly kind: "http";
  readonly url: string;
  /**
   * `${VAR}` references are left intact here; at install each harness's profile rewrites them into
   * the reference syntax that harness expands at spawn time. The value itself is never read.
   */
  readonly headers: Readonly<Record<string, string>>;
}

export type McpTransport = StdioTransport | HttpTransport;

export interface McpEntity {
  readonly name: string;
  readonly transport: McpTransport;
  /** What must be true of the world for this server to work — its credentials, today. */
  readonly expects: readonly Expectation[];
}

/**
 * The transport kinds ambit understands. `transport` carries exactly one of these as a nested
 * key, so the kind's own fields stay under it and a new kind adds nothing at the top level.
 */
export const MCP_TRANSPORT_KINDS = ["http", "stdio"] as const;

const ENTITY_KEYS = ["expects", "name", "transport"] as const;

function parseTransport(mapping: YamlMapping): McpTransport {
  const transport = mapping.requireMapping("transport");
  const kinds = transport.keys();

  // `transport` is the discriminator, so it must never be ambiguous.
  if (kinds.length !== 1) {
    throw mapping.keyError(
      "transport",
      kinds.length === 0
        ? "`transport` names no transport kind"
        : `\`transport\` names ${kinds.length} transport kinds: ${[...kinds].sort().join(", ")}`,
      [
        `supported kinds: ${MCP_TRANSPORT_KINDS.join(", ")}`,
        "give `transport` exactly one kind key",
      ],
    );
  }

  const kind = kinds[0]!;
  switch (kind) {
    case "stdio": {
      const stdio = transport.requireMapping("stdio");
      stdio.rejectUnknownKeys(["args", "command", "env"]);
      return {
        kind: "stdio",
        command: stdio.requireString("command"),
        args: stdio.optionalStringList("args") ?? [],
        env: stdio.optionalMapping("env")?.stringEntries() ?? {},
      };
    }
    case "http": {
      const http = transport.requireMapping("http");
      http.rejectUnknownKeys(["headers", "url"]);
      return {
        kind: "http",
        url: http.requireString("url"),
        headers: http.optionalMapping("headers")?.stringEntries() ?? {},
      };
    }
    default:
      throw transport.keyError(kind, `unknown transport kind "${kind}"`, [
        `supported kinds: ${MCP_TRANSPORT_KINDS.join(", ")}`,
        `replace \`${kind}\` with one of them`,
      ]);
  }
}

/**
 * Parses one MCP entity.
 *
 * @param mapping the entity's mapping — a whole `mcps/*.yml` document, or one item of
 *   `ambit.yml`'s `mcps` list.
 * @throws {AmbitError} exit 2 for any shape violation.
 */
export function parseMcpEntity(mapping: YamlMapping): McpEntity {
  mapping.rejectUnknownKeys(ENTITY_KEYS);

  return {
    name: mapping.requireString("name"),
    transport: parseTransport(mapping),
    expects: parseExpectations(mapping),
  };
}
