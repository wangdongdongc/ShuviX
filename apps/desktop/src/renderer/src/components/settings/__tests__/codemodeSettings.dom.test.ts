// @vitest-environment jsdom
/**
 * Codemode Phase 2 · 设置页两级实验开关 DOM 测试（CM2-UI-01..06）：
 *
 *   - CM2-UI-01：异步读取未 resolve 前不渲染（container.firstChild === null），且已发起两次 settings.get
 *   - CM2-UI-02：主开关关闭（undefined / 'false'）只渲染 enabled 行、不渲染 mcpOnly 行、主开关关闭且标题含实验标签
 *   - CM2-UI-03：主开关打开时渲染两行并正确反映 ('true','false') 与 ('true','true') 初始态
 *   - CM2-UI-04：初始 ('false','true')，开关主开关时保留子开关内存态且不误写 session.codemodeMcpOnly
 *   - CM2-UI-05：主开关打开时独立切换子开关开/关，持久化写入 session.codemodeMcpOnly，主开关不受影响
 *   - CM2-UI-06：挂载后未 resolve 即 unmount()，随后 resolve Promise 无异常
 */
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import { CodemodeSettings } from '../CodemodeSettings'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

const ENABLED_KEY = 'session.codemode'
const MCP_ONLY_KEY = 'session.codemodeMcpOnly'

let api: FakeApi
let get: Mock<(key: string) => Promise<unknown>>
let stored: Record<string, string | undefined>
let m: Mounted | null = null

async function mount(): Promise<void> {
  m = await mountInto(CodemodeSettings, {})
  await flush()
}

const row = (kind: 'enabled' | 'mcpOnly'): Element | null =>
  m!.container.querySelector(`[data-codemode-row="${kind}"]`)

const toggle = (kind: 'enabled' | 'mcpOnly'): HTMLButtonElement => {
  const el = row(kind)
  if (!el) throw new Error(`no row ${kind}`)
  const buttons = el.querySelectorAll<HTMLButtonElement>('.shrink-0 button')
  return buttons[buttons.length - 1]
}

