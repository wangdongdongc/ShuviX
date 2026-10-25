/**
 * 会话面板「产物」页的清单（`artifact:list`）—— 一场会话自己的产物，加上它直接子会话的（目录跟着
 * 产出它的会话走，`work` 把具体活交给子会话，子会话画的图父会话的面板里得看得见；嵌套只有一层，
 * 与 `artifact:read` 往下找一层同一个口径）。
 *
 * 每件带版本数与最近一版的时刻（history 读 git 历史）；还没进过历史的（升级前写下、之后没再被工具
 * 碰过）算一版，时刻取文件的修改时间；只有基线那一版的，时刻同样取修改时间。
 */
import { statSync } from 'node:fs'
import type { SessionArtifact } from '@shuvix/chat-protocol/artifacts'
import { listArtifacts } from './store'
import { artifactVersionStats } from './history'

/** 要列的一场会话；子会话带上标题（面板按它分组） */
export interface ArtifactListSource {
  sessionId: string
  subSessionTitle?: string
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** 按给定的会话顺序列出；同一会话内最近改过的在前 */
export async function listSessionArtifacts(
  sources: readonly ArtifactListSource[]
): Promise<SessionArtifact[]> {
  const out: SessionArtifact[] = []
  for (const source of sources) {
    const owned = listArtifacts(source.sessionId)
    if (owned.length === 0) continue
    const stats = await artifactVersionStats(source.sessionId)
    const rows = owned.map((a): SessionArtifact => {
      const stat = stats.get(a.name)
      return {
        sessionId: source.sessionId,
        ...(source.subSessionTitle !== undefined
          ? { subSessionTitle: source.subSessionTitle }
          : {}),
        name: a.name,
        title: a.title,
        path: a.path,
        versions: stat?.versions ?? 1,
        // 没进过历史，或只有基线那一版（时间 0）：取文件的修改时间
        updatedAt: stat?.updatedAt || mtimeOf(a.path)
      }
    })
    rows.sort((x, y) => y.updatedAt - x.updatedAt || x.name.localeCompare(y.name))
    out.push(...rows)
  }
  return out
}
