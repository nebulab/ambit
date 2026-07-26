/**
 * The public surface, grouped by layer and alphabetical by module within each.
 *
 * Every symbol is named explicitly rather than re-exported wholesale, so adding something to the
 * API is a deliberate edit here rather than a side effect of exporting it from its own module.
 *
 * The order follows `src/`'s dependency layers, top to bottom: ambient, then what is on disk
 * (`model/`), what is derived from it (`resolution/`), and the three consumers — `harness/`,
 * `authoring/`, `project/` — with `cli/` last.
 */

// ── ambient ───────────────────────────────────────────────────────────────────────────────────
export { AmbitError, ExitCode } from "./errors.js";
export { VERSION } from "./version.js";

// ── model — what is on disk and how it is read and written ────────────────────────────────────
export {
  AMBIT_FRONTMATTER_KEY,
  ANNOTATION_KEYS,
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
} from "./model/catalog.js";
export type {
  AnnotationKey,
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
} from "./model/catalog.js";
export {
  CONFIG_FILENAMES,
  CONFIG_VERSION,
  DEFAULT_HARNESSES,
  existingConfigFiles,
  findConfigFile,
  loadProjectConfig,
  parseProjectConfig,
} from "./model/config.js";
export type {
  CatalogRef,
  CatalogSkillRequest,
  ConfigOrigin,
  ProjectConfig,
  SkillRequest,
  SourceSkillRequest,
} from "./model/config.js";
export {
  DIGEST_LENGTH,
  DOCUMENT_FORMATS,
  DOCUMENT_SHAPES,
  arrayEntryKey,
  arraySectionDriver,
  driverFor,
  entryDigest,
  jsonArrayDriver,
  jsonDriver,
  jsoncDriver,
  managedKey,
  readDocumentText,
  tomlDriver,
} from "./model/documents/index.js";
export type {
  ConfigEntry,
  DocumentDriver,
  DocumentFormat,
  DocumentShape,
  JsonObject,
} from "./model/documents/index.js";
export {
  CACHE_DIRNAME,
  REPOS_DIRNAME,
  SOURCES_DIRNAME,
  cacheRoot,
  fetchGitSource,
  gitCacheKey,
} from "./model/git.js";
export type { FetchedGitSource, GitFetchRequest } from "./model/git.js";
export { HOOK_EVENTS, MATCHABLE_EVENTS, parseHookEntity } from "./model/hook-entity.js";
export type { HookEntity, HookEvent } from "./model/hook-entity.js";
export { MCP_TRANSPORT_KINDS, parseMcpEntity } from "./model/mcp-entity.js";
export type { HttpTransport, McpEntity, McpTransport, StdioTransport } from "./model/mcp-entity.js";
export { renderScaffold } from "./model/scaffold.js";
export type { ScaffoldBlock } from "./model/scaffold.js";
export { parseSource, resolveSource } from "./model/sources.js";
export type {
  GitSource,
  PathSource,
  ResolvedSource,
  Source,
  SourceContext,
  SourceRequest,
} from "./model/sources.js";
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
} from "./model/state.js";
export type { ArtifactKind, ArtifactMode, OwnedArtifact, State } from "./model/state.js";
export {
  EditableYaml,
  YamlMapping,
  emitYaml,
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
  splitFrontmatter,
} from "./model/yaml.js";
export type { FrontmatterSplit, PositionedString } from "./model/yaml.js";

// ── resolution — derive and verify the selected closure ───────────────────────────────────────
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
} from "./resolution/resolve.js";
export type {
  Bundle,
  BundleItem,
  ItemKind,
  ReasonedItem,
  Selection,
  SelectionReason,
  SelectionReasons,
} from "./resolution/resolve.js";
export {
  VALIDATION_PROBLEM_KINDS,
  isValid,
  validateCatalog,
  validateCatalogDirectory,
  validateProject,
} from "./resolution/validate.js";
export type {
  ValidateOptions,
  ValidationCounts,
  ValidationProblem,
  ValidationProblemKind,
  ValidationReport,
} from "./resolution/validate.js";

// ── harness — the adapter seam and its implementations ────────────────────────────────────────
export type {
  AppliedArtifact,
  HarnessAdapter,
  PlannedArtifact,
  PlannedHarnessConfig,
  PlannedSkillDir,
  ProjectPaths,
} from "./harness/adapter.js";
export { claude, codex, cursor, opencode, PROFILES, vscode } from "./harness/definitions.js";
export { adapterFor, SHARED_AGENTS_DIR, SHARED_SKILLS_DIR } from "./harness/profile.js";
export type { HarnessProfile, McpLayout } from "./harness/profile.js";
export {
  bracedRef,
  envPassthrough,
  namespacedRef,
  referencedNames,
  shellRef,
  soleReference,
  translateRefs,
} from "./harness/env.js";
export type { EnvRefStyle } from "./harness/env.js";

