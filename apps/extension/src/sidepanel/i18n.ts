/**
 * 侧边栏 i18n（locales 来自 chat-protocol，与桌面同一份）。必须在任何 React 组件挂载前 import：
 * chat-ui 依赖默认 i18next 单例已 initReactI18next。语言先按浏览器，拿到桌面设置后跟着桌面。
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'

const SUPPORTED = ['zh', 'en', 'ja'] as const

export function resolveLocale(locale: string | undefined): string {
  const lang = (locale ?? '').split('-')[0].toLowerCase()
  return (SUPPORTED as readonly string[]).includes(lang) ? lang : 'en'
}

void i18next.use(initReactI18next).init({
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
