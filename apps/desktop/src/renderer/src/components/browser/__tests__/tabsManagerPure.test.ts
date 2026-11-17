// @vitest-environment jsdom
/**
 * 浏览器管理「标签页」那一节里不画东西的判断（components/browser/tabsManagerPure.ts）—— 桌面浏览器里的管理页与手机
 * 布局的浏览器页共用。
 *
 * 契约：
 * - `reasonOf`：失败的那句话；`remote_url_refused` 换成传进来的本地化说法；
 * - `usedByAgent`：行上记着会话，或接着 CDP；
 * - `needsConfirm`：agent 用着才问；崩了的页刷新、换地址不问，关闭照问；
 * - `sessionNameOf`：标题，空的写 id；
 * - `GUARD_COPY`：三个动作的文案键都在 en 里；
 * - `screenshotWidth` = min(1280, round(720 × max(1, dpr)))。
 *
 *   TP-1..3  reasonOf
 *   TP-4..7  usedByAgent / needsConfirm
 *   TP-8     sessionNameOf
 *   TP-9     GUARD_COPY
 *   TP-10    screenshotWidth
 *
 * （TP-11：browserTabsManager.dom.test.ts 原样通过 —— 只是引用路径搬了，没有新用例。）
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import i18n from 'i18next'
import { REMOTE_URL_REFUSED_CODE } from '../../../../../shared/browserRemoteUrls'
import {
  GUARD_COPY,
  needsConfirm,
  reasonOf,
  screenshotWidth,
  sessionNameOf,
  usedByAgent,
  type GuardedAction,
  type TabRow
} from '../tabsManagerPure'
import { initEnI18n } from './browserDomSupport'

const row = (over: Partial<TabRow> = {}): TabRow =>
  ({
    id: 'a',
    url: 'https://example.com/',
    title: '',
    active: false,
    cdpAttached: false,
    cdpIntercepting: false,
    crashed: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    agentDevtoolsCalls: 0,
    ...over
  }) as TabRow

const ACTIONS: GuardedAction[] = ['reload', 'close', 'navigate']

describe('reasonOf', () => {
  it('TP-1 Error → 它的 message；字符串 / 对象 → String(...)', () => {
    expect(reasonOf(new Error('denied by rule X'), 'REFUSED')).toBe('denied by rule X')
    expect(reasonOf('boom', 'REFUSED')).toBe('boom')
    expect(reasonOf({ a: 1 }, 'REFUSED')).toBe('[object Object]')
  })

  it('TP-2 code 是 remote_url_refused → 传进来的那句（不看 message）', () => {
    const error = Object.assign(new Error('raw server text'), { code: REMOTE_URL_REFUSED_CODE })
    expect(reasonOf(error, 'REFUSED')).toBe('REFUSED')
    expect(reasonOf({ code: REMOTE_URL_REFUSED_CODE }, 'REFUSED')).toBe('REFUSED')
  })

  it('TP-3 null / undefined 不抛', () => {
    expect(reasonOf(null, 'REFUSED')).toBe('null')
    expect(reasonOf(undefined, 'REFUSED')).toBe('undefined')
  })
})

describe('usedByAgent / needsConfirm', () => {
  it('TP-4 记着会话 → 是；只接着 CDP → 是；都没有 → 否', () => {
    expect(usedByAgent(row({ agentSessionId: 's1' }))).toBe(true)
    expect(usedByAgent(row({ cdpAttached: true }))).toBe(true)
    expect(usedByAgent(row())).toBe(false)
  })

  it('TP-5 没有 agent 用着 → 三个动作都不问（崩了也一样）', () => {
    for (const action of ACTIONS) {
      expect(needsConfirm(row(), action)).toBe(false)
      expect(needsConfirm(row({ crashed: true }), action)).toBe(false)
    }
  })

  it('TP-6 agent 用着、没崩 → 三个动作都问', () => {
    for (const tab of [row({ agentSessionId: 's1' }), row({ cdpAttached: true })]) {
      for (const action of ACTIONS) {
        expect(needsConfirm(tab, action)).toBe(true)
      }
    }
  })

  it('TP-7 agent 用着、崩了 → 关闭问，刷新与换地址不问', () => {
    const tab = row({ agentSessionId: 's1', cdpAttached: true, crashed: true })
    expect(needsConfirm(tab, 'close')).toBe(true)
    expect(needsConfirm(tab, 'reload')).toBe(false)
    expect(needsConfirm(tab, 'navigate')).toBe(false)
  })
})

describe('sessionNameOf', () => {
  it('TP-8 标题；空 / 全是空白 → id；都没有 → undefined', () => {
    expect(sessionNameOf(row({ agentSessionId: 's1', agentSessionTitle: 'Fix' }))).toBe('Fix')
    expect(sessionNameOf(row({ agentSessionId: 's1', agentSessionTitle: '  Fix  ' }))).toBe('Fix')
    expect(sessionNameOf(row({ agentSessionId: 's1', agentSessionTitle: '' }))).toBe('s1')
    expect(sessionNameOf(row({ agentSessionId: 's1', agentSessionTitle: '   ' }))).toBe('s1')
    expect(sessionNameOf(row({ agentSessionId: 's1' }))).toBe('s1')
    expect(sessionNameOf(row({ cdpAttached: true }))).toBeUndefined()
  })
})

describe('GUARD_COPY', () => {
  beforeAll(async () => {
    await initEnI18n()
  })

  it('TP-9 三个动作都有，每个键在 en 里都有字', () => {
    expect(Object.keys(GUARD_COPY).sort()).toEqual(['close', 'navigate', 'reload'])
    for (const action of ACTIONS) {
      for (const key of Object.values(GUARD_COPY[action])) {
        const text = i18n.t(key)
        expect(text).not.toBe(key)
        expect(text.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('screenshotWidth', () => {
  const saved = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  const setRatio = (value: unknown): void => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value })
  }
  afterEach(() => {
    if (saved) Object.defineProperty(window, 'devicePixelRatio', saved)
    else delete (window as unknown as { devicePixelRatio?: number }).devicePixelRatio
  })

  it('TP-10 1 → 720；2 → 1280（封顶）；1.5 → 1080；小于 1 → 720；没有 → 720', () => {
    setRatio(1)
    expect(screenshotWidth()).toBe(720)
    setRatio(2)
    expect(screenshotWidth()).toBe(1280)
    setRatio(1.5)
    expect(screenshotWidth()).toBe(1080)
    setRatio(0.5)
    expect(screenshotWidth()).toBe(720)
    setRatio(undefined)
    expect(screenshotWidth()).toBe(720)
  })
})
