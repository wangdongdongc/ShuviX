// @vitest-environment jsdom
/**
 * 设置 → 通用 → 安全：自动审查开关（AutoReviewSettings）。
 *
 * 开关背后是主进程现读的 `security.autoReview`：缺省开，只有（trim 之后）字面 'false' 才关。这里钉的是
 * 渲染层这一半与那条约定对齐：
 *   - 读到之前按缺省（开）画，免得先闪一下「关」；读到之后只有 'false' 才关；
 *   - 点一下立刻换画法并写一次设置，挂载本身不写；
 *   - 用户先点、读取后到：以用户点的为准；读取失败：保持开，不留未处理的 rejection。
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（node 环境为主，本文件自己切 jsdom），也不带 react 插件 ——
 * 所以不写 JSX、一律 createElement；app-shell 的设置原语整个 mock 掉：Toggle 画成带 data-on 的按钮，
 * SettingsSection / SettingsRow 把标题与说明放到 data 属性上。i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'

vi.mock('../SettingsPrimitives', async () => {
  const { createElement: h } = await import('react')
  return {
    SettingsSection: ({ title, children }: { title?: ReactNode; children?: ReactNode }) =>
      h('section', { 'data-section-title': title }, children),
    SettingsRow: ({
      title,
      description,
      control
    }: {
      title?: ReactNode
      description?: ReactNode
      control?: ReactNode
    }) => h('div', { 'data-row-title': title, 'data-row-description': description }, control),
    Toggle: ({ on, onClick }: { on: boolean; onClick: () => void }) =>
      h('button', { 'data-on': String(on), onClick })
  }
})

import { AutoReviewSettings } from '../AutoReviewSettings'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'security.autoReview'

const api = {
  get: vi.fn<(key: string) => Promise<string | undefined>>(),
  set: vi.fn<(params: { key: string; value: string }) => Promise<{ success: boolean }>>()
}

let container: HTMLDivElement
let root: Root

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  ;(window as unknown as { api: unknown }).api = { settings: api }
})

beforeEach(() => {
  api.get.mockReset()
  api.set.mockReset().mockResolvedValue({ success: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function mount(): void {
  act(() => {
    root.render(createElement(AutoReviewSettings))
  })
}

/** 让读取的 promise 落定、React 把结果画出来 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const toggle = (): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>('button[data-on]')
  if (!el) throw new Error('toggle not rendered')
  return el
}
const isOn = (): boolean => toggle().getAttribute('data-on') === 'true'
const click = (): void => act(() => toggle().click())

/** 手动落定的读取 */
function deferredGet(): {
  resolve: (value: string | undefined) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: string | undefined) => void
  let reject!: (err: unknown) => void
  api.get.mockImplementation(
    () =>
      new Promise<string | undefined>((res, rej) => {
        resolve = res
        reject = rej
      })
  )
  return { resolve: (v) => resolve(v), reject: (e) => reject(e) }
}

describe('AutoReviewSettings — 自动审查开关', () => {
  it('AR-1 读取还没返回时，开关画成开', () => {
    deferredGet()
    mount()
    expect(isOn()).toBe(true)
  })

  it.each<[string, string | undefined, boolean]>([
    ['undefined（从没设过）', undefined, true],
    ["'true'", 'true', true],
    ["'false'", 'false', false]
  ])('AR-2 读取返回 %s → 开关%s', async (_label, value, expected) => {
    api.get.mockResolvedValue(value)
    mount()
    await settle()
    expect(isOn()).toBe(expected)
  })

  it.each<[string, boolean]>([
    [' false ', false],
    ['FALSE', true],
    ['0', true],
    ['', true],
    ['off', true]
  ])("AR-3 只有 trim 之后等于 'false' 才关：%j → 开=%s", async (value, expected) => {
    api.get.mockResolvedValue(value)
    mount()
    await settle()
    expect(isOn()).toBe(expected)
  })

  it("AR-4 点一下立刻显示关、写一次 {key, value:'false'}；再点显示开、写 'true'", async () => {
    api.get.mockResolvedValue(undefined)
    mount()
    await settle()
    expect(isOn()).toBe(true)

    click()
    expect(isOn()).toBe(false)
    expect(api.set).toHaveBeenCalledTimes(1)
    expect(api.set).toHaveBeenLastCalledWith({ key: KEY, value: 'false' })

    click()
    expect(isOn()).toBe(true)
    expect(api.set).toHaveBeenCalledTimes(2)
    expect(api.set).toHaveBeenLastCalledWith({ key: KEY, value: 'true' })
  })

  it("AR-5 挂载时读取恰一次（参数 'security.autoReview'）；挂载过程不写", async () => {
    api.get.mockResolvedValue('false')
    mount()
    await settle()
    expect(api.get).toHaveBeenCalledTimes(1)
    expect(api.get).toHaveBeenCalledWith(KEY)
    expect(api.set).not.toHaveBeenCalled()
  })

  it('AR-6 根节点带 data-auto-review-settings；section 标题、行标题、说明对应那三个 i18n 键', async () => {
    api.get.mockResolvedValue(undefined)
    mount()
    await settle()
    const expected = (key: string): string => {
      const text = i18n.t(key)
      expect(text, key).not.toBe(key)
      return text
    }
    const rootEl = container.querySelector('[data-auto-review-settings]')
    expect(rootEl).not.toBeNull()
    expect(rootEl!.querySelector('section')!.getAttribute('data-section-title')).toBe(
      expected('settings.securitySection')
    )
    const row = rootEl!.querySelector('[data-row-title]')!
    expect(row.getAttribute('data-row-title')).toBe(expected('settings.autoReview'))
    expect(row.getAttribute('data-row-description')).toBe(expected('settings.autoReviewHint'))
    expect(row.contains(toggle())).toBe(true)
  })

  it('AR-7 先点击、读取后到（以 undefined 返回）：开关仍显示关（用户点的为准）', async () => {
    const get = deferredGet()
    mount()
    expect(isOn()).toBe(true)

    click()
    expect(isOn()).toBe(false)

    get.resolve(undefined)
    await settle()
    expect(isOn()).toBe(false)
    expect(api.set).toHaveBeenCalledTimes(1)
    expect(api.set).toHaveBeenLastCalledWith({ key: KEY, value: 'false' })
  })

  it('AR-8 读取 reject：不留未处理的 rejection，开关保持开', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const get = deferredGet()
      mount()
      get.reject(new Error('ipc down'))
      await settle()
      await settle()
      expect(isOn()).toBe(true)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
