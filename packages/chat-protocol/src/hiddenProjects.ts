import { WIKI_PROJECT_ID } from './wiki'
import { isKnowledgeProjectId } from './knowledge'
import { isRegistryNoteProjectId } from './registryNotes'

/**
 * 隐藏项目：只承载笔记本会话，不进项目列表、不进日历 —— 旧 wiki、知识库 v2 的两个承载项目（项目库 / 用户库）与四个注册表目录
 * （见 registryNotes）。宿主的项目列表过滤与 UI 的日历圆点共用这一份判定，新增载体只改这里。
 */
export function isHiddenProjectId(id: string | null | undefined): boolean {
  return id === WIKI_PROJECT_ID || isKnowledgeProjectId(id) || isRegistryNoteProjectId(id)
}
