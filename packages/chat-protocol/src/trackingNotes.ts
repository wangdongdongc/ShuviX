/**
 * 跟踪项（实验）—— 一件需要持续跟进、跨好几天才有结论的事，一项一个 md（`~/.shuvix/tracking/<名字>.md`），
 * 由 bot（内置的日报 bot）从会话里整理出来并全权维护。格式只约定身份：新建时写 `shuvix: track v1` 与 `shuvix-id`，
 * 标题取正文第一个 `# ` 标题；其余（背景、进展、结论）都是正文，暂时没有状态 / 下次查看之类的管理字段 ——
 * 等用出不足再补。
 *
 * 与日报同一套载体做法：目录有一个隐藏载体项目（`__tracking__`，path = 目录本身），一份文件至多一个笔记本会话，
 * 重复打开复用；侧栏 Library 的「跟踪项」分组列出它们。这里只放纯函数，读写盘在主进程 `services/trackingNotes.ts`。
 */

/** 跟踪项目录的隐藏载体项目 id（同 `__daily__` / `__bots__` 的做法） */
export const TRACKING_PROJECT_ID = '__tracking__'
export const isTrackingProjectId = (id: string | null | undefined): boolean =>
  id === TRACKING_PROJECT_ID

/** `shuvix: <type> v<n>` 的 type 段 */
export const TRACKING_MARKER_TYPE = 'track'
export const TRACKING_MARKER_VERSION = '1'

/** 侧栏的一行 */
export interface TrackingItem {
  /** 跟踪项目录下的文件名（笔记本会话按它认） */
  fileName: string
  /** 正文第一个 `# ` 标题；没有就是去掉 `.md` 的文件名 */
  title: string
  /** 文件最后修改时刻（毫秒）—— 列表按它倒序 */
  updatedAt: number
  /** 文件的绝对路径（行菜单的「在文件夹中显示」「复制路径」） */
  path: string
}

/** 是不是一份跟踪项文件：目录里的 `.md`，点开头的隐藏文件不算 */
export function isTrackingFileName(fileName: string): boolean {
  return /\.md$/i.test(fileName) && !fileName.startsWith('.') && !/[\\/]/.test(fileName)
}

/** 跳过 frontmatter，取正文第一个一级标题；没有就用文件名（去掉 `.md`） */
export function trackingTitle(source: string, fileName: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body)
  const title = m?.[1]?.trim()
  return title || fileName.replace(/\.md$/i, '')
}
