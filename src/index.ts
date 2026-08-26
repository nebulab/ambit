/**
 * The public surface, grouped by layer and alphabetical by module within each.
 *
 * Every symbol is named explicitly rather than re-exported wholesale, so adding something to the
 * API is a deliberate edit here.
 *
 * Order follows `src/`'s dependency layers: ambient, then what is on disk (`model/`), what is
 * derived from it (`resolution/`), the two consumers `harness/` and `project/`, and `cli/` last.
 */

// ── ambient ───────────────────────────────────────────────────────────────────────────────────
export { AmbitError, ExitCode } from "./errors.js";
export { VERSION } from "./version.js";

// ── model — what is on disk and how it is read and written ────────────────────────────────────
export {
  AMBIT_FRONTMATTER_KEY,
  ANNOTATION_KEYS,
  HOOKS_DIRNAME,
  HOOK_FILENAME,
  MCPS_DIRNAME,
  MCP_EXTENSIONS,
  PACKS_DIRNAME,
  PACK_EXTENSIONS,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  hookCommand,
  loadCatalogs,
  mergeCatalogs,
  parseCatalogDirectory,
  qualifiedName,
  resolveCatalogRoot,
  skillNameFromPath,
} from "./model/catalog.js";
export type {
  AnnotationKey,
  Catalog,
  CatalogHook,
  CatalogLoadOptions,
  CatalogMcp,
  CatalogPack,
  CatalogParseOptions,
  CatalogSkill,
  MergedCatalog,
  MergedHook,
  MergedMcp,
  MergedPack,
  MergedSkill,
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
export type { CatalogRef, ConfigOrigin, ProjectConfig } from "./model/config.js";
export {
  DIGEST_LENGTH,
  DOCUMENT_FORMATS,
  DOCUMENT_SHAPES,
  arrayEntryKey,
  arraySectionDriver,
  driverFor,
  entryDigest,
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
  PROBE_NAMESPACE,
  REFRESH_MODES,
  REPOS_DIRNAME,
  SOURCES_DIRNAME,
  cacheRoot,
  fetchGitSource,
  gitCacheKey,
  isCommitSha,
} from "./model/git.js";
export type { FetchedGitSource, GitFetchRequest, RefreshMode } from "./model/git.js";
export { HOOK_EVENTS, HOOK_TYPES, MATCHABLE_EVENTS, parseHookEntity } from "./model/hook-entity.js";
export type { HookEntity, HookEvent, HookType } from "./model/hook-entity.js";
export { MCP_TRANSPORT_KINDS, parseMcpEntity } from "./model/mcp-entity.js";
export type { HttpTransport, McpEntity, McpTransport, StdioTransport } from "./model/mcp-entity.js";
export { parsePackEntity } from "./model/pack-entity.js";
export type { PackEntity } from "./model/pack-entity.js";
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
  YamlMapping,
  emitYaml,
  parseFrontmatterMapping,
  parseYamlMapping,
  readFrontmatterMapping,
  readYamlMapping,
  splitFrontmatter,
} from "./model/yaml.js";
export type { FrontmatterSplit, PositionedString } from "./model/yaml.js";
export type { Reference } from "./model/reference.js";
export {
  CATALOG_SEPARATOR,
  ITEM_KINDS,
  KIND_SEPARATOR,
  parseItemSubject,
} from "./model/requirement.js";
export type { ItemKind } from "./model/requirement.js";
export {
  REQUIRES_KEY,
  entryAddress,
  entryYaml,
  formatEntry,
  matches,
  matchesPattern,
  parseEntries,
  sameEntry,
  uniqueEntries,
} from "./model/pattern.js";
export type { Addressing, PatternEntry, PatternItem } from "./model/pattern.js";
export {
  EXPECTATION_KINDS,
  EXPECTATION_NOUNS,
  expectedEnv,
  parseExpectations,
  unionExpectations,
} from "./model/expectation.js";
export type { Expectation, ExpectationKind, ExpectationSet } from "./model/expectation.js";

