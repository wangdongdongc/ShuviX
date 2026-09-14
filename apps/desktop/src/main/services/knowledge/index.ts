/**
 * Knowledge 模块入口 —— 知识库 v2（OKF）的桌面宿主层。设计：docs/okf-knowledge-design.md。
 *
 * **两个根、一个 bundle 一个库**：`~/.shuvix/knowledge/` 下每个子目录是一个用户知识库，
 * `~/.shuvix/knowledge-shuvix/` 是 ShuviX 维护的，本期只有 `projects/<projectId>/`。两边的簿记
 * 一视同仁。核心逻辑在 @shuvix/agent-runtime 的 knowledge/，这里只做宿主该做的：两个根、bundle 的
 * 建立与定位、base 的解析与列举、扫描缓存、按 bundle 的 index/log 投影与 git 提交、检索索引。
 *
 * 旧 wiki（services/wikiService.ts）与旧项目记忆（services/memory/）整体搁置，本模块不碰它们。
 */
export {
  getShuvixKnowledgeRoot,
  getUserKnowledgeRoot,
  bundleDir,
  bundleFilePath,
  entryFilePath,
  locateBundle,
  toShuvixRelative,
  toUserRelative,
  userBundleId,
  isUserBundle,
  isValidLibraryName,
  PROJECTS_CONTAINER,
  USER_CONTAINER
} from './knowledgePaths'
export { ensureProjectBundle, findProjectBundle, isBundleInitialized, HOST_ACTOR } from './bundles'
export { sessionBundle, resolveBase, listBases, type SessionBundleTarget } from './sessionBundle'
export {
  scanBundle,
  scanAllBundles,
  listBundles,
  listProjectBundles,
  listUserLibraries,
  invalidateKnowledgeScan
} from './scan'
export { projectBundle } from './projection'
export { ensureBundleRepo, flushKnowledgeCommits } from './repo'
export { searchBundle, invalidateKnowledgeSearch } from './search'
export {
  recordKnowledgeChange,
  notifyKnowledgeFileChanged,
  flushKnowledgeChanges,
  type KnowledgeChange
} from './changes'
export { listKnowledgeEntries } from './entries'
