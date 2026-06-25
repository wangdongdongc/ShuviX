import i18next from 'i18next'
import { settingsDao } from '../../dao/settingsDao'
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'
import {
  parsePromptSections,
  encodePromptSections
} from '@shuvix/chat-protocol/utils/promptSectionCodec'
import {
  listBuiltinSections as sharedListBuiltinSections,
  previewBuiltinSection as sharedPreviewBuiltinSection,
  renderSystemPromptSections,
  isBuiltinSectionId,
  type BuiltinRenderCtx,
  type BuiltinSectionId,
  type BuiltinSectionViewItem,
  type SystemPromptDeps
} from '@shuvix/agent-runtime'
import { computeEnvironment } from './builtinSections'

const KEY_BUILTIN_DISABLED = 'systemPromptBuiltinDisabled'
const KEY_CUSTOM_SECTIONS = 'systemPromptCustomSections'

/** 注入共享核心的桌面依赖：i18n 用默认 i18next 实例，environment 用 Node 计算 */
const deps: SystemPromptDeps = {
  t: (key) => i18next.t(key),
  renderEnvironment: computeEnvironment
}

/** 读取被禁用的内置卡片 id 集合（过滤掉过期 id） */
export function getBuiltinDisabled(): Set<BuiltinSectionId> {
  const raw = settingsDao.findByKey(KEY_BUILTIN_DISABLED)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    const ids = parsed.filter(
      (v): v is BuiltinSectionId => typeof v === 'string' && isBuiltinSectionId(v)
    )
    return new Set(ids)
  } catch {
    return new Set()
  }
}

/** 写入被禁用的内置卡片 id 列表（去重 + 过滤过期 id） */
export function setBuiltinDisabled(ids: BuiltinSectionId[]): void {
  const filtered = Array.from(new Set(ids)).filter(isBuiltinSectionId)
  settingsDao.upsert(KEY_BUILTIN_DISABLED, JSON.stringify(filtered))
}

/** 读取用户自定义系统提示词卡片 */
export function getCustomSections(): ProjectPromptSection[] {
  return parsePromptSections(settingsDao.findByKey(KEY_CUSTOM_SECTIONS))
}

/** 写入用户自定义系统提示词卡片 */
export function setCustomSections(sections: ProjectPromptSection[]): void {
  settingsDao.upsert(KEY_CUSTOM_SECTIONS, encodePromptSections(sections))
}

export type { BuiltinSectionViewItem }

/** 列出全部内置卡片（按代码顺序），用于设置面板渲染 */
export function listBuiltinSections(): BuiltinSectionViewItem[] {
  return sharedListBuiltinSections(getBuiltinDisabled(), deps)
}

/** 预览某张内置卡片的实际内容（前端用，主要用于 environment 卡片） */
export function previewBuiltinSection(id: BuiltinSectionId, ctx: BuiltinRenderCtx): string {
  return sharedPreviewBuiltinSection(id, deps, ctx)
}

/**
 * 装配最终的系统级提示词文本：
 *   内置卡片（按代码顺序，跳过 disabled） + 自定义卡片（按数组顺序）
 */
export function renderForPrompt(ctx: BuiltinRenderCtx): string {
  return renderSystemPromptSections({
    disabled: getBuiltinDisabled(),
    customSections: getCustomSections(),
    deps,
    ctx
  })
}