// ── authoring — the `ambit catalog …` command family ──────────────────────────────────────────
export { annotate, annotationDirname, isMcpTarget } from "./authoring/annotate.js";
export type {
  AnnotateOptions,
  AnnotateResult,
  AnnotatedItem,
  AnnotatedKind,
  AnnotatedList,
  AnnotationEdit,
} from "./authoring/annotate.js";
export {
  AUDIT_FINDING_KINDS,
  auditCatalog,
  auditCatalogDirectory,
  isTidy,
} from "./authoring/audit.js";
export type {
  AuditCounts,
  AuditFinding,
  AuditFindingKind,
  AuditReport,
} from "./authoring/audit.js";
export {
  CatalogDocument,
  applyCatalogEdit,
  catalogFilePath,
  mcpDocumentPath,
  skillDirectoryPath,
  skillDocumentPath,
} from "./authoring/editor.js";
export type {
  CatalogChange,
  CatalogFileChange,
  CatalogTreeChange,
  EditOptions,
  EditResult,
  EditedFile,
} from "./authoring/editor.js";
export {
  CATALOG_INIT_SCOPE,
  CATALOG_KEEP_FILENAME,
  CATALOG_README_FILENAME,
  CATALOG_WORKFLOW_FILENAME,
  initCatalog,
  scaffoldCatalog,
} from "./authoring/init.js";
export type { CatalogInitOptions, CatalogInitResult } from "./authoring/init.js";
export { mcpDocumentFile, mcpTarget, newMcp, removeMcp, unknownMcp } from "./authoring/mcp.js";
export type {
  McpEdit,
  McpNewOptions,
  McpNewResult,
  McpRemoveResult,
  McpSummary,
} from "./authoring/mcp.js";
export { addScope, assertRegisteredScopes, removeScope, renameScope } from "./authoring/scope.js";
export type {
  ScopeAddResult,
  ScopeEdit,
  ScopeRemoveResult,
  ScopeRename,
  ScopeRenameResult,
} from "./authoring/scope.js";
export { newSkill, removeSkill, renameSkill, unknownSkill } from "./authoring/skill.js";
export type {
  SkillAnnotations,
  SkillEdit,
  SkillNewOptions,
  SkillNewResult,
  SkillRemoveResult,
  SkillRename,
  SkillRenameResult,
  SkillSummary,
} from "./authoring/skill.js";
export { buildScopeTree, flattenScopeTree, scopeTree, selectionSize } from "./authoring/tree.js";
export type { ScopeNode, ScopeSelection } from "./authoring/tree.js";

// ── project — act on a consuming project ──────────────────────────────────────────────────────
export { cleanProject, pruneProject } from "./project/clean.js";
export type { CleanOptions, CleanResult, PruneOptions, PruneResult } from "./project/clean.js";
export {
  DOCTOR_CHECKS,
  DOCTOR_SEVERITIES,
  diagnoseProject,
  doctorFailures,
  doctorWarnings,
  isHealthy,
} from "./project/doctor.js";
export type {
  CheckResult,
  CheckStatus,
  DoctorCheck,
  DoctorFinding,
  DoctorOptions,
  DoctorReport,
  DoctorSeverity,
} from "./project/doctor.js";
export {
  BLOCK_BEGIN,
  BLOCK_END,
  GITIGNORE_FILENAME,
  gitignoreBlocks,
  gitignoreStatus,
  readGitignoreText,
  removeGitignoreBlocks,
  removeGitignoreText,
  SHARED_GITIGNORE_FILE,
  updateGitignoreText,
  writeGitignoreBlocks,
} from "./project/gitignore.js";
export type { GitignoreStatus, IgnoreBlock } from "./project/gitignore.js";
export { INIT_FILENAME, INIT_SCOPE, initProject, scaffoldConfig } from "./project/init.js";
export type { InitOptions, InitResult } from "./project/init.js";
export {
  ADAPTERS,
  adaptersFor,
  installProject,
  planFor,
  planInstall,
  previewInstall,
} from "./project/install.js";
export type {
  AdapterPlan,
  InstallOptions,
  InstallPreview,
  InstallResult,
  PlannedInstall,
} from "./project/install.js";
export {
  LOCK_FILENAME,
  LOCK_VERSION,
  assertLockCurrent,
  buildLock,
  lockFilePath,
  readLockText,
  serializeLock,
  writeLockText,
} from "./project/lock.js";
export type { Lock, LockCatalog, LockMcp, LockSkill } from "./project/lock.js";
export { authorizePlan, ownedKeys } from "./project/ownership.js";
export type { OwnershipOptions } from "./project/ownership.js";
export { planPrune, pruneArtifacts, remainingArtifacts } from "./project/prune.js";
export type { PrunedArtifact } from "./project/prune.js";
export {
  ARTIFACT_STATES,
  isClean,
  projectStatus,
  statusDrift,
  statusOfPlan,
} from "./project/status.js";
export type {
  ArtifactState,
  ProjectStatus,
  StatusArtifact,
  StatusOptions,
} from "./project/status.js";

// ── cli — presentation and dispatch ───────────────────────────────────────────────────────────
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
} from "./cli/commands.js";
export type {
  CommandContext,
  CommandHandler,
  CommandHandlers,
  CommandRule,
  CommandRules,
  CommandSpec,
  CommandSubject,
} from "./cli/commands.js";
export { changeKindOf, diffLines, diffSection, treeChangeSummary } from "./cli/diff.js";
export type { ChangeKind } from "./cli/diff.js";
export { buildProgram, run } from "./cli/program.js";
export type { Io } from "./cli/program.js";
