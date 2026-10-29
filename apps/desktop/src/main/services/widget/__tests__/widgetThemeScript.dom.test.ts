// @vitest-environment jsdom
/**
 * 组件页面头部的主题脚本（widgetTheme.ts 的 themeBootScript）在真的 DOM 里跑：按「模式 + 浅色那套 + 深色那套」在 `<html>`
 * 上设 `data-theme` / `data-scheme`，主题真变了才在 window 上发 `shuvix:theme`；`window.__shuvixSetTheme(state)` 换选择
 * （宿主收到 SSE `theme` 时调）；`system` 跟页面的媒体查询，强制的明暗（预览的 shuvix-scheme）盖过模式。
 *
 * window.matchMedia 换成假的 MQL（`matches` 可改、change 监听者记下、用例自己触发）；每条用例前清掉 `<html>` 的属性与
 * `__shuvixSetTheme`；`shuvix:theme` 事件逐个记下；脚本用 `new Function(themeBootScript(state, forced))()` 跑。
 *
 *   TS-1 模式 dark、媒体查询是浅色 → data-theme = 深色那套、data-scheme = dark，恰好一个事件 detail {id, scheme}；
 *        模式 light、媒体查询是深色 → 浅色那套
 *   TS-2 system：媒体查询决定；翻过去并触发 change → 一个事件；没翻就触发 change → 没有事件
 *   TS-3 __shuvixSetTheme(同一份) → 没有事件；只换 light、正显示深色 → 没有事件；换 dark → 一个事件、新 id
 *   TS-4 强制 dark、state.mode 是 light → 深色那一侧；再 __shuvixSetTheme({light, one-light, dracula}) → dracula；
 *        媒体查询变了 → 没有事件
 *   TS-5 __shuvixSetTheme(null)、({})、({light:1})、({mode:'blue', …}) → 不抛、没有事件、选择不变
 *   TS-6 WIDGET_EXPORT_THEME：按媒体查询选 github-dark / github-light
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { themeBootScript, WIDGET_EXPORT_THEME, type WidgetThemeState } from '../widgetTheme'

interface FakeMql {
  matches: boolean
  media: string
  listeners: Array<() => void>
  addEventListener: (type: string, fn: () => void) => void
  removeEventListener: (type: string, fn: () => void) => void
}

let mql: FakeMql
let events: Array<{ id: string; scheme: string }>
const onTheme = (e: Event): void => {
  events.push((e as CustomEvent<{ id: string; scheme: string }>).detail)
}

declare global {
  interface Window {
    __shuvixSetTheme?: (next: unknown) => void
  }
}

const root = (): HTMLElement => document.documentElement
const shown = (): { theme: string | null; scheme: string | null } => ({
  theme: root().getAttribute('data-theme'),
  scheme: root().getAttribute('data-scheme')
})

/** 媒体查询翻到 dark（或浅色），并像浏览器那样通知监听者 */
function flipMedia(dark: boolean): void {
  mql.matches = dark
  for (const fn of [...mql.listeners]) fn()
}

function boot(state: WidgetThemeState, forced: 'light' | 'dark' | null = null): void {
  new Function(themeBootScript(state, forced))()
}

beforeEach(() => {
  for (const name of [...root().getAttributeNames()]) root().removeAttribute(name)
  delete window.__shuvixSetTheme
  mql = {
    matches: false,
    media: '(prefers-color-scheme: dark)',
    listeners: [],
    addEventListener: (type, fn) => {
      if (type === 'change') mql.listeners.push(fn)
    },
    removeEventListener: (type, fn) => {
      if (type === 'change') mql.listeners = mql.listeners.filter((f) => f !== fn)
    }
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql)
  )
  events = []
  window.addEventListener('shuvix:theme', onTheme)
})

afterEach(() => {
  window.removeEventListener('shuvix:theme', onTheme)
  vi.unstubAllGlobals()
})

const STATE: WidgetThemeState = { mode: 'system', light: 'one-light', dark: 'nord' }

