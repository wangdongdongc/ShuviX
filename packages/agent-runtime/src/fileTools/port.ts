/**
 * FileSystemPort —— 文件工具的注入式「File API」（宿主无关）。
 *
 * 共享内核（read/write/ls 的内层操作）只依赖此接口；桌面用 Node fs 实现，
 * 扩展用 File System Access 实现。路径字符串由各端 port 自行解释
 * （桌面=绝对路径走 fs；扩展=相对句柄根、按 '/' 逐段导航）。
 */
export interface FileStat {
  isFile: boolean
  isDirectory: boolean
  size: number
  mtimeMs: number
}

export interface DirEntry {
  name: string
  isDirectory: boolean
}

export interface FileSystemPort {
  /** 取文件/目录信息；不存在返回 null */
  stat(path: string): Promise<FileStat | null>
  /** 按行流式读取文本（桌面 readline 流；扩展整读后切分） */
  readTextLines(path: string): AsyncIterable<string>
  /** 整读文件为 UTF-8 文本（edit 需要原始全文做 BOM/行尾/匹配） */
  readFile(path: string): Promise<string>
  /**
   * 按范围读取原始字节（预览面板的 hex/嗅探/图片用）。
   * 桌面 fh.read(pos)、扩展 File.slice —— 两端都只读请求的 length，不整读大文件。
   * 实际读到的字节可能少于 length（文件尾），返回真实长度的视图。
   */
  readBytes(path: string, offset: number, length: number): Promise<Uint8Array>
  /** 写文件（自动创建父目录） */
  writeFile(path: string, content: string): Promise<void>
  /** 列目录条目 */
  readdir(path: string): Promise<DirEntry[]>
}

/**
 * 写入前询问钩子（注入）—— 在文件锁内、`port.writeFile` 之前调用，参数就是即将发生的改动。
 *
 * 不通过时约定 **throw**（工具中止，AI 收到 tool error）；通过则原样 return。
 * 之所以要把 diff 传进来而不是让询问侧自己算：询问卡片展示的和事后 details 里的必须是
 * 同一个字符串（见 AskDiffPreview 的一致性契约），所以只能由算出它的人来传。
 */
export type WriteAskHook = (change: {
  /** 展示用路径 */
  path: string
  /** 即将写入产生的 diff —— 与 tool result details.diff 同一份 */
  diff: string
  /** 目标文件此前不存在 */
  isNewFile?: boolean
}) => Promise<void>

/**
 * 写守卫（注入）：读后被改检测 + 写锁。桌面绑 fileTime(sessionId)，扩展绑自身实现。
 * mtime 的获取由各端在 assertNotModifiedSinceRead 内自行完成（桌面 statSync / 扩展 port.stat）。
 */
export interface FileGuards {
  /** 该路径是否记录过「读取时间」（truthy 表示读过） */
  hasReadTime(path: string): boolean
  /** 校验文件自上次读取后是否被外部修改（未读过或被改 → 抛错） */
  assertNotModifiedSinceRead(path: string): void | Promise<void>
  /** 记录读取时间（写成功后调用，避免后续编辑被自身写入触发警告） */
  recordRead(path: string): void
  /** 对同一文件的并发写串行化 */
  withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>
}
