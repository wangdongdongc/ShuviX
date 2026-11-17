/**
 * 手机布局的文件 / 后台任务 / 产物 / 项目设置几页用的纯函数与常量（从各页组件里拆出来：组件文件只导出组件，
 * 这里的好单测）。
 */
import { isTaskFinished } from '@shuvix/chat-ui'
import { basename } from '@shuvix/app-shell'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'

/** 搜索结果最多画这么多行 */
export const FILE_SEARCH_LIMIT = 100

/** 文件大小：1023 B、1.5 KB、12 MB、3.4 GB（不到 10 带一位小数） */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  // 四舍五入之后够 1024 也进一位（1048575 字节是 1 MB，不是 1024 KB）
  while ((value >= 1024 || Math.round(value) >= 1024) && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`
}

/** 相对路径的最后一段（文件夹条目去掉尾斜杠） */
export const nameOf = (rel: string): string => basename(rel)
export const isHiddenName = (rel: string): boolean => nameOf(rel).startsWith('.')

/**
 * 在 `dir` 以下按路径找文件：不分大小写的子串；名字里命中的排在只在路径里命中的前面，各自保持给的顺序；
 * 最多 {@link FILE_SEARCH_LIMIT} 个。
 */
export function searchFiles(paths: readonly string[], dir: string, query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const prefix = dir ? `${dir}/` : ''
  const byName: string[] = []
  const byPath: string[] = []
  for (const path of paths) {
    if (prefix && !path.startsWith(prefix)) continue
    const rel = path.slice(prefix.length)
    if (nameOf(rel).toLowerCase().includes(q)) byName.push(path)
    else if (rel.toLowerCase().includes(q)) byPath.push(path)
  }
  return [...byName, ...byPath].slice(0, FILE_SEARCH_LIMIT)
}

/** 行首那个点说的是什么（`data-task-dot` 的值） */
export type TaskDotState = 'blocked' | 'agent' | 'resident' | 'error' | 'ended'

export function taskDotState(task: TaskInfo, blocked: boolean): TaskDotState {
  if (!isTaskFinished(task)) {
    if (blocked) return 'blocked'
    // 命令（含 ssh 远端的）是「常驻」那一种，智能体与子会话轮次是「智能体在跑」（同侧栏的两种运行）
    return task.kind === 'bash' ? 'resident' : 'agent'
  }
  return task.status === 'error' ? 'error' : 'ended'
}

/** 一件产物的身份（同名文件可以分属本会话与子会话）；与桌面面板那一行的 key 同形 */
export const artifactKey = (a: Pick<SessionArtifact, 'sessionId' | 'name'>): string =>
  `${a.sessionId}/${a.name}`

interface ArtifactGroup {
  sessionId: string
  subSessionTitle?: string
  items: SessionArtifact[]
}

/** 按会话分组，保持清单给的顺序（本会话在前） */
export function groupArtifacts(rows: readonly SessionArtifact[]): ArtifactGroup[] {
  const groups: ArtifactGroup[] = []
  for (const row of rows) {
    let group = groups.find((g) => g.sessionId === row.sessionId)
    if (!group) {
      group = { sessionId: row.sessionId, subSessionTitle: row.subSessionTitle, items: [] }
      groups.push(group)
    }
    group.items.push(row)
  }
  return groups
}

export type MobileProjectPage = 'index' | 'prompt' | 'extensions' | 'knowledge'

export const PROJECT_PAGES: readonly MobileProjectPage[] = [
  'index',
  'prompt',
  'extensions',
  'knowledge'
]
