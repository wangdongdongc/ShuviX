/**
 * 系统提示词卡片的装配 + 设置面板视图（跨端共享纯逻辑）。
 *
 * KV 读写（禁用集、自定义段）留各端：桌面 settingsDao（同步）/ 扩展 chrome.storage（异步）。
 * 这里只接收已加载好的数据，保证桌面同步、扩展异步两种调用方式都能复用同一装配语义。
 */
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'
import {
  BUILTIN_SECTION_ORDER,
  getBuiltinTitle,
  getStaticBuiltinContent,
  isBuiltinSectionId,
  isDynamicBuiltin,
  type BuiltinRenderCtx,
  type BuiltinSectionId
} from './builtinSections'

/** 装配/视图所需的注入依赖（各端提供 i18n 与 environment 渲染器） */
export interface SystemPromptDeps {
  /** i18n 解析（桌面/扩展各自的 i18next） */
  t: (key: string) => string
  /** environment 动态卡片内容生成器（桌面 Node / 扩展浏览器） */
  renderEnvironment: (ctx: BuiltinRenderCtx) => string
}

/** 设置面板渲染用的内置卡片视图项 */
export interface BuiltinSectionViewItem {
  id: BuiltinSectionId
  title: string
  /** 动态卡片为 null（前端按需调 previewBuiltinSection） */
  content: string | null
  disabled: boolean
  dynamic: boolean
}

/** 列出全部内置卡片（按代码顺序），供设置面板渲染勾选列表 */
export function listBuiltinSections(
  disabled: ReadonlySet<BuiltinSectionId>,
  deps: SystemPromptDeps
): BuiltinSectionViewItem[] {
  return BUILTIN_SECTION_ORDER.map((id) => {
    const dynamic = isDynamicBuiltin(id)
    return {
      id,
      title: getBuiltinTitle(id, deps.t),
      content: dynamic ? null : getStaticBuiltinContent(id, deps.t),
      disabled: disabled.has(id),
      dynamic
    }
  })
}

/** 预览某张内置卡片的实际内容（主要用于 environment 动态卡片） */
export function previewBuiltinSection(
  id: string,
  deps: SystemPromptDeps,
  ctx: BuiltinRenderCtx = {}
): string {
  if (!isBuiltinSectionId(id)) return ''
  return isDynamicBuiltin(id) ? deps.renderEnvironment(ctx) : getStaticBuiltinContent(id, deps.t)
}

/**
 * 装配最终的系统级提示词文本：
 *   内置卡片（按代码顺序，跳过 disabled） + 自定义卡片（按数组顺序）
 * 段间空行分隔；空段（title/content trim 后皆空）整体跳过。
 */
export function renderSystemPromptSections(opts: {
  disabled: ReadonlySet<BuiltinSectionId>
  customSections: ProjectPromptSection[]
  deps: SystemPromptDeps
  ctx?: BuiltinRenderCtx
}): string {
  const { disabled, customSections, deps, ctx = {} } = opts
  const blocks: string[] = []

  for (const id of BUILTIN_SECTION_ORDER) {
    if (disabled.has(id)) continue
    const title = getBuiltinTitle(id, deps.t).trim()
    const content = (
      isDynamicBuiltin(id) ? deps.renderEnvironment(ctx) : getStaticBuiltinContent(id, deps.t)
    ).trim()
    if (!title && !content) continue
    blocks.push(title ? `## ${title}\n${content}` : content)
  }

  for (const sec of customSections) {
    const title = sec.title.trim()
    const content = sec.content.trim()
    if (!title && !content) continue
    blocks.push(title ? `## ${title}\n${content}` : content)
  }

  return blocks.join('\n\n')
}
