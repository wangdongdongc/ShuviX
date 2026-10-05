// @vitest-environment jsdom
/**
 * 设置 → 监视器 → LLM 请求日志：迁移期的「已暂停」横幅（HttpLogSettings，P3-13-25，PIN-10）。
 *
 * pi-durable 迁移期间请求日志不记录（`HTTP_LOG_RECORDING_PAUSED`）。这里钉的是：
 *   - `[data-monitor-paused]` 常显：开关关着、打开之后都在；
 *   - 开关照常可切，照常写 `httpLog.enabled`（'true' 再 'false'）—— 偏好留到 phase 5；
 *   - 开着时状态行从不说「记录中」（横幅替它说）；关着时照旧说「记录已关闭」；
 *   - 已有的日志照常可看（两行都画、展开一行就 `httpLog.get`）、可清（确认之后 `httpLog.clear`）。
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * 会话 / 提供商下拉、payload 查看器、确认框整个换成小替身（它们各自有测试）；开关画成带 data-on 的按钮。
 * i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'

vi.mock('../SettingsPrimitives', async () => {
  const { createElement: h } = await import('react')
  return {
    Toggle: ({ on, onClick }: { on: boolean; onClick: () => void }) =>
      h('button', { 'data-on': String(on), 'data-toggle': '', onClick })
  }
})
vi.mock('../PayloadViewer', async () => {
  const { createElement: h } = await import('react')
  return { PayloadViewer: ({ payload }: { payload: string }) => h('pre', { 'data-payload': '' }, payload) }
})
vi.mock('../../common/SessionPicker', async () => {
  const { createElement: h } = await import('react')
  return { SessionPicker: () => h('div', { 'data-session-picker': '' }) }
})
vi.mock('../../common/ZenSelect', async () => {
  const { createElement: h } = await import('react')
  return { ZenSelect: () => h('div', { 'data-zen-select': '' }) }
})
vi.mock('../../common/ConfirmDialog', async () => {
  const { createElement: h } = await import('react')
  return {
    ConfirmDialog: ({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) =>
      h(
        'div',
        { 'data-confirm': '' },
        h('button', { 'data-confirm-ok': '', onClick: onConfirm }),
        h('button', { 'data-confirm-cancel': '', onClick: onCancel })
      )
  }
})

import { HttpLogSettings } from '../HttpLogSettings'
import { HTTP_LOG_RECORDING_PAUSED } from '@shuvix/chat-protocol/httpLog'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'httpLog.enabled'

const ROWS = [
  {
    id: 'log-1',
    sessionId: 's1',
    sessionTitle: 'First',
    provider: 'p',
    providerName: 'P',
    model: 'm1',
    inputTokens: 10,
    outputTokens: 2,
    totalTokens: 12,
    payloadBytes: 100,
    createdAt: 1
  },
  {
    id: 'log-2',
    sessionId: 's2',
    sessionTitle: 'Second',
    provider: 'p',
    providerName: 'P',
    model: 'm2',
    inputTokens: 20,
    outputTokens: 3,
    totalTokens: 23,
    payloadBytes: 200,
    createdAt: 2
  }
]

const api = {
  settings: {
    get: vi.fn<(key: string) => Promise<string | undefined>>(),
    set: vi.fn<(params: { key: string; value: string }) => Promise<{ success: boolean }>>()
  },
  httpLog: {
    list: vi.fn<(params: unknown) => Promise<typeof ROWS>>(),
    get: vi.fn<(id: string) => Promise<unknown>>(),
    clear: vi.fn<() => Promise<void>>()
  },
  provider: { listAll: vi.fn<() => Promise<{ id: string; name: string }[]>>() }
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(HttpLogSettings))
  })
  await flush()
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    ;(el as HTMLElement).click()
  })
  await flush()
}

const tr = (key: string): string => {
  const text = i18n.t(key)
  expect(text, key).not.toBe(key)
  return text
}

const paused = (): HTMLElement | null => container.querySelector('[data-monitor-paused]')
const status = (): string =>
  (container.querySelector('[data-monitor-status]')?.textContent ?? '').trim()
const toggle = (): HTMLElement => container.querySelector('[data-toggle]')!

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  ;(window as unknown as { api: unknown }).api = api
})

beforeEach(() => {
  api.settings.get.mockReset().mockResolvedValue(undefined)
  api.settings.set.mockReset().mockResolvedValue({ success: true })
  api.httpLog.list.mockReset().mockResolvedValue(ROWS)
  api.httpLog.get.mockReset().mockImplementation(async (id) => ({
    id,
    sessionId: 's1',
    provider: 'p',
    model: 'm1',
    payload: `payload of ${id}`,
    response: '',
    createdAt: 1
  }))
  api.httpLog.clear.mockReset().mockResolvedValue(undefined)
  api.provider.listAll.mockReset().mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('P3-13-25 HttpLog paused banner (PIN-10)', () => {
  it('P3-13-25 the banner shows with the toggle off and stays after toggling on; the toggle still writes the setting', async () => {
    expect(HTTP_LOG_RECORDING_PAUSED).toBe(true)
    await mount()
    expect(paused()).not.toBeNull()
    expect(paused()!.textContent).toBe(tr('settings.httpLogPausedHint'))
    expect(toggle().getAttribute('data-on')).toBe('false')
    expect(status()).toBe(tr('settings.httpLogDisabledHint'))

    await click(toggle())
    expect(api.settings.set).toHaveBeenLastCalledWith({ key: KEY, value: 'true' })
    expect(toggle().getAttribute('data-on')).toBe('true')
    expect(paused()).not.toBeNull()
    expect(status()).not.toContain(tr('settings.httpLogRecordingHint'))
    expect(container.textContent).not.toContain(tr('settings.httpLogRecordingHint'))

    await click(toggle())
    expect(api.settings.set).toHaveBeenLastCalledWith({ key: KEY, value: 'false' })
    expect(api.settings.set).toHaveBeenCalledTimes(2)
    expect(paused()).not.toBeNull()
    expect(status()).toBe(tr('settings.httpLogDisabledHint'))
  })

  it('P3-13-25 a stored "true": the status row never says "Recording"', async () => {
    api.settings.get.mockResolvedValue('true')
    await mount()
    expect(toggle().getAttribute('data-on')).toBe('true')
    expect(paused()).not.toBeNull()
    expect(container.textContent).not.toContain(tr('settings.httpLogRecordingHint'))
  })

  it('P3-13-25 history stays viewable: both rows render, expanding one reads it; clear still clears after the confirm', async () => {
    await mount()
    const rows = container.querySelectorAll('[data-log-id]')
    expect([...rows].map((row) => row.getAttribute('data-log-id'))).toEqual(['log-1', 'log-2'])
    await click(rows[1]!.querySelector('button')!)
    expect(api.httpLog.get).toHaveBeenCalledWith('log-2')
    expect(container.querySelector('[data-payload]')!.textContent).toBe('payload of log-2')

    const clear = container.querySelector(`button[title="${tr('common.clear')}"]`)!
    await click(clear)
    expect(api.httpLog.clear).not.toHaveBeenCalled()
    await click(container.querySelector('[data-confirm-ok]')!)
    expect(api.httpLog.clear).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('[data-log-id]')).toHaveLength(0)
    expect(paused()).not.toBeNull()
  })
})
