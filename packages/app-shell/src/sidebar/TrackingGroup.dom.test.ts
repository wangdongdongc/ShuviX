// @vitest-environment jsdom
/**
 * TrackingGroup —— 侧栏 Library 的「跟踪项」分组（实验，`~/.shuvix/tracking/`，2026-10-24；jsdom）。
 *
 *   TG-1 初始折叠，组头挂「实验」小标签；首次展开之前不调 list
 *   TG-2 展开 → list 恰一次；空 → 空态提示；有项 → 按给定顺序出行，`data-tracking-row` = 文件名，
 *        行的 title = 文件名，文字 = 标题
 *   TG-3 每次重新展开都重扫（收起不扫）
 *   TG-4 窗口 focus：首次扫描之前不扫，之后每次都重扫
 *   TG-5 `tracking.changed`：首次扫描之前不扫，之后每次都重扫
 *   TG-6 stale guard：重叠的两次扫描乱序回包 → 以最后一次发起的为准（晚到的旧包、旧包的失败都不覆盖）
 *   TG-7 list 失败 → 空态提示
 *   TG-8 点一行 → adapter.open(fileName, title)
 *   TG-9 组头菜单 = [open-folder, 分隔线, refresh]；open-folder → openFolder，refresh → 重扫
 *   TG-10 活动会话是 `__tracking__` 里 notebookPath = 某一行的笔记本 → 那一行选中、组高亮，专注模式下别的行变淡、
 *         整组不淡；活动会话在别处 → 整组淡、没有选中行
 *
 * 右键菜单走 ContextMenuProvider 的 `render` 注入：记录菜单项、按预设回一个 id（模拟用户点了它）。
 * `@shuvix/chat-ui` 替掉 useAppEvent（记下回调，好手动派发）/ useChatStore / useChatHost；chatStore 与专注模式的
 * 状态放在可变的 `store` 里（TG-10 换活动会话）。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { TrackingItem } from '@shuvix/chat-protocol/trackingNotes'
import type { ContextMenuItem } from '@shuvix/chat-protocol/types/contextMenu'

interface StoreSession {
  id: string
  projectId: string | null
  settings: { notebookPath?: string }
}
const store = vi.hoisted(() => ({
  sessions: [] as StoreSession[],
  activeSessionId: null as string | null,
  focusMode: false
}))
const appEvents = vi.hoisted(() => new Map<string, Set<() => void>>())

vi.mock('@shuvix/chat-ui', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    // 记下每个订阅者，用例里按事件名派发；回调走 ref，拿到的总是最新一次渲染的闭包
    useAppEvent: (type: string, handler: () => void) => {
      const ref = useRef(handler)
      ref.current = handler
      useEffect(() => {
        const fn = (): void => ref.current()
        if (!appEvents.has(type)) appEvents.set(type, new Set())
        appEvents.get(type)!.add(fn)
        return () => {
          appEvents.get(type)?.delete(fn)
        }
      }, [type])
    },
    useChatStore: (selector: (s: typeof store) => unknown) => selector(store),
    useChatHost: () => ({ appearance: { focusMode: store.focusMode } })
  }
})

import { TrackingGroup, type TrackingGroupAdapter } from './TrackingGroup'
import { ContextMenuProvider } from '../contextmenu/ContextMenuProvider'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
/** 每次弹出的菜单项；pick = 「用户」点的那一项（null = 取消） */
let menus: ContextMenuItem[][]
let pick: string | null

type Adapter = TrackingGroupAdapter & {
  list: ReturnType<typeof vi.fn<TrackingGroupAdapter['list']>>
  open: ReturnType<typeof vi.fn<TrackingGroupAdapter['open']>>
  openFolder: ReturnType<typeof vi.fn<TrackingGroupAdapter['openFolder']>>
}

const item = (fileName: string, title: string, updatedAt = 1): TrackingItem => ({
  fileName,
  title,
  updatedAt
})

