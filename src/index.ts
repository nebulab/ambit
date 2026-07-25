export { AmbitError, ExitCode } from "./errors.js";
export type {
  AppliedArtifact,
  HarnessAdapter,
  PlannedArtifact,
  PlannedHarnessConfig,
  PlannedSkillDir,
  ProjectPaths,
} from "./adapter.js";
export {
  CLAUDE_HARNESS,
  CLAUDE_MCP_FILE,
  CLAUDE_MCP_SECTION,
  CLAUDE_SKILLS_DIR,
  claudeAdapter,
} from "./adapters/claude.js";
export {
  MCPS_DIRNAME,
  SCOPES_FILENAME,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  loadCatalogs,
  mergeCatalogs,
  parseCatalogDirectory,
  resolveCatalogRoot,
  skillNameFromPath,
} from "./catalog.js";
export type {
  Catalog,
  CatalogSkill,
  MergedCatalog,
  MergedMcp,
  MergedSkill,
  ScopeDefinition,
} from "./catalog.js";
export { COMMAND_SPECS, jsonRequested, projectDirOf } from "./commands.js";
export type { CommandContext, CommandHandler, CommandHandlers, CommandSpec } from "./commands.js";
export {
  CONFIG_FILENAMES,
  CONFIG_VERSION,
  DEFAULT_HARNESSES,
  findConfigFile,
  loadProjectConfig,
  parseProjectConfig,
} from "./config.js";
export type {
  CatalogRef,
  CatalogSkillRequest,
  ConfigOrigin,
  ProjectConfig,
  SkillRequest,
  SourceSkillRequest,
} from "./config.js";
export {
  EMPTY_DOCUMENT,
  managedKey,
  mergeConfigSection,
  readJsonDocument,
  serializeJsonDocument,
} from "./harness-config.js";
export type { ConfigEntry, JsonObject } from "./harness-config.js";
export { ADAPTERS, installProject } from "./install.js";
export type { InstallResult } from "./install.js";
export { MCP_TRANSPORT_KINDS, parseMcpEntity } from "./mcp.js";
export type { HttpTransport, McpEntity, McpTransport, StdioTransport } from "./mcp.js";
export { buildProgram, run } from "./program.js";
export type { Io } from "./program.js";
export { assertScopesRegistered, closeOverRequires, resolveBundle } from "./resolve.js";
export type { Bundle, Selection } from "./resolve.js";
export {
  ARTIFACT_KINDS,
  ARTIFACT_MODES,
  EMPTY_STATE,
  STATE_DIRNAME,
  STATE_FILENAME,
  STATE_VERSION,
  ownedPaths,
  parseState,
  readState,
  serializeState,
  stateFilePath,
  writeState,
} from "./state.js";
export type { ArtifactKind, ArtifactMode, OwnedArtifact, State } from "./state.js";
export { VERSION } from "./version.js";
export {
  YamlMapping,
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
} from "./yaml.js";
export type { PositionedString } from "./yaml.js";
