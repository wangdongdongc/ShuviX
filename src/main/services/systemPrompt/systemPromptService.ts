import { settingsDao } from '../../dao/settingsDao'
import type { ProjectPromptSection } from '../../../shared/types/promptSection'
import { parsePromptSections, encodePromptSections } from '../../../shared/utils/promptSectionCodec'
import {
  BUILTIN_SECTION_ORDER,
  isBuiltinSectionId,
  getBuiltinTitle,
  getBuiltinContent,
  type BuiltinSectionId,
  type BuiltinRenderCtx
} from './builtinSections'

const KEY_BUILTIN_DISABLED = 'systemPromptBuiltinDisabled'
const KEY_CUSTOM_SECTIONS = 'systemPromptCustomSections'

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

/**
 * 列出全部内置卡片（按代码顺序），用于设置面板渲染
 * - title 取当前 i18n
 * - content：动态卡片返回 null（由前端按需调预览接口），静态卡片返回 i18n 文案
 */
export interface BuiltinSectionViewItem {
  id: BuiltinSectionId
  title: string
  /** 动态卡片为 null */
  content: string | null
  disabled: boolean
  dynamic: boolean
}

export function listBuiltinSections(): BuiltinSectionViewItem[] {
  const disabled = getBuiltinDisabled()
  return BUILTIN_SECTION_ORDER.map((id) => {
    const dynamic = id === 'environment'
    return {
      id,
      title: getBuiltinTitle(id),
      content: dynamic ? null : getBuiltinContent(id, {}),
      disabled: disabled.has(id),
      dynamic
    }
  })
}

/** 预览某张内置卡片的实际内容（前端用，主要用于 environment 卡片） */
export function previewBuiltinSection(id: BuiltinSectionId, ctx: BuiltinRenderCtx): string {
  if (!isBuiltinSectionId(id)) return ''
  return getBuiltinContent(id, ctx)
}

/**
 * 装配最终的系统级提示词文本：
 *   内置卡片（按代码顺序，跳过 disabled） + 自定义卡片（按数组顺序）
 *
 * 段间用空行分隔。空段（content trim 后为空）整体跳过。
 */
export function renderForPrompt(ctx: BuiltinRenderCtx): string {
  const disabled = getBuiltinDisabled()
  const blocks: string[] = []

  for (const id of BUILTIN_SECTION_ORDER) {
    if (disabled.has(id)) continue
    const title = getBuiltinTitle(id).trim()
    const content = getBuiltinContent(id, ctx).trim()
    if (!title && !content) continue
    if (title) blocks.push(`## ${title}\n${content}`)
    else blocks.push(content)
  }

  for (const sec of getCustomSections()) {
    const title = sec.title.trim()
    const content = sec.content.trim()
    if (!title && !content) continue
    if (title) blocks.push(`## ${title}\n${content}`)
    else blocks.push(content)
  }

  return blocks.join('\n\n')
}
