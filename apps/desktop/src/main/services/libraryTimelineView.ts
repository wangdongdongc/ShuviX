/**
 * 文件时间线给界面的那一份（`library:timeline`）：库里的条目（services/fileLibrary.ts）加上它们所属会话的标题与
 * 项目名。单独一个文件：文件库服务被文件工具、预览协议等到处 import，不该因此带上会话行与项目表。
 *
 * 删掉的会话不在 `sessions` 里 —— 界面把它的文件放进当天的无会话组。
 */
import { isHiddenProjectId } from '@shuvix/chat-protocol/hiddenProjects'
import type { LibraryTimelineResult } from '@shuvix/chat-protocol/fileLibrary'
import { libraryTimeline } from './fileLibrary'
import { projectService } from './projectService'
import { sessionRecords } from './sessionRecords'

export function libraryTimelineView(): LibraryTimelineResult {
  const entries = libraryTimeline()
  const sessions: LibraryTimelineResult['sessions'] = {}
  for (const entry of entries) {
    const id = entry.sessionId
    if (!id || Object.hasOwn(sessions, id)) continue
    const row = sessionRecords.pick(id, ['title', 'projectId'])
    if (!row) continue
    const settings = sessionRecords.pickSettings(id, ['notebookPath', 'workProject'])
    // 项目名：会话所在的项目，Bot 会话取它引用的工作项目；承载注册表 / 知识库笔记的隐藏项目不算
    const projectId = row.projectId ?? settings?.workProject ?? null
    const project =
      projectId && !isHiddenProjectId(projectId) ? projectService.getById(projectId) : undefined
    sessions[id] = {
      title: row.title,
      ...(project ? { projectName: project.name } : {}),
      ...(settings?.notebookPath ? { notebook: true } : {})
    }
  }
  return { entries, sessions }
}
