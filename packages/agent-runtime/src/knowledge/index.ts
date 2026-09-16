/**
 * 知识库 v2（OKF）—— 宿主无关的核心：编解码、概念文件与笔记读法、bundle 内路径算术、
 * 一致性校验、`knowledge` 工具。设计见 docs/okf-knowledge-design.md。
 *
 * **一个绑定实体一个 bundle**：本模块里凡是「路径」都是 **bundle 相对**的，谁是哪个 bundle
 * 由宿主回答。跨 bundle 的引用走 `shuvix://` URI，不走路径。
 *
 * **读宽写严**：库里任何 md 都是一条笔记（readKnowledgeNote），缺元数据的用户笔记照常列出、检索；
 * 只有 `knowledge` 的 `create` 建出来的条目保证 OKF 合规。改动条目走普通 `edit`（写钩子
 * 回执诊断、给 OKF 条目盖 `generated`，变更管线按 bundle 提交 git），社区 skill 与人工编辑同权。
 *
 * **没有注入面**：把条目自动喂进系统提示词的机制（原 `<knowledge>` 围栏与 agent md 键
 * `shuvix-knowledge`）已整体撤除 —— 怎么注入还没想清楚，留待重新设计。
 * 宿主（桌面 services/knowledge/）负责根目录、扫描、git、盖章接线与 bundle 解析。
 */
export {
  parseOkfText,
  serializeOkfFrontmatter,
  buildOkfConceptDocument,
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
  readKnowledgeNote,
  firstHeading,
  type KnowledgeNote,
  type KnowledgeConcept,
  type KnowledgeSource,
  type KnowledgeStamp,
  type ConceptBuildInput
} from './conceptFile'
export { normalizeBundlePath, escapesBundle, slugify, dedupeFileName } from './bundlePaths'
export {
  validateConceptText,
  validateKnowledgeText,
  validateBundleFiles,
  isProjectionText,
  isProjectionFile,
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
  type KnowledgeBaseInfo,
  type KnowledgeBundleTarget,
  type KnowledgeBundleScan,
  type KnowledgeSearchHit
} from './knowledgeTool'
export { toKnowledgeEntry, toKnowledgeEntryFromNote } from './entryView'
export { renderKnowledgeGuide, type KnowledgeGuideBase } from './knowledgeGuide'
