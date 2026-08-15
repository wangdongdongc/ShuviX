/**
 * 扩展 Side Panel i18n 初始化（复制桌面 renderer/src/i18n.ts；locales 来自 chat-protocol）。
 * 必须在任何 React 组件挂载前 import（chat-ui 依赖默认 i18next 单例已 initReactI18next）。
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'

export const SUPPORTED_LANGUAGES = ['zh', 'en', 'ja'] as const

function resolveLocale(locale: string): string {
  const lang = locale.split('-')[0].toLowerCase()
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) return lang
  return 'en'
}

// 注：扩展的 default 浏览器变体不再经 i18n 资源覆盖 —— 内置档案文案已改为 md 文件维护，
// 扩展的整份副本在 runtime/builtinAgents/md/ 下，由 subAgent.ts 的 EXTENSION_DEFAULT_SPEC 取用。

i18next.use(initReactI18next).init({
  lng: resolveLocale(navigator.language),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  resources: {
    zh: { translation: zh },
    en: { translation: en },
    ja: { translation: ja }
  }
})

export default i18next
