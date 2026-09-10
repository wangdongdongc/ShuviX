/**
 * Knowledge 模块入口 —— 知识库 v2（OKF bundle，~/.shuvix/knowledge）的桌面宿主层。
 * 设计：docs/okf-knowledge-design.md。核心逻辑在 @shuvix/agent-runtime 的 knowledge/，
 * 这里只做宿主该做的：根目录与种子、扫描缓存、作用域解析（会话 → 目录）、index/log 投影、
 * git 提交、检索索引、`<knowledge>` 围栏、写入者 actor。
 *
 * 旧 wiki（services/wikiService.ts）与旧项目记忆（services/memory/）整体搁置，本模块只**读**
 * 旧记忆（围栏里只读列出），不改它们。
 */
export { getKnowledgeRoot, toBundlePath, fromBundlePath } from './knowledgePaths'
export { ensureKnowledgeRoot, isKnowledgeRootInitialized, HOST_ACTOR } from './root'
export {
  scanKnowledge,
  listKnowledgeFiles,
  invalidateKnowledgeScan,
  findProjectDir,
  findBotDir
} from './scan'
export {
  sessionKnowledgeContext,
  resolveSessionScopeTarget,
  ensureProjectScope,
  ensureBotScope,
  sessionFenceScopes
} from './scopes'
export { projectKnowledgeBundle } from './projection'
export { ensureKnowledgeRepo, flushKnowledgeCommits } from './repo'
export { searchKnowledge, invalidateKnowledgeSearch } from './search'
export {
  recordKnowledgeChange,
  notifyKnowledgeFileChanged,
  flushKnowledgeChanges,
  type KnowledgeChange
} from './changes'
export { resolveKnowledgeFence } from './inject'
