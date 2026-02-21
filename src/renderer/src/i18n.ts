/**
 * 渲染进程 i18n 初始化
 * 使用 i18next + react-i18next
 * 翻译文件与主进程共享
 */

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '../../shared/i18n/locales/zh.json'
import en from '../../shared/i18n/locales/en.json'
import ja from '../../shared/i18n/locales/ja.json'

/** 支持的语言列表 */
export const SUPPORTED_LANGUAGES = ['zh', 'en', 'ja'] as const

/** 将浏览器 locale 映射到支持的语言 */
function resolveLocale(locale: string): string {
  const lang = locale.split('-')[0].toLowerCase()
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) return lang
  return 'en'
}

/** 检测初始语言：优先用户设置，其次系统语言 */
const detectedLang = resolveLocale(navigator.language)

i18next
  .use(initReactI18next)
  .init({
    lng: detectedLang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    resources: {
      zh: { translation: zh },
      en: { translation: en },
      ja: { translation: ja }
    }
  })

export default i18next
