/**
 * 扩展 Side Panel i18n 初始化（复制桌面 renderer/src/i18n.ts；locales 来自 chat-protocol）。
 * 必须在任何 React 组件挂载前 import（chat-ui 依赖默认 i18next 单例已 initReactI18next）。
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import { SYSTEM_PROMPT_OVERRIDES } from './systemPromptOverrides'

export const SUPPORTED_LANGUAGES = ['zh', 'en', 'ja'] as const

function resolveLocale(locale: string): string {
  const lang = locale.split('-')[0].toLowerCase()
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) return lang
  return 'en'
}

/**
 * 在共享 locales 之上叠加内置系统提示词卡片的扩展专属文案（仅覆写
 * identity / using_tools / executing_actions 的 content，title 仍用共享）。
 */
function withSystemPromptOverrides(
  base: Record<string, unknown>,
  lang: 'zh' | 'en' | 'ja'
): Record<string, unknown> {
  const ov = SYSTEM_PROMPT_OVERRIDES[lang]
  const spc = (base.systemPromptCards ?? {}) as Record<string, Record<string, unknown>>
  return {
    ...base,
    systemPromptCards: {
      ...spc,
      identity: { ...spc.identity, content: ov.identity },
      using_tools: { ...spc.using_tools, content: ov.using_tools },
      executing_actions: { ...spc.executing_actions, content: ov.executing_actions }
    }
  }
}

i18next.use(initReactI18next).init({
  lng: resolveLocale(navigator.language),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  resources: {
    zh: { translation: withSystemPromptOverrides(zh, 'zh') },
    en: { translation: withSystemPromptOverrides(en, 'en') },
    ja: { translation: withSystemPromptOverrides(ja, 'ja') }
  }
})

export default i18next
