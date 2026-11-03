/**
 * 渲染进程 i18n 初始化
 * 使用 i18next + react-i18next
 * 翻译文件与主进程共享
 */

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'

/** 支持的语言列表 */
export const SUPPORTED_LANGUAGES = ['zh', 'en', 'ja'] as const

/**
 * 初始语言：上次记下的那份（loadSettings 写），没有就是英文（不看系统语言）。设置要等 IPC 回来，而 md、
 * 文件预览等窗口在首帧就显示：这里要是写死英文，选了别的语言的用户每开一扇窗都会先闪一下英文。
 */
function lastKnownLanguage(): string {
  try {
    const saved = localStorage.getItem('language')
    if (saved && (SUPPORTED_LANGUAGES as readonly string[]).includes(saved)) return saved
  } catch {
    // 拿不到 localStorage（站点数据被禁用、非浏览器环境）：等设置读回来
  }
  return 'en'
}

i18next.use(initReactI18next).init({
  lng: lastKnownLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  resources: {
    zh: { translation: zh },
    en: { translation: en },
    ja: { translation: ja }
  }
})

export default i18next