// ── resolution — derive and verify the selected closure ───────────────────────────────────────
export {
  assertEntriesMatch,
  assertNoCollisions,
  closeOverRequires,
  cycleError,
  entryCatalog,
  entryPosition,
  explainSelection,
  formatItem,
  formatReason,
  isSelected,
  matchesAnything,
  matchesOwnCatalog,
  reasonOf,
  requiredEntries,
  requiredItems,
  requirerPosition,
  requirersOf,
  resolveBundle,
  selectingEntry,
  unmatchedEntryError,
} from "./resolution/resolve.js";
export type {
  Bundle,
  BundleItem,
  ReasonedItem,
  Requirer,
  Selection,
  SelectionReason,
  SelectionReasons,
} from "./resolution/resolve.js";
export {
  VALIDATION_PROBLEM_KINDS,
  isValid,
  validateCatalog,
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
  HookSkipReason,
  InstallScope,
  PlannedArtifact,
  PlannedCatalogDir,
  PlannedHarnessConfig,
  PlannedHookDir,
  PlannedSkillDir,
  ProjectPaths,
  SkippedHook,
} from "./harness/adapter.js";
export { claude, codex, cursor, opencode, PROFILES, vscode } from "./harness/definitions.js";
export {
  adapterFor,
  SHARED_AGENTS_DIR,
  SHARED_HOOKS_DIR,
  SHARED_SKILLS_DIR,
  skippedHooks,
} from "./harness/profile.js";
export type { HarnessProfile, HookLayout, McpLayout } from "./harness/profile.js";
export {
  bracedRef,
  namespacedRef,
  referencedNames,
  shellRef,
  soleReference,
  stdioEnv,
  translateRefs,
} from "./harness/env.js";
export type { EnvRefStyle } from "./harness/env.js";

// ── project — act on a consuming project ──────────────────────────────────────────────────────
export {
  BUNDLE_CHANGE_KINDS,
  allChanges,
  countChanges,
  diffBundles,
  hookSummary,
  isUnchanged,
} from "./project/bundle-diff.js";
export type {
  BundleChange,
  BundleChangeCounts,
  BundleChangeKind,
  BundleDiff,
} from "./project/bundle-diff.js";
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
export {
  INIT_FILENAME,
  KEEP_FILENAME,
  LOCAL_CATALOG,
  initProject,
  scaffoldConfig,
  scaffoldProject,
} from "./project/init.js";
export type { InitOptions, InitResult, ScaffoldedFile } from "./project/init.js";
export {
  ADAPTERS,
  adaptersFor,
  installProject,
  installScope,
  planFor,
  planInstall,
  previewInstall,
} from "./project/install.js";
export type {
  AdapterPlan,
  InstallOptions,
  InstallPreview,
  InstallResult,
  PlanContext,
  PlannedInstall,
} from "./project/install.js";
export {
  LOCK_FILENAME,
  LOCK_VERSION,
  assertLockCurrent,
  buildLock,
  lockFilePath,
  readCatalogPins,
  readLockText,
  serializeLock,
  writeLockText,
} from "./project/lock.js";
export type { Lock, LockCatalog, LockHook, LockMcp, LockPack, LockSkill } from "./project/lock.js";
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
export {
  CATALOG_FRESHNESS,
  checkOutdated,
  hasOutdated,
  previewUpdate,
  updateProject,
} from "./project/update.js";
export type {
  CatalogFreshness,
  CatalogPin,
  UpdateInstallOptions,
  UpdateOptions,
  UpdatePlan,
  UpdateResult,
} from "./project/update.js";

// ── cli — presentation and dispatch ───────────────────────────────────────────────────────────
export {
  COMMAND_SPECS,
  dryRunRequested,
  jsonRequested,
  offlineRequested,
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
} from "./cli/commands.js";
export { buildProgram, run } from "./cli/program.js";
export type { Io } from "./cli/program.js";
