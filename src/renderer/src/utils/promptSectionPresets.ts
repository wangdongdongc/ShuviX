import { v7 as uuidv7 } from 'uuid'
import type { TFunction } from 'i18next'
import type { ProjectPromptSection } from '../../../shared/types/promptSection'

/** 预置卡片的 i18n key 顺序 */
const PRESET_KEYS = ['identity', 'philosophy', 'toolUsage', 'safety'] as const

/**
 * 新建项目时的默认预置卡片(身份 / 任务处理哲学 / 工具使用规则 / 安全指引)
 *
 * 调用时根据当前 i18n 上下文实例化,标题和内容均可被用户后续编辑覆盖。
 */
export function getDefaultPromptSections(t: TFunction): ProjectPromptSection[] {
  return PRESET_KEYS.map((key) => ({
    id: uuidv7(),
    title: t(`projectForm.presets.${key}.title`),
    content: t(`projectForm.presets.${key}.content`)
  }))
}
