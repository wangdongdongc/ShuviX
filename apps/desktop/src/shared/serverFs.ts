/**
 * 服务端文件系统通道的形状（server mode phase D）—— `fs:listDirectories` / `fs:locateFolder`，主进程
 * （`ipc/fsHandlers.ts`、`services/directoryListing.ts`）与 web 客户端（目录浏览器、路径提示）共用。纯类型 + 常量。
 */

/** 目录浏览器里的一个子目录 */
export interface DirectoryEntry {
  /** 目录名 */
  readonly name: string
  /** 绝对路径 */
  readonly path: string
}

/** `fs:listDirectories` 的回包 */
export interface DirectoryListing {
  /** 实际列的目录（绝对、规范化） */
  readonly path: string
  /** 上一层；已经在根上 → null */
  readonly parent: string | null
  /** 用户主目录（页面的「主目录」按钮） */
  readonly home: string
  /** 子目录 */
  readonly entries: DirectoryEntry[]
  /** 子目录多于上限、只列了前面那些 */
  readonly truncated?: boolean
  /** 读不了的原因（`ENOENT` / `ENOTDIR` / `EACCES` …）；读得了 → 没有这一项 */
  readonly error?: string
}

/** `fs:listDirectories` 的参数 */
export interface ListDirectoriesParams {
  /** 要列的目录：空 / 不给 → 主目录；`~` / `~/…` 按主目录展开；相对路径按主目录解析 */
  readonly path?: string
  /** 也列隐藏目录（`.` 开头） */
  readonly showHidden?: boolean
}

/** `fs:locateFolder` 认得的目录（与各自「在文件管理器中打开」的通道打开的同一个） */
export type ServerFolderKind = 'agents' | 'policies' | 'hooks' | 'bots' | 'knowledge'

/** `fs:locateFolder` 的参数：一个目录，或一个知识库条目（条目 id） */
export type LocateFolderParams =
  | { readonly kind: ServerFolderKind }
  | { readonly kind: 'knowledgeEntry'; readonly path: string }
