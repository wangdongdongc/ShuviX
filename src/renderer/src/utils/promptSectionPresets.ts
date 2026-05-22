import type { TFunction } from 'i18next'
import type { ProjectPromptSection } from '../../../shared/types/promptSection'

/**
 * 新建项目时的默认提示词卡片。
 *
 * 项目级提示词卡片现在用于补充"项目特有"的指令；身份 / 任务哲学 / 工具使用 / 安全
 * 等通用规范已迁移到系统级内置卡片（SystemPromptSettings），所以这里返回空数组。
 *
 * 保留函数签名是为了未来若引入"项目特有的预设"时不需要改 ProjectCreateDialog
 * 的调用点。
 */
export function getDefaultPromptSections(_t: TFunction): ProjectPromptSection[] {
  return []
}