const isOn = (kind: 'enabled' | 'mcpOnly'): boolean => {
  const { classList } = toggle(kind)
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

describe('CodemodeSettings', () => {
  it('CM2-UI-01 异步读取未 resolve 前不渲染，且已发起对 session.codemode 与 session.codemodeMcpOnly 的两次读取', async () => {
    const resolvers: Record<string, (value: unknown) => void> = {}
    get.mockImplementation((key) => new Promise((resolve) => (resolvers[key] = resolve)))

    await mount()

    expect(m!.container.firstChild).toBeNull()
    expect(get.mock.calls.map(([key]) => key)).toEqual([ENABLED_KEY, MCP_ONLY_KEY])

    // 仅 resolve 一个时仍不渲染
    await act(async () => {
      resolvers[ENABLED_KEY]('true')
    })
    await flush()
    expect(m!.container.firstChild).toBeNull()

    // 两个都 resolve 后渲染
    await act(async () => {
      resolvers[MCP_ONLY_KEY]('false')
    })
    await flush()
    expect(m!.container.firstChild).not.toBeNull()
  })

  it.each([
    ['undefined', undefined],
    ['"false"', 'false']
  ] as const)(
    'CM2-UI-02 主开关关闭（%s）时只渲染 enabled 行、不渲染 mcpOnly 行、主开关关闭且标题含实验标签',
    async (_label, enabledVal) => {
      stored[ENABLED_KEY] = enabledVal
      stored[MCP_ONLY_KEY] = 'false'

      await mount()

      expect(row('enabled')).not.toBeNull()
      expect(row('mcpOnly')).toBeNull()
      expect(isOn('enabled')).toBe(false)

      const heading = m!.container.querySelector('h3')
      expect(heading).not.toBeNull()
      expect(heading!.textContent).toContain(en.settings.codemodeSection)
      const tag = heading!.querySelector('[data-experimental="codemode"]')
      expect(tag).not.toBeNull()
      expect(tag!.textContent).toBe(en.experimental.tag)
    }
  )

  it.each([
    ['false', false],
    ['true', true]
  ] as const)(
    'CM2-UI-03 主开关打开时渲染两行并正确反映初始态 ("true", %j)',
    async (mcpOnlyVal, expectedMcpOnly) => {
      stored[ENABLED_KEY] = 'true'
      stored[MCP_ONLY_KEY] = mcpOnlyVal

      await mount()

      expect(row('enabled')).not.toBeNull()
      expect(row('mcpOnly')).not.toBeNull()
      expect(isOn('enabled')).toBe(true)
      expect(isOn('mcpOnly')).toBe(expectedMcpOnly)
    }
  )

  it('CM2-UI-04 初始 ("false", "true")：开关主开关时子行显隐且保留开启态，不误写 session.codemodeMcpOnly', async () => {
    stored[ENABLED_KEY] = 'false'
    stored[MCP_ONLY_KEY] = 'true'

    await mount()
    expect(row('enabled')).not.toBeNull()
    expect(row('mcpOnly')).toBeNull()

    // 打开主开关 → 写 session.codemode = 'true'，子行出现且保持开启
    click(toggle('enabled'))
    expect(isOn('enabled')).toBe(true)
    expect(row('mcpOnly')).not.toBeNull()
    expect(isOn('mcpOnly')).toBe(true)
    expect(setCalls()).toEqual([{ key: ENABLED_KEY, value: 'true' }])

    // 关闭主开关 → 写 session.codemode = 'false'，子行消失且不误写 session.codemodeMcpOnly
    click(toggle('enabled'))
    expect(isOn('enabled')).toBe(false)
    expect(row('mcpOnly')).toBeNull()
    expect(setCalls()).toEqual([
      { key: ENABLED_KEY, value: 'true' },
      { key: ENABLED_KEY, value: 'false' }
    ])

    // 再次打开 → 子行仍保持开启
    click(toggle('enabled'))
    expect(isOn('enabled')).toBe(true)
    expect(row('mcpOnly')).not.toBeNull()
    expect(isOn('mcpOnly')).toBe(true)
    expect(setCalls()).toEqual([
      { key: ENABLED_KEY, value: 'true' },
      { key: ENABLED_KEY, value: 'false' },
      { key: ENABLED_KEY, value: 'true' }
    ])
  })

  it('CM2-UI-05 主开关打开时独立切换子开关开/关 → 持久化写入 session.codemodeMcpOnly，主开关不受影响', async () => {
    stored[ENABLED_KEY] = 'true'
    stored[MCP_ONLY_KEY] = 'false'

    await mount()
    expect(isOn('enabled')).toBe(true)
    expect(isOn('mcpOnly')).toBe(false)

    // 开启子开关
    click(toggle('mcpOnly'))
    expect(isOn('enabled')).toBe(true)
    expect(isOn('mcpOnly')).toBe(true)
    expect(setCalls()).toEqual([{ key: MCP_ONLY_KEY, value: 'true' }])

    // 关闭子开关
    click(toggle('mcpOnly'))
    expect(isOn('enabled')).toBe(true)
    expect(isOn('mcpOnly')).toBe(false)
    expect(setCalls()).toEqual([
      { key: MCP_ONLY_KEY, value: 'true' },
      { key: MCP_ONLY_KEY, value: 'false' }
    ])
  })

  it('CM2-UI-06 挂载后未 resolve 即 unmount()，随后 resolve Promise 无异常', async () => {
    const resolvers: Record<string, (value: unknown) => void> = {}
    get.mockImplementation((key) => new Promise((resolve) => (resolvers[key] = resolve)))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await mount()
    expect(m!.container.firstChild).toBeNull()

    m!.unmount()
    m = null

    await act(async () => {
      resolvers[ENABLED_KEY]('true')
      resolvers[MCP_ONLY_KEY]('true')
    })
    await flush()

    expect(errSpy).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})
