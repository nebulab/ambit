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
  CATALOG_SEPARATOR,
  HOOKS_DIRNAME,
  HOOK_FILENAME,
  MCPS_DIRNAME,
  MCP_EXTENSIONS,
  SKILLS_DIRNAME,
  SKILL_FILENAME,
  copiesByName,
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
  CatalogMcp,
  CatalogOverlay,
  CatalogParseOptions,
  CatalogSkill,
  MergedCatalog,
  MergedHook,
  MergedMcp,
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
  REPOS_DIRNAME,
  SOURCES_DIRNAME,
  cacheRoot,
  fetchGitSource,
  gitCacheKey,
} from "./model/git.js";
export type { FetchedGitSource, GitFetchRequest } from "./model/git.js";
export { HOOK_EVENTS, HOOK_TYPES, MATCHABLE_EVENTS, parseHookEntity } from "./model/hook-entity.js";
export type { HookEntity, HookEvent, HookType } from "./model/hook-entity.js";
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
export {
  KIND_SEPARATOR,
  formatReference,
  isReference,
  parseReference,
  parseReferenceList,
  parseSubject,
  referenceYaml,
  sameReference,
  sortedUniqueReferences,
} from "./model/reference.js";
export type { Reference, ReferenceGrammar, ReferenceGrammarOf } from "./model/reference.js";
export {
  ITEM_KINDS,
  KIND_NOUNS,
  REQUIRES,
  formatRequirement,
  isRequirementReference,
  parseRequirement,
  parseRequirements,
  requirementYaml,
  sameRequirement,
  sortedUniqueRequirements,
} from "./model/requirement.js";
export type { ItemKind, Requirement } from "./model/requirement.js";
export {
  CAPABILITIES,
  CAPABILITIES_KEY,
  CAPABILITY_OF_KIND,
  PATTERN_FIELDS,
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
export type {
  Addressing,
  Capability,
  PatternEntry,
  PatternField,
  PatternItem,
} from "./model/pattern.js";
export {
  EXPECTATION_KINDS,
  EXPECTATION_NOUNS,
  EXPECTS,
  expectationYaml,
  expectedEnv,
  formatExpectation,
  parseExpectation,
  parseExpectations,
  sameExpectation,
  sortedUniqueExpectations,
  unionExpectations,
} from "./model/expectation.js";
export type { Expectation, ExpectationKind, ExpectationSet } from "./model/expectation.js";

// ── resolution — derive and verify the selected closure ───────────────────────────────────────
export {
  assertEntriesMatch,
  assertNoCollisions,
  closeOverRequires,
  cycleError,
  entryPosition,
  explainSelection,
  formatReason,
  isSelected,
  matchesAnything,
  missingRequirement,
  reasonOf,
  resolveBundle,
  selectingEntry,
  skillFile,
  unmatchedEntryError,
} from "./resolution/resolve.js";
export type {
  Bundle,
  BundleItem,
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
  HookSkipReason,
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
  envPassthrough,
  namespacedRef,
  referencedNames,
  shellRef,
  soleReference,
  translateRefs,
} from "./harness/env.js";
export type { EnvRefStyle } from "./harness/env.js";

// ── authoring — what `ambit catalog init` writes ──────────────────────────────────────────────
export {
  CatalogDocument,
  applyCatalogEdit,
  catalogFilePath,
  hookDirectoryPath,
  hookDocumentPath,
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
  CATALOG_KEEP_FILENAME,
  CATALOG_README_FILENAME,
  CATALOG_WORKFLOW_FILENAME,
  initCatalog,
  scaffoldCatalog,
} from "./authoring/init.js";
export type { CatalogInitOptions, CatalogInitResult } from "./authoring/init.js";

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
export { INIT_FILENAME, initProject, scaffoldConfig } from "./project/init.js";
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
export type { Lock, LockCatalog, LockHook, LockMcp, LockSkill } from "./project/lock.js";
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
