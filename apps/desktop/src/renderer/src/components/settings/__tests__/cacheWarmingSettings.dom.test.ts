// @vitest-environment jsdom
/**
 * Prompt Cache 后台保活设置开关 DOM 测试（CW-UI01..03）：
 *
 *   - CW-UI01：异步读取未 resolve 前不渲染；resolve 'true' 渲染实验标签与开启态 Toggle；
 *              resolve undefined/'false'/非法字符串渲染关闭态
 *   - CW-UI02：settings.get reject 兜底为关闭态正常渲染；点击切换持久化写入 session.cacheWarming
 *   - CW-UI03：挂载后未 resolve 即 unmount()，随后 resolve / reject 无异常
 */
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { CacheWarmingSettings } from '../CacheWarmingSettings'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

const ENABLED_KEY = 'session.cacheWarming'

let api: FakeApi
let get: Mock<(key: string) => Promise<unknown>>
let stored: Record<string, string | undefined>
let m: Mounted | null = null

async function mount(): Promise<void> {
  m = await mountInto(CacheWarmingSettings, {})
  await flush()
}

const row = (): Element | null => m!.container.querySelector('[data-cache-warming-row="enabled"]')

const toggle = (): HTMLButtonElement => {
  const el = row()
  if (!el) throw new Error('no cache-warming enabled row')
  const buttons = el.querySelectorAll<HTMLButtonElement>('.shrink-0 button')
  return buttons[buttons.length - 1]
}

const isOn = (): boolean => {
  const { classList } = toggle()
  expect(classList.contains('bg-accent')).not.toBe(classList.contains('bg-bg-hover'))
  return classList.contains('bg-accent')
}

const setCalls = (): unknown[] => api.settings.set.mock.calls.map((args) => args[0])

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  stored = {}
  api = installFakeApi()
  get = vi.fn(async (key: string) => stored[key])
  Object.assign(api.settings, { get })
})

afterEach(() => {
  m?.unmount()
  m = null
  document.body.innerHTML = ''
})

describe('CacheWarmingSettings', () => {
  it('CW-UI01 异步读取未 resolve 前不渲染；resolve "true" 渲染实验标签与开启态 Toggle', async () => {
    let resolveGet!: (value: unknown) => void
    get.mockImplementation(() => new Promise((resolve) => (resolveGet = resolve)))

    await mount()

    expect(m!.container.firstChild).toBeNull()
    expect(get).toHaveBeenCalledWith(ENABLED_KEY)

    await act(async () => {
      resolveGet('true')
    })
    await flush()

    expect(m!.container.firstChild).not.toBeNull()
    expect(row()).not.toBeNull()
    expect(isOn()).toBe(true)

    const heading = m!.container.querySelector('h3')
    expect(heading).not.toBeNull()
    expect(heading!.textContent).toContain(en.settings.cacheWarmingSection)
    const tag = heading!.querySelector('[data-experimental="cacheWarming"]')
    expect(tag).not.toBeNull()
    expect(tag!.textContent).toBe(en.experimental.tag)
  })

  it.each([
    ['undefined', undefined],
    ['"false"', 'false'],
    ['非法字符串', 'yes']
  ] as const)('CW-UI01 resolve %s 渲染关闭态 Toggle', async (_label, val) => {
    stored[ENABLED_KEY] = val

    await mount()

    expect(row()).not.toBeNull()
    expect(isOn()).toBe(false)
  })

  it('CW-UI02 settings.get reject 兜底为关闭态正常渲染；点击切换持久化写入 session.cacheWarming', async () => {
    get.mockRejectedValueOnce(new Error('db unavailable'))

    await mount()

    expect(row()).not.toBeNull()
    expect(isOn()).toBe(false)

    // 切换为开 → 写 'true'
    click(toggle())
    expect(isOn()).toBe(true)
    expect(setCalls()).toEqual([{ key: ENABLED_KEY, value: 'true' }])

    // 切换为关 → 写 'false'
    click(toggle())
    expect(isOn()).toBe(false)
    expect(setCalls()).toEqual([
      { key: ENABLED_KEY, value: 'true' },
      { key: ENABLED_KEY, value: 'false' }
    ])
  })

  it('CW-UI03 挂载后未 resolve 即 unmount()，随后 resolve 与 reject 均无异常', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 1) unmount 后 resolve
    {
      let resolveGet!: (value: unknown) => void
      get.mockImplementationOnce(() => new Promise((resolve) => (resolveGet = resolve)))

      await mount()
      expect(m!.container.firstChild).toBeNull()

      m!.unmount()
      m = null

      await act(async () => {
        resolveGet('true')
      })
      await flush()
    }

    // 2) unmount 后 reject
    {
      let rejectGet!: (err: unknown) => void
      get.mockImplementationOnce(() => new Promise((_resolve, reject) => (rejectGet = reject)))

      await mount()
      expect(m!.container.firstChild).toBeNull()

      m!.unmount()
      m = null

      await act(async () => {
        rejectGet(new Error('late failure'))
      })
      await flush()
    }

    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
