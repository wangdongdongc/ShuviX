/**
 * settingsStore —— 默认思考等级（`general.defaultThinkingLevel`）这一格。
 *
 * 它是设置页「默认模型」里那一行的值，也是应用启动时欢迎页思考选择器的初值（useAppInit 拿它
 * 去种 chatStore 的档位）。钉的是：
 *
 *   SS-1 还没 loadSettings 时就是 DEFAULT_THINKING_LEVEL（欢迎页在设置读回来之前也有一个合法档）；
 *   SS-2 loadSettings 把五个可选档原样读进来，含 off（用户选了「默认不思考」，不是「没配」）；
 *   SS-3 loadSettings 是整份重读：这次没有这个键 → 回到缺省，不粘着上一次读到的值；存的值不是
 *        可选档（max / minimal / 乱写）→ 同样回到缺省。
 *
 * node 环境：loadSettings 顺手把主题写进 localStorage，这里给一个内存替身。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THINKING_LEVEL,
  SELECTABLE_THINKING_LEVELS
} from '@shuvix/chat-protocol/types/thinking'
import { useSettingsStore } from '../settingsStore'

beforeAll(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, String(value)),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear()
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
})

const level = (): string => useSettingsStore.getState().defaultThinkingLevel

describe('settingsStore.defaultThinkingLevel', () => {
  // 必须排在第一个：之后的用例都会 loadSettings
  it('SS-1 还没 loadSettings：就是 DEFAULT_THINKING_LEVEL', () => {
    expect(useSettingsStore.getState().loaded).toBe(false)
    expect(level()).toBe(DEFAULT_THINKING_LEVEL)
    expect(useSettingsStore.getInitialState().defaultThinkingLevel).toBe(DEFAULT_THINKING_LEVEL)
  })

  it.each([...SELECTABLE_THINKING_LEVELS])('SS-2 存的是 %s → 原样读进来', (stored) => {
    useSettingsStore.getState().loadSettings({ 'general.defaultThinkingLevel': stored })
    expect(level()).toBe(stored)
  })

  it.each([
    ['这次没有这个键', undefined],
    ['max（设置页画不出）', 'max'],
    ['minimal（设置页画不出）', 'minimal'],
    ['乱写', 'garbage']
  ])('SS-3 先读到 xhigh，再读一份 %s → 回到 DEFAULT_THINKING_LEVEL', (_label, stored) => {
    useSettingsStore.getState().loadSettings({ 'general.defaultThinkingLevel': 'xhigh' })
    expect(level()).toBe('xhigh')
    useSettingsStore
      .getState()
      .loadSettings(stored === undefined ? {} : { 'general.defaultThinkingLevel': stored })
    expect(level()).toBe(DEFAULT_THINKING_LEVEL)
  })
})
