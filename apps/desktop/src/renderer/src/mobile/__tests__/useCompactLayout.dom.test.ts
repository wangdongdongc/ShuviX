// @vitest-environment jsdom
/**
 * 要不要用手机布局（mobile/useCompactLayout.ts，jsdom）。
 *
 * 契约：只有浏览器里的 web 客户端看媒体查询（窄于 640px，或触屏且矮于 500px）；桌面应用的窗口恒为 false、
 * 连 matchMedia 都不碰；查询结果变了就跟着重渲染，卸载时摘掉的是挂上去的那同一个监听；浏览器没有
 * matchMedia 时就是 false、不抛。
 *
 *   CL-1 COMPACT_LAYOUT_QUERY 的字面值
 *   CL-2 桌面平台 → false（matches 为 true 也是）；matchMedia 一次都没调
 *   CL-3 web → 跟着 matches 走，传的就是那条查询
 *   CL-4 change 监听来了 → 两个方向都重渲染
 *   CL-5 卸载 → 摘掉的是同一个监听
 *   CL-6 web 但没有 matchMedia → false，不抛
 *
 * `../host/hostMedia` 换成带 getter 的替身（isWebHost 在模块求值时就定了，测两种平台得能切）；matchMedia 是
 * 一个共享 `matches` 的桩，记下每次查询与挂 / 摘的监听。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const host = vi.hoisted(() => ({ web: true }))
vi.mock('../../host/hostMedia', () => ({
  get isWebHost() {
    return host.web
  }
}))

import { COMPACT_LAYOUT_QUERY, useCompactLayout } from '../useCompactLayout'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** matchMedia 桩的共享状态 */
const media = {
  matches: false,
  queries: [] as string[],
  added: [] as Array<() => void>,
  removed: [] as Array<() => void>,
  live: new Set<() => void>()
}

const matchMedia = vi.fn((query: string) => {
  media.queries.push(query)
  return {
    get matches() {
      return media.matches
    },
    media: query,
    addEventListener: (type: string, fn: () => void) => {
      if (type !== 'change') return
      media.added.push(fn)
      media.live.add(fn)
    },
    removeEventListener: (type: string, fn: () => void) => {
      if (type !== 'change') return
      media.removed.push(fn)
      media.live.delete(fn)
    }
  }
})

let container: HTMLDivElement
let root: Root
let renders = 0

function Probe(): React.JSX.Element {
  renders++
  return createElement('span', { 'data-compact': String(useCompactLayout()) })
}

const shown = (): string | null =>
  container.querySelector('[data-compact]')?.getAttribute('data-compact') ?? null

const mount = (): void => {
  act(() => root.render(createElement(Probe)))
}

/** 媒体查询的结果变了：改共享 matches，再挨个叫此刻挂着的 change 监听 */
const flip = (matches: boolean): void => {
  media.matches = matches
  act(() => {
    for (const fn of [...media.live]) fn()
  })
}

beforeEach(() => {
  host.web = true
  media.matches = false
  media.queries = []
  media.added = []
  media.removed = []
  media.live.clear()
  matchMedia.mockClear()
  renders = 0
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('useCompactLayout', () => {
  it('CL-1 the query string', () => {
    expect(COMPACT_LAYOUT_QUERY).toBe(
      '(max-width: 639.98px), (pointer: coarse) and (max-height: 500px)'
    )
  })

  it('CL-2 the desktop platform is never compact and never asks matchMedia', () => {
    host.web = false
    media.matches = true
    mount()
    expect(shown()).toBe('false')
    expect(matchMedia).not.toHaveBeenCalled()
    expect(media.added).toHaveLength(0)
  })

  it('CL-3 on the web it follows matches, asking for exactly that query', () => {
    media.matches = true
    mount()
    expect(shown()).toBe('true')
    expect(matchMedia).toHaveBeenCalled()
    expect(new Set(media.queries)).toEqual(new Set([COMPACT_LAYOUT_QUERY]))

    act(() => root.unmount())
    root = createRoot(container)
    media.matches = false
    mount()
    expect(shown()).toBe('false')
  })

  it('CL-4 a change event re-renders in both directions', () => {
    mount()
    expect(shown()).toBe('false')
    expect(media.live.size).toBeGreaterThan(0)
    const before = renders
    flip(true)
    expect(shown()).toBe('true')
    expect(renders).toBeGreaterThan(before)
    flip(false)
    expect(shown()).toBe('false')
  })

  it('CL-5 unmounting removes the very listener it added', () => {
    mount()
    expect(media.added).toHaveLength(1)
    act(() => root.unmount())
    expect(media.removed).toHaveLength(1)
    expect(media.removed[0]).toBe(media.added[0])
    expect(media.live.size).toBe(0)
    root = createRoot(container)
  })

  it('CL-6 on the web without matchMedia it is false and does not throw', () => {
    delete (window as { matchMedia?: unknown }).matchMedia
    expect(() => mount()).not.toThrow()
    expect(shown()).toBe('false')
  })
})
