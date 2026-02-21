/**
 * 主进程 i18n 初始化
 * 使用 i18next（纯 Node.js，不依赖 React）
 * 翻译文件与渲染进程共享
 */

import i18next from 'i18next'
import { app } from 'electron'
import zh from '../shared/i18n/locales/zh.json'
import en from '../shared/i18n/locales/en.json'
import ja from '../shared/i18n/locales/ja.json'

/** 支持的语言列表 */
export const SUPPORTED_LANGUAGES = ['zh', 'en', 'ja'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** 将系统 locale 映射到支持的语言（如 zh-CN → zh、en-US → en） */
function resolveLocale(locale: string): SupportedLanguage {
  const lang = locale.split('-')[0].toLowerCase()
  if (SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
    return lang as SupportedLanguage
  }
  return 'en'
}

/** 初始化 i18next（在 app ready 后调用） */
export function initI18n(savedLanguage?: string): void {
  const lng = savedLanguage || resolveLocale(app.getLocale())

  i18next.init({
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: {
      zh: { translation: zh },
      en: { translation: en },
      ja: { translation: ja }
    }
  })
}

/** 切换语言（设置面板切换时调用） */
export function changeLanguage(lang: string): void {
  i18next.changeLanguage(lang)
}

/** 翻译函数（后端模块直接使用） */
export const t = i18next.t.bind(i18next)
