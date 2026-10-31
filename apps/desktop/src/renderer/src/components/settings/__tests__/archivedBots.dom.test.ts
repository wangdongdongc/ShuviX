// @vitest-environment jsdom
/**
 * 设置 → 已归档 → Bots（components/settings/ArchivedBots.tsx，jsdom）。归档的 bot 不在侧栏，它的会话也一起藏着 ——
 * 这里恢复，或连同会话删除。
 *
 *   AB-1  一份都没有 →「No archived bots」；每份一行 `[data-archived-bot=<文件名>]`：显示名、「N chat(s) · 文件名」；
 *         恢复 → bot.restore({fileName})，失败把原因显示出来、下一次成功清掉；删除先弹确认框（标题带显示名、说明带
 *         会话条数），取消什么都不删，确认 → bot.deleteArchived({fileName})、关掉确认框、失败显示原因；
 *         `bot.changed` 事件重新拉清单（别的事件不拉），卸载时退订
 *
 * `@shuvix/chat-ui` 只给 BotAvatar；确认框换成记下 props 的替身（画一个 `[data-confirm]` 占位，看它开着没有）；
 * `window.api` 只铺 bot.listArchived / restore / deleteArchived 与 events.subscribe。真 en 文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>

const rec = vi.hoisted(() => ({ confirms: [] as Props[] }))

vi.mock('@shuvix/chat-ui', async () => {
  const { createElement: h } = await import('react')
  return { BotAvatar: ({ name }: { name: string }) => h('span', { 'data-avatar': name }) }
})
vi.mock('../../common/ConfirmDialog', async () => {
  const { createElement: h } = await import('react')
  return {
    ConfirmDialog: (props: Props) => {
      rec.confirms.push(props)
      return h('div', { 'data-confirm': '' })
    }
  }
})

import { ArchivedBots } from '../ArchivedBots'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Row {
  name: string
  displayName: string
  description: string
  fileName: string
  sessionCount: number
}
type Listener = (event: { type: string }) => void

const api = {
  bot: {
    listArchived: vi.fn<() => Promise<Row[]>>(),
    restore: vi.fn<(arg: { fileName: string }) => Promise<{ success: boolean; error?: string }>>(),
    deleteArchived:
      vi.fn<(arg: { fileName: string }) => Promise<{ success: boolean; error?: string }>>()
  },
  events: { subscribe: vi.fn<(listener: Listener) => () => void>() }
}
let listeners: Listener[]
let unsubscribed: number

let container: HTMLDivElement
let root: Root

const row = (name: string, sessionCount: number, displayName = name): Row => ({
  name,
  displayName,
  description: '',
  fileName: `${name}.md`,
  sessionCount
})

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
async function mount(): Promise<void> {
  act(() => root.render(createElement(ArchivedBots)))
  await flush()
}
async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await flush()
}
const $ = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
const rowOf = (fileName: string): HTMLElement => $(`[data-archived-bot="${fileName}"]`)!
const errorText = (): string | null => $('.text-error')?.textContent ?? null
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
  listeners = []
  unsubscribed = 0
  api.bot.listArchived.mockReset().mockResolvedValue([])
  api.bot.restore.mockReset().mockResolvedValue({ success: true })
  api.bot.deleteArchived.mockReset().mockResolvedValue({ success: true })
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

describe('AB-1 Settings → Archived → Bots', () => {
  it('AB-1 nothing archived → the empty text, no list', async () => {
    await mount()
    expect(api.bot.listArchived).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain(en.settings.archivedBotsEmpty)
    expect($('[data-archived-bots]')).toBeNull()
  })

  it('AB-1 one row per archived file: display name, chat count and file name', async () => {
    api.bot.listArchived.mockResolvedValue([row('scout', 3, 'Scout'), row('pal', 0)])
    await mount()
    expect(
      [...container.querySelectorAll('[data-archived-bot]')].map((el) =>
        el.getAttribute('data-archived-bot')
      )
    ).toEqual(['scout.md', 'pal.md'])
    const scout = rowOf('scout.md')
    expect(scout.textContent).toContain('Scout')
    expect(scout.textContent).toContain(
      `${i18n.t('settings.archivedBotSessions', { count: 3 })} · scout.md`
    )
    expect(rowOf('pal.md').textContent).toContain(
      i18n.t('settings.archivedBotSessions', { count: 0 })
    )
    expect(container.textContent).not.toContain(en.settings.archivedBotsEmpty)
  })

  it('AB-1 restore → bot.restore({fileName}); a refusal is shown, the next success clears it', async () => {
    api.bot.listArchived.mockResolvedValue([row('scout', 1)])
    await mount()
    api.bot.restore.mockResolvedValueOnce({
      success: false,
      error: 'A bot named "scout" is already in use'
    })
    await click(rowOf('scout.md').querySelector('[data-archived-bot-restore]')!)
    expect(api.bot.restore.mock.calls).toEqual([[{ fileName: 'scout.md' }]])
    expect(errorText()).toBe('A bot named "scout" is already in use')

    await click(rowOf('scout.md').querySelector('[data-archived-bot-restore]')!)
    expect(errorText()).toBeNull()
    // 恢复之后清单靠 bot.changed 刷新，这里不自己再拉
    expect(api.bot.listArchived).toHaveBeenCalledTimes(1)
  })

  it('AB-1 delete asks first (name + count); cancel deletes nothing', async () => {
    api.bot.listArchived.mockResolvedValue([row('scout', 4, 'Scout')])
    await mount()
    expect($('[data-confirm]')).toBeNull()
    await click(rowOf('scout.md').querySelector('[data-archived-bot-delete]')!)
    const confirm = rec.confirms.at(-1)!
    expect(confirm.title).toBe(i18n.t('settings.archivedBotDeleteTitle', { name: 'Scout' }))
    expect(confirm.description).toBe(i18n.t('settings.archivedBotDeleteDesc', { count: 4 }))
    expect(String(confirm.description)).toContain('4')
    expect($('[data-confirm]')).not.toBeNull()

    await act(async () => {
      ;(confirm.onCancel as () => void)()
    })
    await flush()
    expect($('[data-confirm]')).toBeNull()
    expect(api.bot.deleteArchived).not.toHaveBeenCalled()
  })

  it('AB-1 confirmed → bot.deleteArchived({fileName}) and the dialog closes; a failure is shown', async () => {
    api.bot.listArchived.mockResolvedValue([row('scout', 2)])
    await mount()
    await click(rowOf('scout.md').querySelector('[data-archived-bot-delete]')!)
    await act(async () => {
      await (rec.confirms.at(-1)!.onConfirm as () => Promise<void>)()
    })
    await flush()
    expect(api.bot.deleteArchived.mock.calls).toEqual([[{ fileName: 'scout.md' }]])
    expect($('[data-confirm]')).toBeNull()
    expect(errorText()).toBeNull()

    api.bot.deleteArchived.mockResolvedValueOnce({ success: false, error: 'EBUSY' })
    await click(rowOf('scout.md').querySelector('[data-archived-bot-delete]')!)
    await act(async () => {
      await (rec.confirms.at(-1)!.onConfirm as () => Promise<void>)()
    })
    await flush()
    expect(errorText()).toBe('EBUSY')
    expect($('[data-confirm]')).toBeNull()
  })

  it('AB-1 bot.changed reloads the list; other events do not; unmount unsubscribes', async () => {
    api.bot.listArchived.mockResolvedValueOnce([row('scout', 1)])
    await mount()
    expect(api.events.subscribe).toHaveBeenCalledTimes(1)

    await emit('project.changed')
    expect(api.bot.listArchived).toHaveBeenCalledTimes(1)

    api.bot.listArchived.mockResolvedValueOnce([])
    await emit('bot.changed')
    expect(api.bot.listArchived).toHaveBeenCalledTimes(2)
    expect($('[data-archived-bot="scout.md"]')).toBeNull()
    expect(container.textContent).toContain(en.settings.archivedBotsEmpty)

    act(() => root.unmount())
    expect(unsubscribed).toBe(1)
    // afterEach 再卸一次不报错
    root = createRoot(container)
  })
})