function makeAdapter(list: TrackingGroupAdapter['list']): Adapter {
  return {
    list: vi.fn(list),
    open: vi.fn<TrackingGroupAdapter['open']>(),
    openFolder: vi.fn<TrackingGroupAdapter['openFolder']>()
  }
}

/** 可手动结算的 promise（TG-6 造乱序回包） */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function mount(adapter: Adapter): Promise<void> {
  await act(async () => {
    // props 的类型要求 children，而 lint 不许把 children 放进 props —— 子节点照常作第三个参数，props 断言一下
    type ProviderProps = ComponentProps<typeof ContextMenuProvider>
    const props: Omit<ProviderProps, 'children'> = {
      render: async (items: ContextMenuItem[]) => {
        menus.push(items)
        return pick
      }
    }
    root.render(
      createElement(
        ContextMenuProvider,
        props as ProviderProps,
        createElement(TrackingGroup, { adapter })
      )
    )
  })
  await flush()
}

const header = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-group="tracking"]')
  if (!el) throw new Error('tracking group header not rendered')
  return el
}
/** 点组头的折叠按钮（展开 / 收起） */
async function toggle(): Promise<void> {
  await act(async () => {
    header().querySelector('button')!.click()
  })
  await flush()
}
/** AnimatedCollapse 的格子：收起 = 0fr */
const collapseGrid = (): HTMLElement => header().nextElementSibling as HTMLElement
const rows = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-tracking-row]')
]
const row = (fileName: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`[data-tracking-row="${fileName}"]`)
  if (!el) throw new Error(`row ${fileName} not rendered`)
  return el
}
const hint = (): HTMLElement | null => container.querySelector<HTMLElement>('.sb-hint')

