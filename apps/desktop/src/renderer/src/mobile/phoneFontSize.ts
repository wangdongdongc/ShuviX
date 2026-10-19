/**
 * 手机布局的字号 —— **记在这台设备上**（这个浏览器的 localStorage），不是设置表里的 `general.fontSize`：
 * 那一项是桌面窗口的，手机上改它会连桌面一起改，桌面的字号放到手机上又偏小（手机原生应用的正文是 16–17）。
 *
 * 手机布局把它写到 `[data-mobile-shell]` 的 `--app-font-size` 上（对话正文、用户气泡、代码块都按它排），
 * 再经 main.css 里 `[data-mobile-scale]` 那组规则把桌面组件写死的小字号（9–14px）按同一个比例放大 ——
 * 于是步骤行、工具卡片、徽标跟着正文一起变大。侧栏（会话 / 资料库）的行不靠它：那是 .sb-row 的 touch 档。
 *
 * localStorage 读写都包 try：隐私窗口 / 被禁用时退到内存里的一份，这一页照样生效，只是不记住。
 */
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'shuvix.mobile.fontSize'

export const PHONE_FONT_SIZE_DEFAULT = 16
export const PHONE_FONT_SIZE_MIN = 13
export const PHONE_FONT_SIZE_MAX = 20

const listeners = new Set<() => void>()
/** localStorage 用不了时（隐私窗口 / 被禁用）退到内存：这一页里照样生效，只是不记住 */
let memory = PHONE_FONT_SIZE_DEFAULT

function clamp(value: number): number {
  return Math.min(PHONE_FONT_SIZE_MAX, Math.max(PHONE_FONT_SIZE_MIN, Math.round(value)))
}

export function readPhoneFontSize(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const value = raw == null ? NaN : Number(raw)
    return Number.isFinite(value) ? clamp(value) : memory
  } catch {
    return memory
  }
}

export function setPhoneFontSize(size: number): void {
  memory = clamp(size)
  try {
    window.localStorage.setItem(STORAGE_KEY, String(memory))
  } catch {
    // 存不下：内存里那份照样生效，只是不记住
  }
  for (const listener of listeners) listener()
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // 同一台设备开了两个标签页：另一页改了字号，这一页跟着变
  const onStorage = (e: StorageEvent): void => {
    if (e.key === STORAGE_KEY) onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function usePhoneFontSize(): number {
  return useSyncExternalStore(subscribe, readPhoneFontSize, () => PHONE_FONT_SIZE_DEFAULT)
}
