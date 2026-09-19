import { isKnowledgeProjectId } from './knowledge'
import { isRegistryNoteProjectId } from './registryNotes'
import { isSkillProjectId } from './skillNotes'

/**
 * 隐藏项目：只承载笔记本会话，不进项目列表、不进日历 —— 知识库的三个承载项目（项目库 / 用户库 /
 * 内置库）、五个注册表目录（见 registryNotes）、以及技能的承载项目（默认目录 / 内置目录 / 每个
 * 外部目录一个，见 skillNotes）。宿主的项目列表过滤与 UI 的日历圆点共用这一份判定，
 * 新增载体只改这里。
 */
export function isHiddenProjectId(id: string | null | undefined): boolean {
  return isKnowledgeProjectId(id) || isRegistryNoteProjectId(id) || isSkillProjectId(id)
}
