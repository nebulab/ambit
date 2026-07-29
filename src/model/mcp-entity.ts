/**
 * MCP entity parsing.
 *
 * The same shape appears in two places — `mcps/<name>.yml` in a catalog, and inline `mcps`
 * entries in `ambit.yml` — so one parser serves both.
 */
import type { Expectation } from "./expectation.js";
import { parseExpectations } from "./expectation.js";
import type { YamlMapping } from "./yaml.js";

/** A locally-spawned server. */
export interface StdioTransport {
  readonly kind: "stdio";
  readonly command: string;
  readonly args: readonly string[];
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
  /**
   * Declared tags: free-form labels, registered nowhere, that a consumer can select on. Empty means
   * reachable only via `requires` or an explicit listing.
   */
  readonly tags: readonly string[];
  readonly transport: McpTransport;
  /** What must be true of the world for this server to work — its credentials, today. */
  readonly expects: readonly Expectation[];
}

/**
 * The transport kinds ambit understands. `transport` carries exactly one of these as a nested
 * key, so the kind's own fields stay scoped to it and a new kind adds nothing at the top level.
 */
export const MCP_TRANSPORT_KINDS = ["http", "stdio"] as const;

const ENTITY_KEYS = ["expects", "name", "tags", "transport"] as const;

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
      stdio.rejectUnknownKeys(["args", "command"]);
      return {
        kind: "stdio",
        command: stdio.requireString("command"),
        args: stdio.optionalStringList("args") ?? [],
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
    tags: mapping.optionalStringList("tags") ?? [],
    transport: parseTransport(mapping),
    expects: parseExpectations(mapping),
  };
}
