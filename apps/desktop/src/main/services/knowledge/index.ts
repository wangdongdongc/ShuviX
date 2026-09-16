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
 * **第三个根是应用包里的内置库**（`builtin/<库名>`，工具里的保留名 `shuvix`）：ShuviX 自己的说明书，
 * 随版本发布、只读、按界面语言选目录（`<库名>/<lang>/`）。扫描 / 检索 / 笔记本与用户库同一条路，
 * 写那一半全部绕开它：工具 `create` 拒、侧栏没有新建、写钩子不盖章、变更管线不提交，文件工具的
 * 写入由内置策略 protect-builtin-knowledge 拒。
 *
 * 旧 wiki（services/wikiService.ts）与旧项目记忆（services/memory/）整体搁置，本模块不碰它们。
 */
export {
  getShuvixKnowledgeRoot,
  getUserKnowledgeRoot,
  getBuiltinKnowledgeRoot,
  builtinBundleId,
  builtinLanguageDir,
  isBuiltinBundle,
  toBuiltinRelative,
  BUILTIN_CONTAINER,
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
  listBuiltinBundles,
  listAllBuiltinBundleIds,
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
  refreshBuiltinKnowledge,
  type KnowledgeChange
} from './changes'
export { listKnowledgeEntries } from './entries'
