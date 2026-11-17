/**
 * 对话页上面推入的「文件 / 后台任务 / 产物」那几页在浏览器历史里的记号（2026-11-16：这三样从底部抽屉改成整屏页面）。
 *
 * 记的是一摞页面（从对话页往上数）：`['files']`、`['files', 'files:src', 'files:src/main']`、
 * `['tasks', 'task:<taskId>']`、`['artifacts', 'artifact:<会话 id>/<文件名>']` —— 每往里进一层压一条历史，
 * 带着更长的那一摞；返回键 / 返回手势退一条就是退一页。这几条历史照样带着对话页（与会话页第二层）的记号。
 * 与「详情」那一层（detailHistory.ts）互斥：两者都是从对话页推入的。
 */

export const PANEL_HISTORY_MARK = 'shuvixMobilePanel'

/** 这三样各自的首页 */
export type MobilePanelKind = 'files' | 'tasks' | 'artifacts'

const KINDS: readonly MobilePanelKind[] = ['files', 'tasks', 'artifacts']
/** 各自首页上面那几层的前缀（前缀后面必须有东西） */
const DEEPER: Record<MobilePanelKind, string> = {
  files: 'files:',
  tasks: 'task:',
  artifacts: 'artifact:'
}

/** 一条历史条目的 state 说的那一摞页面；不是这几页的条目（或记号坏了）→ 空 */
export function panelStackOf(state: unknown): string[] {
  const value = (state as Record<string, unknown> | null)?.[PANEL_HISTORY_MARK]
  if (!Array.isArray(value) || value.length === 0) return []
  const kind = value[0] as MobilePanelKind
  if (!KINDS.includes(kind)) return []
  // 首页上面只能是同一样东西的更深一层（文件夹一层一层；任务 / 产物只有一层详情）
  const prefix = DEEPER[kind]
  const deeper = value.slice(1)
  if (kind !== 'files' && deeper.length > 1) return []
  const ok = deeper.every(
    (page) => typeof page === 'string' && page.startsWith(prefix) && page.length > prefix.length
  )
  return ok ? (value as string[]) : []
}

/** 这一条在对话页那一条上面第几层（关对话页时要一起退掉） */
export function panelDepthOf(state: unknown): number {
  return panelStackOf(state).length
}

/** 文件页的某一层：工作目录里的相对路径（'' = 工作目录本身）；不是文件页 → null */
export function filesDirOf(page: string): string | null {
  if (page === 'files') return ''
  return page.startsWith('files:') ? page.slice('files:'.length) : null
}

export const filesPage = (dir: string): string => (dir ? `files:${dir}` : 'files')
export const taskPage = (taskId: string): string => `task:${taskId}`
export const artifactPage = (sessionId: string, name: string): string =>
  `artifact:${sessionId}/${name}`

/** 任务详情页是哪一条任务；不是任务详情 → null */
export function taskIdOf(page: string): string | null {
  return page.startsWith('task:') ? page.slice('task:'.length) : null
}

/** 产物详情页是哪一件（`<会话 id>/<文件名>`，与面板里那一行的 key 同形）；不是产物详情 → null */
export function artifactKeyOf(page: string): string | null {
  return page.startsWith('artifact:') ? page.slice('artifact:'.length) : null
}