async function fireFocus(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await flush()
}
async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const fn of appEvents.get(type) ?? []) fn()
  })
  await flush()
}
async function openGroupMenu(): Promise<ContextMenuItem[]> {
  const before = menus.length
  await act(async () => {
    header().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await flush()
  expect(menus.length).toBe(before + 1)
  return menus[menus.length - 1]
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  menus = []
  pick = null
  store.sessions = []
  store.activeSessionId = null
  store.focusMode = false
  appEvents.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('TrackingGroup —— 懒扫描与列表', () => {
  it('TG-1 初始折叠、组头挂「实验」小标签；首次展开之前不调 list，也没有行和空态提示', async () => {
    const adapter = makeAdapter(async () => [item('a.md', 'Alpha')])
    await mount(adapter)
    expect(header().textContent).toContain(en.sidebar.trackingGroup)
    const tag = header().querySelector<HTMLElement>('[data-experimental="tracking"]')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toBe(en.experimental.tag)
    expect(collapseGrid().style.gridTemplateRows).toBe('0fr')
    expect(adapter.list).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0)
    expect(hint()).toBeNull()
  })

  it('TG-2 展开 → list 恰一次；空清单 → 空态提示，没有行', async () => {
    const adapter = makeAdapter(async () => [])
    await mount(adapter)
    await toggle()
    expect(collapseGrid().style.gridTemplateRows).toBe('1fr')
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(0)
    expect(hint()?.textContent).toBe(en.sidebar.trackingEmpty)
  })

  it('TG-2 有项 → 按宿主给的顺序出行；data-tracking-row 与 title = 文件名，文字 = 标题', async () => {
    // 宿主已按修改时间倒序排好；组件不重排（故意给一个与 updatedAt 无关的顺序）
    const adapter = makeAdapter(async () => [
      item('b.md', 'b', 1),
      item('a.md', 'Alpha bug', 9),
      item('c.md', 'Gamma', 5)
    ])
    await mount(adapter)
    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(rows().map((r) => r.getAttribute('data-tracking-row'))).toEqual(['b.md', 'a.md', 'c.md'])
    expect(row('a.md').getAttribute('title')).toBe('a.md')
    expect(row('a.md').textContent).toBe('Alpha bug')
    expect(row('b.md').textContent).toBe('b')
    expect(hint()).toBeNull()
  })

  it('TG-3 每次重新展开都重扫；收起不扫', async () => {
    let n = 0
    const adapter = makeAdapter(async () => {
      n++
      return [item(`v${n}.md`, `V${n}`)]
    })
    await mount(adapter)
    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(1)
    await toggle() // 收起
    expect(collapseGrid().style.gridTemplateRows).toBe('0fr')
    expect(adapter.list).toHaveBeenCalledTimes(1)
    await toggle() // 再展开
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(rows().map((r) => r.textContent)).toEqual(['V2'])
    await toggle()
    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(3)
  })

  it('TG-4 窗口 focus：首次扫描之前不扫；首次展开之后每次 focus 都重扫', async () => {
    let n = 0
    const adapter = makeAdapter(async () => {
      n++
      return [item('a.md', `Title ${n}`)]
    })
    await mount(adapter)
    await fireFocus()
    await fireFocus()
    expect(adapter.list).not.toHaveBeenCalled()

    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(1)
    await fireFocus()
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(row('a.md').textContent).toBe('Title 2')
  })

  it('TG-5 tracking.changed：首次扫描之前不扫；之后每次都重扫；别的事件不扫', async () => {
    let n = 0
    const adapter = makeAdapter(async () => {
      n++
      return [item('a.md', `Title ${n}`)]
    })
    await mount(adapter)
    await emit('tracking.changed')
    expect(adapter.list).not.toHaveBeenCalled()

    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(1)
    await emit('tracking.changed')
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(row('a.md').textContent).toBe('Title 2')
    await emit('daily.changed')
    expect(adapter.list).toHaveBeenCalledTimes(2)
  })

  it('TG-6 stale guard：先发起的扫描晚回包 → 丢弃，以最后一次发起的为准', async () => {
    const first = deferred<TrackingItem[]>()
    const second = deferred<TrackingItem[]>()
    const queue = [first, second]
    const adapter = makeAdapter(() => queue.shift()!.promise)
    await mount(adapter)
    await toggle() // 扫描 1（挂起）
    await fireFocus() // 扫描 2（挂起）
    expect(adapter.list).toHaveBeenCalledTimes(2)

    await act(async () => second.resolve([item('new.md', 'New')]))
    await flush()
    expect(rows().map((r) => r.getAttribute('data-tracking-row'))).toEqual(['new.md'])

    await act(async () => first.resolve([item('old.md', 'Old')]))
    await flush()
    expect(rows().map((r) => r.getAttribute('data-tracking-row'))).toEqual(['new.md'])
  })

  it('TG-6 旧扫描晚到的失败也不清空新结果', async () => {
    const first = deferred<TrackingItem[]>()
    const second = deferred<TrackingItem[]>()
    const queue = [first, second]
    const adapter = makeAdapter(() => queue.shift()!.promise)
    await mount(adapter)
    await toggle()
    await emit('tracking.changed')
    await act(async () => second.resolve([item('a.md', 'Alpha')]))
    await flush()
    await act(async () => first.reject(new Error('stale boom')))
    await flush()
    expect(rows().map((r) => r.textContent)).toEqual(['Alpha'])
    expect(hint()).toBeNull()
  })

  it('TG-7 list 失败 → 空态提示，不抛', async () => {
    const adapter = makeAdapter(async () => {
      throw new Error('boom')
    })
    await mount(adapter)
    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(1)
    expect(rows()).toHaveLength(0)
    expect(hint()?.textContent).toBe(en.sidebar.trackingEmpty)
  })
})

describe('TrackingGroup —— 交互', () => {
  it('TG-8 点一行 → adapter.open(fileName, title) 恰一次', async () => {
    const adapter = makeAdapter(async () => [item('a.md', 'Alpha bug'), item('b.md', 'b')])
    await mount(adapter)
    await toggle()
    await act(async () => row('a.md').click())
    expect(adapter.open.mock.calls).toEqual([['a.md', 'Alpha bug']])
  })

  it('TG-9 组头菜单 = [open-folder, 分隔线, refresh]；open-folder → openFolder，refresh → 重扫', async () => {
    const adapter = makeAdapter(async () => [item('a.md', 'Alpha')])
    await mount(adapter)
    await toggle()
    expect(adapter.list).toHaveBeenCalledTimes(1)

    const items = await openGroupMenu()
    expect(items).toHaveLength(3)
    expect(items[0]).toMatchObject({ id: 'open-folder', label: en.sidebar.trackingOpenFolder })
    expect(items[1]).toEqual({ type: 'separator' })
    expect(items[2]).toMatchObject({ id: 'refresh', label: en.panel.filesRefresh })
    // 取消 → 什么都不做
    expect(adapter.openFolder).not.toHaveBeenCalled()
    expect(adapter.list).toHaveBeenCalledTimes(1)

    pick = 'open-folder'
    await openGroupMenu()
    expect(adapter.openFolder).toHaveBeenCalledTimes(1)
    expect(adapter.list).toHaveBeenCalledTimes(1)

    pick = 'refresh'
    await openGroupMenu()
    expect(adapter.list).toHaveBeenCalledTimes(2)
    expect(adapter.openFolder).toHaveBeenCalledTimes(1)
  })
})

describe('TrackingGroup —— 当前笔记高亮与专注模式', () => {
  const groupWrapper = (): HTMLElement => header().parentElement as HTMLElement
  const groupOuter = (): HTMLElement => groupWrapper().parentElement as HTMLElement

  it('TG-10 活动会话 = __tracking__ 里 b.md 的笔记本 → b 行选中、组高亮；专注模式下 a 行变淡、整组不淡', async () => {
    store.sessions = [{ id: 'nb-b', projectId: '__tracking__', settings: { notebookPath: 'b.md' } }]
    store.activeSessionId = 'nb-b'
    store.focusMode = true
    const adapter = makeAdapter(async () => [item('a.md', 'Alpha'), item('b.md', 'Beta')])
    await mount(adapter)
    await toggle()
    expect(row('b.md').className).toContain('bg-bg-active/80')
    expect(row('b.md').className).not.toContain('opacity-30')
    expect(row('a.md').className).not.toContain('bg-bg-active/80')
    expect(row('a.md').className).toContain('opacity-30')
    expect(groupWrapper().className).toContain('bg-bg-primary/30')
    expect(groupOuter().className).not.toContain('opacity-30')
  })

  it('TG-10 不在专注模式：选中行照样亮，别的行不淡', async () => {
    store.sessions = [{ id: 'nb-b', projectId: '__tracking__', settings: { notebookPath: 'b.md' } }]
    store.activeSessionId = 'nb-b'
    const adapter = makeAdapter(async () => [item('a.md', 'Alpha'), item('b.md', 'Beta')])
    await mount(adapter)
    await toggle()
    expect(row('b.md').className).toContain('bg-bg-active/80')
    expect(row('a.md').className).not.toContain('opacity-30')
    expect(groupWrapper().className).toContain('bg-bg-primary/30')
  })

  it('TG-10 活动会话在别的项目（哪怕 notebookPath 同名）→ 没有选中行、组不高亮；专注模式下整组淡、行不单独淡', async () => {
    store.sessions = [{ id: 'other', projectId: 'p1', settings: { notebookPath: 'b.md' } }]
    store.activeSessionId = 'other'
    store.focusMode = true
    const adapter = makeAdapter(async () => [item('a.md', 'Alpha'), item('b.md', 'Beta')])
    await mount(adapter)
    await toggle()
    for (const r of rows()) {
      expect(r.className).not.toContain('bg-bg-active/80')
      expect(r.className).not.toContain('opacity-30')
    }
    expect(groupWrapper().className).not.toContain('bg-bg-primary/30')
    expect(groupOuter().className).toContain('opacity-30')
  })
})
