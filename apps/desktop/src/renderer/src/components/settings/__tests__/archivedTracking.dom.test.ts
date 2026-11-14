// @vitest-environment jsdom
/**
 * 设置 → 已归档 → 跟踪项（components/settings/ArchivedTracking.tsx，jsdom）。2026-11-14 用户：已归档的跟踪项从收件箱
 * 挪到设置里 —— 收件箱只列还在跟的，归档了的在这里恢复（状态改回 `active`）或删除。
 *
 *   AT-1  只有在跟 / 等待中的 →「No archived tracked items」，没有列表
 *   AT-2  混着的 → 只列已归档的，每行 `[data-archived-tracking-item=<文件名>]`：标题，下面「结论 · 文件名」（没有结论只有文件名）
 *   AT-3  恢复 → tracking.setStatus({fileName, status:'active'})，然后重新拉清单
 *   AT-4  恢复失败 → 一行错误；之后一次成功把它清掉
 *   AT-5  删除先弹确认框（标题是跟踪项删除确认的标题，说明里带标题）；取消什么都不删
 *   AT-6  确认 → tracking.deleteItem({fileName})、关掉确认框；失败显示原因
 *   AT-7  `tracking.changed` 重新拉清单，`bot.changed` 不拉；卸载时退订
 *   AT-8  [WB] 拉清单失败 → 空文案，不抛
 *   AT-9  [WB] 按钮那一格在没有悬停的设备上一直显示；行本身不打开任何东西
 *   AS-1  已归档设置页的附加分页顺序：小组件、Bots、跟踪项
 *
 * 确认框换成记下 props 的替身（画一个 `[data-confirm]` 占位）；`window.api` 只铺 tracking.list / setStatus /
 * deleteItem 与 events.subscribe。真 en 文案。AS-1 把共享的 `@shuvix/app-shell` ArchivedSettings 换成记下 props 的替身。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { TrackingItem } from '@shuvix/chat-protocol/trackingNotes'

type Props = Record<string, unknown>

const rec = vi.hoisted(() => ({ confirms: [] as Props[], shared: [] as Props[] }))

vi.mock('../../common/ConfirmDialog', async () => {
  const { createElement: h } = await import('react')
  return {
    ConfirmDialog: (props: Props) => {
      rec.confirms.push(props)
      return h('div', { 'data-confirm': '' })
    }
  }
})
vi.mock('@shuvix/app-shell', () => ({
  ArchivedSettings: (props: Props) => {
    rec.shared.push(props)
    return null
  }
}))
vi.mock('@shuvix/chat-ui', () => ({
  getChatApi: () => ({}),
  useChatStore: Object.assign(() => undefined, { getState: () => ({}) })
}))
vi.mock('../ArchivedWidgets', () => ({ ArchivedWidgets: () => null }))
vi.mock('../ArchivedBots', () => ({ ArchivedBots: () => null }))

import { ArchivedTracking } from '../ArchivedTracking'
import { ArchivedSettings } from '../ArchivedSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Listener = (event: { type: string }) => void

const api = {
  tracking: {
    list: vi.fn<() => Promise<TrackingItem[]>>(),
    setStatus: vi.fn<(arg: { fileName: string; status: string }) => Promise<unknown>>(),
    deleteItem: vi.fn<(arg: { fileName: string }) => Promise<unknown>>()
  },
  events: { subscribe: vi.fn<(listener: Listener) => () => void>() }
}
let listeners: Listener[]
let unsubscribed: number

let container: HTMLDivElement
let root: Root

const item = (
  fileName: string,
  status: TrackingItem['status'],
  over: Partial<TrackingItem> = {}
): TrackingItem => ({
  fileName,
  title: `Title ${fileName}`,
  updatedAt: 1,
  path: `/x/${fileName}`,
  status,
  ...over
})

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
async function mount(): Promise<void> {
  act(() => root.render(createElement(ArchivedTracking)))
  await flush()
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
const $ = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const rowOf = (fileName: string): HTMLElement => $(`[data-archived-tracking-item="${fileName}"]`)!
const rowFiles = (): string[] =>
  [...container.querySelectorAll('[data-archived-tracking-item]')].map(
    (el) => el.getAttribute('data-archived-tracking-item') ?? ''
  )
const errorText = (): string | null => $('.text-error')?.textContent ?? null
const lastConfirm = (): Props => rec.confirms[rec.confirms.length - 1]
async function emit(type: string): Promise<void> {
  await act(async () => {
    for (const l of listeners) l({ type })
  })
  await flush()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.confirms.length = 0
  rec.shared.length = 0
  listeners = []
  unsubscribed = 0
  api.tracking.list.mockReset().mockResolvedValue([])
  api.tracking.setStatus.mockReset().mockResolvedValue({ success: true })
  api.tracking.deleteItem.mockReset().mockResolvedValue({ success: true })
  api.events.subscribe.mockReset().mockImplementation((listener) => {
    listeners.push(listener)
    return () => {
      unsubscribed++
      listeners = listeners.filter((l) => l !== listener)
    }
  })
  ;(window as unknown as { api: unknown }).api = api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AT Settings → Archived → Tracked items', () => {
  it('AT-1 only active / waiting items → the empty text, no list', async () => {
    api.tracking.list.mockResolvedValue([item('a.md', 'active'), item('w.md', 'waiting')])
    await mount()
    expect(api.tracking.list).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(en.settings.archivedTrackingEmpty)
    expect($('[data-archived-tracking]')).toBeNull()
    expect(rowFiles()).toEqual([])
  })

  it('AT-2 mixed → only the archived rows: title, then "conclusion · file name"', async () => {
    api.tracking.list.mockResolvedValue([
      item('a.md', 'active'),
      item('z.md', 'archived', { conclusion: 'Shipped in v1' }),
      item('w.md', 'waiting'),
      item('y.md', 'archived')
    ])
    await mount()
    expect($('[data-archived-tracking]')).not.toBeNull()
    expect(rowFiles()).toEqual(['z.md', 'y.md'])
    expect(container.textContent).not.toContain(en.settings.archivedTrackingEmpty)

    const lines = (file: string): string[] =>
      [...rowOf(file).querySelectorAll('.truncate')].map((el) => el.textContent ?? '')
    expect(lines('z.md')).toEqual(['Title z.md', 'Shipped in v1 · z.md'])
    expect(lines('y.md')).toEqual(['Title y.md', 'y.md'])
  })

  it('AT-3 Restore → setStatus active, then the list is reloaded', async () => {
    api.tracking.list.mockResolvedValue([item('z.md', 'archived')])
    await mount()
    api.tracking.list.mockResolvedValue([item('z.md', 'active')])
    await click(rowOf('z.md').querySelector('[data-archived-tracking-restore]')!)
    expect(api.tracking.setStatus).toHaveBeenCalledWith({ fileName: 'z.md', status: 'active' })
    expect(api.tracking.list).toHaveBeenCalledTimes(2)
    expect(rowFiles()).toEqual([])
    expect(container.textContent).toContain(en.settings.archivedTrackingEmpty)
    expect(errorText()).toBeNull()
  })

  it('AT-4 a failed restore shows one error line; a later success clears it', async () => {
    api.tracking.list.mockResolvedValue([item('z.md', 'archived'), item('y.md', 'archived')])
    await mount()
    api.tracking.setStatus.mockRejectedValueOnce(new Error('file is gone'))
    await click(rowOf('z.md').querySelector('[data-archived-tracking-restore]')!)
    expect(container.querySelectorAll('.text-error')).toHaveLength(1)
    expect(errorText()).toBe('file is gone')
    expect(rowFiles()).toEqual(['z.md', 'y.md'])

    await click(rowOf('y.md').querySelector('[data-archived-tracking-restore]')!)
    expect(api.tracking.setStatus).toHaveBeenLastCalledWith({ fileName: 'y.md', status: 'active' })
    expect(errorText()).toBeNull()
  })

  it('AT-5 Delete opens the confirm dialog; Cancel deletes nothing', async () => {
    api.tracking.list.mockResolvedValue([item('z.md', 'archived', { title: 'Release v2' })])
    await mount()
    expect($('[data-confirm]')).toBeNull()
    await click(rowOf('z.md').querySelector('[data-archived-tracking-delete]')!)
    expect($('[data-confirm]')).not.toBeNull()
    const props = lastConfirm()
    expect(props.title).toBe(en.sidebar.trackingConfirmDeleteTitle)
    expect(String(props.description)).toContain('Release v2')

    await act(async () => (props.onCancel as () => void)())
    await flush()
    expect($('[data-confirm]')).toBeNull()
    expect(api.tracking.deleteItem).not.toHaveBeenCalled()
    expect(rowFiles()).toEqual(['z.md'])
  })

  it('AT-6 confirming deletes by file name and closes the dialog; a failure shows its reason', async () => {
    api.tracking.list.mockResolvedValue([item('z.md', 'archived'), item('y.md', 'archived')])
    await mount()
    await click(rowOf('z.md').querySelector('[data-archived-tracking-delete]')!)
    api.tracking.list.mockResolvedValue([item('y.md', 'archived')])
    await act(async () => {
      await (lastConfirm().onConfirm as () => Promise<void>)()
    })
    await flush()
    expect(api.tracking.deleteItem).toHaveBeenCalledWith({ fileName: 'z.md' })
    expect($('[data-confirm]')).toBeNull()
    expect(rowFiles()).toEqual(['y.md'])
    expect(errorText()).toBeNull()

    api.tracking.deleteItem.mockRejectedValueOnce(new Error('cannot delete'))
    await click(rowOf('y.md').querySelector('[data-archived-tracking-delete]')!)
    await act(async () => {
      await (lastConfirm().onConfirm as () => Promise<void>)()
    })
    await flush()
    expect(api.tracking.deleteItem).toHaveBeenLastCalledWith({ fileName: 'y.md' })
    expect($('[data-confirm]')).toBeNull()
    expect(errorText()).toBe('cannot delete')
  })

  it('AT-7 tracking.changed reloads, bot.changed does not; unmount unsubscribes', async () => {
    await mount()
    expect(api.tracking.list).toHaveBeenCalledTimes(1)
    api.tracking.list.mockResolvedValue([item('z.md', 'archived')])
    await emit('bot.changed')
    expect(api.tracking.list).toHaveBeenCalledTimes(1)
    expect(rowFiles()).toEqual([])
    await emit('tracking.changed')
    expect(api.tracking.list).toHaveBeenCalledTimes(2)
    expect(rowFiles()).toEqual(['z.md'])

    expect(unsubscribed).toBe(0)
    act(() => root.unmount())
    expect(unsubscribed).toBe(1)
    root = createRoot(container)
  })

  it('AT-8 [WB] the list rejects → the empty text, nothing thrown', async () => {
    api.tracking.list.mockRejectedValue(new Error('no folder'))
    await mount()
    expect(container.textContent).toContain(en.settings.archivedTrackingEmpty)
    expect(rowFiles()).toEqual([])
    expect(errorText()).toBeNull()
  })

  it('AT-9 [WB] the buttons stay visible without hover; the row itself opens nothing', async () => {
    api.tracking.list.mockResolvedValue([item('z.md', 'archived', { conclusion: 'done' })])
    await mount()
    const restore = rowOf('z.md').querySelector('[data-archived-tracking-restore]')!
    const box = restore.parentElement!
    expect(box.contains(rowOf('z.md').querySelector('[data-archived-tracking-delete]'))).toBe(true)
    expect(box.className).toContain('[@media(hover:none)]:opacity-100')

    const row = rowOf('z.md')
    expect(row.getAttribute('role')).toBeNull()
    expect(row.getAttribute('tabindex')).toBeNull()
    await click(row)
    await click(row.querySelector('.truncate')!)
    expect(api.tracking.setStatus).not.toHaveBeenCalled()
    expect(api.tracking.deleteItem).not.toHaveBeenCalled()
    expect($('[data-confirm]')).toBeNull()
    expect(api.tracking.list).toHaveBeenCalledTimes(1)
  })
})

describe('AS-1 the archived settings page', () => {
  it('AS-1 extra tabs in order: Widgets, Bots, Tracked items', async () => {
    act(() => root.render(createElement(ArchivedSettings)))
    await flush()
    const props = rec.shared[rec.shared.length - 1]
    const tabs = props.extraTabs as Array<{ key: string; label: string }>
    expect(tabs.map((x) => x.key)).toEqual(['widgets', 'bots', 'tracking'])
    expect(tabs.map((x) => x.label)).toEqual([
      en.settings.archivedSubTabWidgets,
      en.settings.archivedSubTabBots,
      en.settings.archivedSubTabTracking
    ])
  })
})
