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
  formatShadowing,
  loadCatalogs,
  loadSourceSkill,
  mergeCatalogs,
  mergeConfigEntities,
  parseCatalogDirectory,
  resolveCatalogRoot,
  skillNameFromPath,
} from "./catalog.js";
export type {
  Catalog,
  CatalogParseOptions,
  CatalogSkill,
  MergedCatalog,
  MergedMcp,
  MergedSkill,
  ScopeDefinition,
  Shadowing,
  Shadowings,
} from "./catalog.js";
export { cleanProject, pruneProject } from "./clean.js";
export type { CleanOptions, CleanResult, PruneOptions, PruneResult } from "./clean.js";
export {
  COMMAND_SPECS,
  dryRunRequested,
  jsonRequested,
  offlineRequested,
  projectDirOf,
  sourceContextOf,
} from "./commands.js";
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
  CACHE_DIRNAME,
  REPOS_DIRNAME,
  SOURCES_DIRNAME,
  cacheRoot,
  fetchGitSource,
  gitCacheKey,
} from "./git.js";
export type { FetchedGitSource, GitFetchRequest } from "./git.js";
export {
  BLOCK_BEGIN,
  BLOCK_END,
  GITIGNORE_FILENAME,
  gitignoreEntries,
  readGitignoreText,
  removeGitignoreBlock,
  removeGitignoreText,
  updateGitignoreText,
  writeGitignoreBlock,
} from "./gitignore.js";
export {
  EMPTY_DOCUMENT,
  managedKey,
  mergeConfigSection,
  readJsonDocument,
  removeConfigKeys,
  sectionKeys,
  sectionOf,
  serializeJsonDocument,
} from "./harness-config.js";
export type { ConfigEntry, JsonObject } from "./harness-config.js";
export { ADAPTERS, adaptersFor, installProject, planInstall, previewInstall } from "./install.js";
export type {
  AdapterPlan,
  InstallOptions,
  InstallPreview,
  InstallResult,
  PlannedInstall,
} from "./install.js";
export {
  LOCK_FILENAME,
  LOCK_VERSION,
  assertLockCurrent,
  buildLock,
  lockFilePath,
  readLockText,
  serializeLock,
  writeLockText,
} from "./lock.js";
export type { Lock, LockCatalog, LockMcp, LockSkill } from "./lock.js";
export { MCP_TRANSPORT_KINDS, parseMcpEntity } from "./mcp.js";
export type { HttpTransport, McpEntity, McpTransport, StdioTransport } from "./mcp.js";
export { authorizePlan, ownedKeys } from "./ownership.js";
export type { OwnershipOptions } from "./ownership.js";
export { buildProgram, run } from "./program.js";
export type { Io } from "./program.js";
export { planPrune, pruneArtifacts, remainingArtifacts } from "./prune.js";
export type { PrunedArtifact } from "./prune.js";
export {
  MCP_REQUIREMENT_PREFIX,
  assertScopesRegistered,
  closeOverRequires,
  cycleError,
  explainSelection,
  formatReason,
  isSelected,
  missingRequirement,
  reasonOf,
  resolveBundle,
  scopeSuggestion,
  skillFile,
  unknownExplicitSkill,
  unknownScopeError,
} from "./resolve.js";
export type {
  Bundle,
  BundleItem,
  ItemKind,
  ReasonedItem,
  Selection,
  SelectionReason,
  SelectionReasons,
} from "./resolve.js";
export { parseSource, resolveSource } from "./sources.js";
export type {
  GitSource,
  PathSource,
  ResolvedSource,
  Source,
  SourceContext,
  SourceRequest,
} from "./sources.js";
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
export { ARTIFACT_STATES, isClean, projectStatus, statusDrift } from "./status.js";
export type { ArtifactState, ProjectStatus, StatusArtifact, StatusOptions } from "./status.js";
export {
  VALIDATION_PROBLEM_KINDS,
  isValid,
  validateCatalog,
  validateCatalogDirectory,
  validateProject,
} from "./validate.js";
export type {
  ValidateOptions,
  ValidationCounts,
  ValidationProblem,
  ValidationProblemKind,
  ValidationReport,
} from "./validate.js";
export { VERSION } from "./version.js";
export {
  YamlMapping,
  emitYaml,
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
} from "./yaml.js";
export type { PositionedString } from "./yaml.js";
