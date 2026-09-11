/**
 * 知识库 v2（OKF）—— 宿主无关的核心：编解码、概念文件、bundle 内路径算术、保留文件投影、
 * 一致性校验、`knowledge` 工具。设计见 docs/okf-knowledge-design.md。
 *
 * **一个绑定实体一个 bundle**：本模块里凡是「路径」都是 **bundle 相对**的，谁是哪个 bundle
 * 由宿主回答。跨 bundle 的引用走 `shuvix://` URI，不走路径。
 *
 * **只有一条写入路**：条目由普通 `write` / `edit` 写出来（写钩子回执诊断并盖 `generated`，
 * 变更管线投影 index/log 并提交），社区 skill 与人工编辑因此天然同权。`knowledge` 工具只做
 * 读侧：search / list / read / validate / locate。
 *
 * **没有注入面**：把条目自动喂进系统提示词的机制（原 `<knowledge>` 围栏与 agent md 键
 * `shuvix-knowledge`）已整体撤除 —— 怎么注入还没想清楚，留待重新设计。
 * 宿主（桌面 services/knowledge/）负责根目录、扫描、git、盖章接线与 bundle 解析。
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
export { normalizeBundlePath, escapesBundle, slugify, dedupeFileName } from './bundlePaths'
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
  type KnowledgeBundleTarget,
  type KnowledgeBundleScan,
  type KnowledgeSearchHit
} from './knowledgeTool'
export { toKnowledgeEntry } from './entryView'
export { renderKnowledgeGuide } from './knowledgeGuide'
