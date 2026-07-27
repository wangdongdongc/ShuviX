/**
 * git 工具的注入环境 —— 两端唯一的差异点。
 *
 * gitOps/diffOps 的全部逻辑跨端共享（isomorphic-git 单后端），宿主只注入 GitEnv：
 * - 桌面：fs = node:fs 模块整体，dir = 会话 workingDirectory 绝对路径，fallback 解析 ~/.gitconfig
 * - 扩展：fs = createFsaFsClient(会话根句柄)（FSA/OPFS），dir = '/'，无 fallback
 *
 * GitFsClient 是 isomorphic-git PromiseFsClient 的最小结构类型（不依赖 node/dom lib）。
 * 注意与 fileTools 的 FileSystemPort 语义不同：这里要求 node-fs 语义 ——
 * stat 对不存在的路径抛 code:'ENOENT' 的错误、readFile 无 encoding 时返回 Uint8Array。
 */

/** commit 署名 */
export interface GitAuthor {
  name: string
  email: string
}

/** node fs.Stats 的最小结构（isomorphic-git 消费的字段/方法；mode/ino 等允许造假值） */
export interface GitFsStat {
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
  /** 文件 0o100644 / 目录 0o40000（FSA 适配器造假值） */
  mode: number
  size: number
  /** 无真实值的实现填 0 */
  ino: number
  mtimeMs: number
  ctimeMs?: number
  uid: number
  gid: number
  dev: number
}

/**
 * isomorphic-git 要求的 promise 风格 fs 契约。
 * 错误必须带 node 风格 `code`（'ENOENT' / 'EEXIST' / 'ENOTEMPTY' …），
 * isomorphic-git 靠捕获 ENOENT 判断文件不存在。
 */
export interface GitFsPromises {
  /** 无 encoding 返回 Uint8Array；encoding:'utf8' 返回 string */
  readFile(path: string, options?: { encoding?: 'utf8' } | 'utf8'): Promise<Uint8Array | string>
  writeFile(
    path: string,
    data: Uint8Array | string,
    options?: { encoding?: 'utf8'; mode?: number } | 'utf8'
  ): Promise<void>
  unlink(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  /** 父目录不存在抛 ENOENT；已存在抛 EEXIST（isomorphic-git 会捕获处理） */
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  rmdir(path: string): Promise<void>
  stat(path: string): Promise<GitFsStat>
  /** 不支持 symlink 的实现可等同 stat */
  lstat(path: string): Promise<GitFsStat>
  readlink?(path: string): Promise<string>
  symlink?(target: string, path: string): Promise<void>
  chmod?(path: string, mode: number): Promise<void>
}

export interface GitFsClient {
  promises: GitFsPromises
}

/** isomorphic-git 的共享缓存对象（同一会话内所有调用复用，显著减少重复解包） */
export type GitCache = Record<string, unknown>

/** 端注入的 git 运行环境 */
export interface GitEnv {
  fs: GitFsClient
  /** 仓库根：桌面为绝对路径；扩展以句柄为根，恒为 '/' */
  dir: string
  /**
   * .git/config 缺 user.name/user.email 且未传参时的端级回退
   * （桌面读 ~/.gitconfig；扩展不注入）。
   */
  resolveAuthorFallback?: () => Promise<GitAuthor | undefined>
}

/**
 * 单个 git op 的输出。业务失败不抛错：置 details.error + text 说明（"Error: " 开头），
 * 让 agent 读到后自行改道 —— 与 browser 工具同约定。
 */
export interface GitOpOutput {
  text?: string
  details?: Record<string, unknown>
}
