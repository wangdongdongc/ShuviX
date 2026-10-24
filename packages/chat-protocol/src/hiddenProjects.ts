import { isDailyProjectId } from './dailyNotes'
import { isKnowledgeProjectId } from './knowledge'
import { isRegistryNoteProjectId } from './registryNotes'
import { isSkillProjectId } from './skillNotes'
import { isTrackingProjectId } from './trackingNotes'

/**
 * 隐藏项目：只承载笔记本会话，不进项目列表、不进日历 —— 知识库的三个承载项目（项目库 / 用户库 /
 * 内置库）、五个注册表目录（见 registryNotes）、技能的承载项目（默认目录 / 内置目录 / 每个
 * 外部目录一个，见 skillNotes）、日报目录（见 dailyNotes —— 日报以「那一天的日报」出现在日历上，
 * 不以会话出现）、以及跟踪项目录（见 trackingNotes，实验 —— 在侧栏 Library 的「跟踪项」分组里出现）。宿主的项目列表过滤与 UI 的日历圆点共用这一份判定，
 * 新增载体只改这里。
 */
export function isHiddenProjectId(id: string | null | undefined): boolean {
  return (
    isKnowledgeProjectId(id) ||
    isRegistryNoteProjectId(id) ||
    isSkillProjectId(id) ||
    isDailyProjectId(id) ||
    isTrackingProjectId(id)
  )
}
