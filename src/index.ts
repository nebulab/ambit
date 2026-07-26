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
  envPlaceholders,
} from "./adapters/claude.js";
export {
  MCPS_DIRNAME,
  MCP_EXTENSIONS,
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
  CatalogMcp,
  CatalogOverlay,
  CatalogParseOptions,
  CatalogSkill,
  MergedCatalog,
  MergedMcp,
  MergedSkill,
  ScopeDefinition,
  Shadowing,
  Shadowings,
} from "./catalog.js";
export { ANNOTATION_KEYS, annotate, annotationDirname, isMcpTarget } from "./catalog-annotate.js";
export type {
  AnnotateOptions,
  AnnotateResult,
  AnnotatedItem,
  AnnotatedKind,
  AnnotatedList,
  AnnotationEdit,
  AnnotationKey,
} from "./catalog-annotate.js";
export {
  AUDIT_FINDING_KINDS,
  auditCatalog,
  auditCatalogDirectory,
  isTidy,
} from "./catalog-audit.js";
export type {
  AuditCounts,
  AuditFinding,
  AuditFindingKind,
  AuditReport,
} from "./catalog-audit.js";
export {
  CATALOG_INIT_SCOPE,
  CATALOG_KEEP_FILENAME,
  CATALOG_README_FILENAME,
  CATALOG_WORKFLOW_FILENAME,
  initCatalog,
  scaffoldCatalog,
} from "./catalog-init.js";
export type { CatalogInitOptions, CatalogInitResult } from "./catalog-init.js";
export { mcpDocumentFile, mcpTarget, newMcp, removeMcp, unknownMcp } from "./catalog-mcp.js";
export type {
  McpEdit,
  McpNewOptions,
  McpNewResult,
  McpRemoveResult,
  McpSummary,
} from "./catalog-mcp.js";
export { addScope, assertRegisteredScopes, removeScope, renameScope } from "./catalog-scope.js";
export type {
  ScopeAddResult,
  ScopeEdit,
  ScopeRemoveResult,
  ScopeRename,
  ScopeRenameResult,
} from "./catalog-scope.js";
export { newSkill, removeSkill, renameSkill, unknownSkill } from "./catalog-skill.js";
export type {
  SkillAnnotations,
  SkillEdit,
  SkillNewOptions,
  SkillNewResult,
  SkillRemoveResult,
  SkillRename,
  SkillRenameResult,
  SkillSummary,
} from "./catalog-skill.js";
export { buildScopeTree, flattenScopeTree, scopeTree, selectionSize } from "./catalog-tree.js";
export type { ScopeNode, ScopeSelection } from "./catalog-tree.js";
export { cleanProject, pruneProject } from "./clean.js";
export type { CleanOptions, CleanResult, PruneOptions, PruneResult } from "./clean.js";
export {
  COMMAND_SPECS,
  catalogDirOf,
  dryRunRequested,
  jsonRequested,
  offlineRequested,
  optionList,
  positional,
  projectDirOf,
  sourceContextOf,
} from "./commands.js";
export type {
  CommandContext,
  CommandHandler,
  CommandHandlers,
  CommandSpec,
  CommandSubject,
} from "./commands.js";
export {
  CONFIG_FILENAMES,
  CONFIG_VERSION,
  DEFAULT_HARNESSES,
  existingConfigFiles,
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
  DOCTOR_CHECKS,
  DOCTOR_SEVERITIES,
  diagnoseProject,
  doctorFailures,
  doctorWarnings,
  isHealthy,
} from "./doctor.js";
export type {
  CheckResult,
  CheckStatus,
  DoctorCheck,
  DoctorFinding,
  DoctorOptions,
  DoctorReport,
  DoctorSeverity,
} from "./doctor.js";
export { changeKindOf, diffLines, diffSection, treeChangeSummary } from "./diff.js";
export type { ChangeKind } from "./diff.js";
export {
  CatalogDocument,
  applyCatalogEdit,
  catalogFilePath,
  mcpDocumentPath,
  skillDirectoryPath,
  skillDocumentPath,
} from "./editor.js";
export type {
  CatalogChange,
  CatalogFileChange,
  CatalogTreeChange,
  EditOptions,
  EditResult,
  EditedFile,
} from "./editor.js";
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
export { INIT_FILENAME, INIT_SCOPE, initProject, scaffoldConfig } from "./init.js";
export type { InitOptions, InitResult } from "./init.js";
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
  SCOPE_SEPARATOR,
  assertScopesRegistered,
  closeOverRequires,
  cycleError,
  explainSelection,
  formatReason,
  inSubtree,
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
export { renderScaffold } from "./scaffold.js";
export type { ScaffoldBlock } from "./scaffold.js";
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
export { ARTIFACT_STATES, isClean, projectStatus, statusDrift, statusOfPlan } from "./status.js";
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
  EditableYaml,
  YamlMapping,
  emitYaml,
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
  splitFrontmatter,
} from "./yaml.js";
export type { FrontmatterSplit, PositionedString } from "./yaml.js";