describe('TS 头部主题脚本', () => {
  it('TS-1 强制的模式不看媒体查询：dark + 浅色系统 → 深色那套；light + 深色系统 → 浅色那套', () => {
    mql.matches = false
    boot({ ...STATE, mode: 'dark' })
    expect(shown()).toEqual({ theme: 'nord', scheme: 'dark' })
    expect(events).toEqual([{ id: 'nord', scheme: 'dark' }])
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-color-scheme: dark)')

    // 换一页：清掉，再按 light 跑
    window.removeEventListener('shuvix:theme', onTheme)
    for (const name of [...root().getAttributeNames()]) root().removeAttribute(name)
    events = []
    window.addEventListener('shuvix:theme', onTheme)
    mql.matches = true
    mql.listeners = []
    boot({ ...STATE, mode: 'light' })
    expect(shown()).toEqual({ theme: 'one-light', scheme: 'light' })
    expect(events).toEqual([{ id: 'one-light', scheme: 'light' }])
  })

  it('TS-2 system：媒体查询决定；翻过去 → 一个事件；没翻的 change → 没有事件', () => {
    mql.matches = true
    boot(STATE)
    expect(shown()).toEqual({ theme: 'nord', scheme: 'dark' })
    expect(events).toHaveLength(1)
    expect(mql.listeners).toHaveLength(1)

    flipMedia(false)
    expect(shown()).toEqual({ theme: 'one-light', scheme: 'light' })
    expect(events).toEqual([
      { id: 'nord', scheme: 'dark' },
      { id: 'one-light', scheme: 'light' }
    ])

    // change 来了但没翻（浏览器偶尔这么报）：什么都不发
    flipMedia(false)
    expect(events).toHaveLength(2)
    expect(shown()).toEqual({ theme: 'one-light', scheme: 'light' })
  })

  it('TS-3 只在显示的那一套真变了时才发事件', () => {
    mql.matches = true
    boot(STATE)
    expect(events).toHaveLength(1)

    window.__shuvixSetTheme!({ ...STATE })
    expect(events).toHaveLength(1)

    // 正显示深色：只换浅色那套 → 看不出变化
    window.__shuvixSetTheme!({ ...STATE, light: 'catppuccin-latte' })
    expect(events).toHaveLength(1)
    expect(shown()).toEqual({ theme: 'nord', scheme: 'dark' })

    window.__shuvixSetTheme!({ ...STATE, light: 'catppuccin-latte', dark: 'dracula' })
    expect(events).toEqual([
      { id: 'nord', scheme: 'dark' },
      { id: 'dracula', scheme: 'dark' }
    ])
    expect(shown()).toEqual({ theme: 'dracula', scheme: 'dark' })

    // 换过的浅色那套记着：系统翻到浅色时用它
    flipMedia(false)
    expect(shown()).toEqual({ theme: 'catppuccin-latte', scheme: 'light' })
    expect(events).toHaveLength(3)
  })

  it('TS-4 强制的明暗盖过模式与媒体查询；哪一套仍跟设置', () => {
    mql.matches = false
    boot({ mode: 'light', light: 'one-light', dark: 'nord' }, 'dark')
    expect(shown()).toEqual({ theme: 'nord', scheme: 'dark' })
    expect(events).toEqual([{ id: 'nord', scheme: 'dark' }])

    window.__shuvixSetTheme!({ mode: 'light', light: 'one-light', dark: 'dracula' })
    expect(shown()).toEqual({ theme: 'dracula', scheme: 'dark' })
    expect(events).toHaveLength(2)

    flipMedia(true)
    flipMedia(false)
    expect(shown()).toEqual({ theme: 'dracula', scheme: 'dark' })
    expect(events).toHaveLength(2)
  })

  it.each<[string, unknown]>([
    ['null', null],
    ['{}', {}],
    ['{light: 1}', { light: 1 }],
    ['不认识的模式', { mode: 'blue', light: 'one-light', dark: 'nord' }],
    ['light 不是字符串', { mode: 'dark', light: 1, dark: 'nord' }],
    ['dark 不是字符串', { mode: 'dark', light: 'one-light', dark: null }],
    ['没有 mode', { light: 'catppuccin-latte', dark: 'dracula' }]
  ])('TS-5 __shuvixSetTheme(%s) → 不抛、没有事件、选择不变', (_label, bad) => {
    mql.matches = true
    boot(STATE)
    expect(events).toHaveLength(1)

    expect(() => window.__shuvixSetTheme!(bad)).not.toThrow()
    expect(events).toHaveLength(1)
    expect(shown()).toEqual({ theme: 'nord', scheme: 'dark' })

    // 选择还是原来那份：翻到浅色用的是原来的浅色那套
    flipMedia(false)
    expect(shown()).toEqual({ theme: 'one-light', scheme: 'light' })
  })

  it.each<[boolean, string, string]>([
    [true, 'github-dark', 'dark'],
    [false, 'github-light', 'light']
  ])('TS-6 导出项目的选择：系统深色 = %s → %s', (dark, id, scheme) => {
    mql.matches = dark
    boot(WIDGET_EXPORT_THEME)
    expect(shown()).toEqual({ theme: id, scheme })
    expect(events).toEqual([{ id, scheme }])
  })
})
