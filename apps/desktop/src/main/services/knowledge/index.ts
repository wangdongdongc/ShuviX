/**
 * Knowledge 模块入口 —— 知识库 v2（OKF）的桌面宿主层。设计：docs/okf-knowledge-design.md。
 *
 * **两个根、一个目录一个库**：`~/.shuvix/knowledge/` 下每个子目录是一个用户知识库，
 * `~/.shuvix/knowledge-shuvix/projects/<projectId>/` 是每个项目的库，两边一视同仁。**读宽写严**：库里
 * 每个 md 都是一条笔记，只有 `knowledge` 工具 `create` 出来的条目保证 OKF 合规。宿主的簿记只剩扫描缓存、
 * 检索索引、写入后按 bundle 提交 git —— index.md / log.md 不再维护，也没有「建库」这一步：目录随第一次
 * 写入出现，git 仓库在第一次提交前按需建出。
 *
 * 手动维护（侧栏的三个「新建」）在 create.ts：建目录、按标题派生文件名建条目 —— 改名与删除仍然
 * 交给文件系统。
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
  projectBundleId,
  userBundleId,
  isUserBundle,
  isValidLibraryName,
  PROJECTS_CONTAINER,
  USER_CONTAINER
} from './knowledgePaths'
export {
  sessionBundle,
  resolveBase,
  listBases,
  selectedBaseNames,
  enabledBaseChoices,
  knowledgeBaseOptions,
  type SessionBundleTarget,
  type KnowledgeBaseOption
} from './sessionBundle'
export {
  scanBundle,
  scanAllBundles,
  listBundles,
  listBundleDirs,
  listProjectBundles,
  listUserLibraries,
  invalidateKnowledgeScan
} from './scan'
export {
  createKnowledgeBase,
  createKnowledgeFolder,
  createKnowledgeEntry,
  type KnowledgeCreateResult
} from './create'
export { ensureBundleRepo, flushKnowledgeCommits, type KnowledgeChangeOp } from './repo'
export { searchBundle, invalidateKnowledgeSearch } from './search'
export {
  recordKnowledgeChange,
  notifyKnowledgeFileChanged,
  flushKnowledgeChanges,
  type KnowledgeChange
} from './changes'
export { listKnowledgeEntries } from './entries'
