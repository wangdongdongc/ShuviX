/**
 * 扩展系统提示词存储 —— 对应桌面 systemPromptService 的浏览器实现。
 *
 * 复用 @shuvix/agent-runtime 的内置卡片定义 + 装配逻辑（内容走共享 i18n，与桌面一致）；
 * KV 落 chrome.storage（经 settingsStore.get/set），environment 动态卡片用浏览器上下文渲染。
 */
import i18next from 'i18next'
import {
  listBuiltinSections as sharedListBuiltinSections,
  previewBuiltinSection as sharedPreviewBuiltinSection,
  renderSystemPromptSections,
  isBuiltinSectionId,
  formatLanguageDisplay,
  type BuiltinRenderCtx,
  type BuiltinSectionId,
  type BuiltinSectionViewItem,
  type SystemPromptDeps
} from '@shuvix/agent-runtime'
import {
  parsePromptSections,
  encodePromptSections
} from '@shuvix/chat-protocol/utils/promptSectionCodec'
import type { ProjectPromptSection } from '@shuvix/chat-protocol/types/promptSection'
import { settingsStore } from './settingsStore'

const KEY_BUILTIN_DISABLED = 'systemPromptBuiltinDisabled'
const KEY_CUSTOM_SECTIONS = 'systemPromptCustomSections'
const KEY_GLOBAL_PROMPT = 'general.systemPrompt'
const KEY_ENABLED = 'general.systemPromptEnabled'

/** environment 动态卡片（浏览器版）—— 复用共享 i18n 标签，去掉 shell/OS-cwd 等桌面字段 */
function renderBrowserEnvironment(): string {
  const t = (k: string): string => i18next.t(k)
  const currentDate = new Date().toISOString().slice(0, 10)
  const appVersion = (() => {
    try {
      return chrome.runtime.getManifest().version
    } catch {
      return 'unknown'
    }
  })()
  const items = [
    `${t('systemPromptCards.environment.platform')}: Chrome Extension`,
    `${t('systemPromptCards.environment.date')}: ${currentDate}`,
    `${t('systemPromptCards.environment.language')}: ${formatLanguageDisplay(i18next.language)}`,
    `${t('systemPromptCards.environment.appVersion')}: ShuviX ${appVersion}`
  ]
  return items.map((line) => `- ${line}`).join('\n')
}

const deps: SystemPromptDeps = {
  t: (key) => i18next.t(key),
  renderEnvironment: renderBrowserEnvironment
}

/** 读取被禁用的内置卡片 id 集合（过滤过期 id） */
async function getBuiltinDisabled(): Promise<Set<BuiltinSectionId>> {
  const raw = await settingsStore.get(KEY_BUILTIN_DISABLED)
  if (!raw) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed.filter((v): v is BuiltinSectionId => typeof v === 'string' && isBuiltinSectionId(v))
    )
  } catch {
    return new Set()
  }
}

async function getCustomSections(): Promise<ProjectPromptSection[]> {
  return parsePromptSections(await settingsStore.get(KEY_CUSTOM_SECTIONS))
}

export const systemPromptStore = {
  /** 列出全部内置卡片（设置面板渲染） */
  async listBuiltinSections(): Promise<BuiltinSectionViewItem[]> {
    return sharedListBuiltinSections(await getBuiltinDisabled(), deps)
  },

  /** 预览内置卡片内容（主要用于 environment 动态卡片） */
  previewBuiltinSection(id: string): string {
    return sharedPreviewBuiltinSection(id, deps)
  },

  /** 写入被禁用的内置卡片 id 列表（去重 + 过滤过期 id） */
  async setBuiltinDisabled(ids: string[]): Promise<void> {
    const filtered = Array.from(new Set(ids)).filter(isBuiltinSectionId)
    await settingsStore.set(KEY_BUILTIN_DISABLED, JSON.stringify(filtered))
  },

  /** 读取用户自定义系统提示词卡片 */
  getCustomSections(): Promise<ProjectPromptSection[]> {
    return getCustomSections()
  },

  /** 写入用户自定义系统提示词卡片 */
  async setCustomSections(sections: ProjectPromptSection[]): Promise<void> {
    await settingsStore.set(KEY_CUSTOM_SECTIONS, encodePromptSections(sections))
  },

  /**
   * 装配用户可配置的「人设」段（全局自由文本 + 内置/自定义卡片）。
   * 总开关关闭时返回空串（与桌面一致）；调用方再追加平台操作上下文（浏览器/工作目录指令）。
   */
  async renderPersona(ctx: BuiltinRenderCtx): Promise<string> {
    const enabled = (await settingsStore.get(KEY_ENABLED)) !== 'false'
    if (!enabled) return ''
    const segments: string[] = []
    const global = ((await settingsStore.get(KEY_GLOBAL_PROMPT)) || '').trim()
    if (global) segments.push(global)
    const cards = renderSystemPromptSections({
      disabled: await getBuiltinDisabled(),
      customSections: await getCustomSections(),
      deps,
      ctx
    })
    if (cards) segments.push(cards)
    return segments.join('\n\n')
  }
}
