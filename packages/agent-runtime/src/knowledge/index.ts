/**
 * 知识库 v2（OKF）—— 宿主无关的核心：编解码、概念文件、作用域路径算术、保留文件投影、
 * 一致性校验、`knowledge` 工具。设计见 docs/okf-knowledge-design.md。
 *
 * **没有注入面**：把条目自动喂进系统提示词的机制（原 `<knowledge>` 围栏与 agent md 键
 * `shuvix-knowledge`）已整体撤除 —— 怎么注入还没想清楚，留待重新设计。今天 agent 只能
 * 主动经 `knowledge` 工具 search / list / read。
 * 宿主（桌面 services/knowledge/）负责根目录、扫描、git、盖章接线与作用域解析。
 */
export {
  parseOkfText,
  serializeOkfFrontmatter,
  buildOkfConceptDocument,
  buildIndexMd,
  buildRootIndexMd,
  buildLogMd,
  parseLogMd,
  extractConceptLinks,
  deriveTrustTier,
  isStaleAfter,
  type OkfSplit,
  type ConceptLink,
  type TrustTier
} from './okfCodec'
export {
  parseConceptText,
  isOkfConceptText,
  buildConceptText,
  normalizeVerified,
  normalizeSources,
  normalizeKnowledgeType,
  isOkfStatus,
  trustTierOf,
  isVerificationCurrent,
  isStale,
  titleFromPath,
  type KnowledgeConcept,
  type KnowledgeSource,
  type KnowledgeStamp,
  type ConceptBuildInput
} from './conceptFile'
export {
  scopeDir,
  scopeOfPath,
  scopeKindOfPath,
  isSessionScopePath,
  normalizeBundlePath,
  escapesBundle,
  slugify,
  sessionSummaryFileName,
  dedupeFileName,
  scopeLabel,
  type KnowledgeScope
} from './scopes'
export {
  renderAllIndexes,
  appendLogEntry,
  formatLogText,
  comparePaths,
  type ProjectionConcept,
  type RenderIndexesInput,
  type KnowledgeLogOp,
  type KnowledgeLogEvent
} from './projection'
export {
  validateConceptText,
  validateBundleFiles,
  resolveLinkTarget,
  isReservedFile,
  type KnowledgeDiagnostic,
  type BundleFile,
  type BundleValidation
} from './validate'
export {
  KnowledgeTool,
  createKnowledgeTool,
  KnowledgeParamsSchema,
  KNOWLEDGE_TOOL_NAME,
  KNOWLEDGE_DESCRIPTION,
  type KnowledgeAction,
  type KnowledgeToolParams,
  type KnowledgeToolDeps,
  type KnowledgeScopeTarget,
  type KnowledgeSearchHit
} from './knowledgeTool'
export { toKnowledgeEntry } from './entryView'
