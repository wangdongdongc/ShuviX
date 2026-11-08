// @vitest-environment jsdom
/**
 * 设置 → 通用 → 通知：一类一个开关，存在 `notification.<kind>`，只有字面 'false' 才算关。
 *
 *   NK-D1 读到之前不画：没有先画「开」再跳成「关」
 *   NK-D2 缺省：四行按 ask / done / failed / goal 排，文案是真 en 资源，都开着；只读这四个键，打开不写
 *   NK-D3 读回来的值：只有 'false' 是关；'true'、空串、'FALSE'、'0' 都是开
 *   NK-D4 点开关：每点一次写一次，值是字符串 'false' / 'true'，键是这一类的；别的行不动
 *   NK-D5 连着点不同的行：每次都基于最新状态，三次写入各自对
 *   NK-D6 问号：聚焦某一行的问号，气泡里是这一类的说明
 *   NK-D7 GeneralSettings：桌面有这一节；web 客户端没有，也不读这几个键（通知弹在跑 ShuviX 的那台机器上）
 *
 * Toggle 没有 aria 状态，开关看 `bg-accent` / `bg-bg-hover`。说明只在气泡里，所以一行的 textContent 就是标题。
 */
import { act, type FunctionComponent } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import type { AgentNotificationKind } from '@shuvix/chat-protocol/notification'

const mocks = vi.hoisted(() => ({ web: false }))
vi.mock('../../../host/hostMedia', () => ({
  get isWebHost() {
    return mocks.web
  }
}))
vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  return {
    AppearanceTab: () => h('div', { 'data-stub-appearance': '' }),
    ModelDefaultsSettings: () => h('div', { 'data-stub-model-defaults': '' })
  }
})
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: () => ({ availableModels: [] })
}))
vi.mock('../../../mobile/useCompactLayout', () => ({ useCompactLayout: () => false }))

import { NotificationSettings } from '../NotificationSettings'
import { GeneralSettings } from '../GeneralSettings'
import {
  click,
  flush,
  initEnI18n,
  installFakeApi,
  mountInto,
  type FakeApi,
  type Mounted
} from '../../browser/__tests__/browserDomSupport'

const KINDS: AgentNotificationKind[] = ['ask', 'done', 'failed', 'goal']
const KEYS = [
  'notification.ask',
  'notification.done',
  'notification.failed',
  'notification.goal'
]

let api: FakeApi
let get: Mock<(key: string) => Promise<unknown>>
let stored: Record<string, string>
let m: Mounted | null = null

async function mount(component: FunctionComponent<object> = NotificationSettings): Promise<void> {
  m = await mountInto(component, {})
  await flush()
}

const section = (): Element | null => m!.container.querySelector('[data-notification-settings]')
const row = (kind: AgentNotificationKind): Element => {
  const el = m!.container.querySelector(`[data-notification-kind="${kind}"]`)
  if (!el) throw new Error(`no row ${kind}`)
  return el
}
/** 问号也是 button，但不在 .shrink-0 底下；控件区里最后一个 button 才是开关 */
const toggle = (kind: AgentNotificationKind): HTMLButtonElement => {
  const buttons = row(kind).querySelectorAll<HTMLButtonElement>('.shrink-0 button')
  return buttons[buttons.length - 1]
}
const isOn = (kind: AgentNotificationKind): boolean => {
  const { classList } = toggle(kind)
  expect(classList.contains('bg-accent')).not.toBe(classList.contains('bg-bg-hover'))
  return classList.contains('bg-accent')
}
const states = (): boolean[] => KINDS.map(isOn)
const setCalls = (): unknown[] => api.settings.set.mock.calls.map((args) => args[0])

beforeAll(async () => {
  await initEnI18n()
})

beforeEach(() => {
  mocks.web = false
  stored = {}
  api = installFakeApi()
  get = vi.fn(async (key: string) => stored[key])
  Object.assign(api.settings, { get })
  Object.assign(window.api, { provider: { listClassifierModels: vi.fn(async () => []) } })
})

afterEach(() => {
  m?.unmount()
  m = null
  document.body.innerHTML = ''
})

describe('NotificationSettings', () => {
  it('NK-D1 四个值都读到之前不画；画出来的第一帧 done 就是关', async () => {
    const resolvers: Record<string, (value: unknown) => void> = {}
    get.mockImplementation((key) => new Promise((resolve) => (resolvers[key] = resolve)))
    await mount()
    expect(section()).toBeNull()

    await act(async () => {
      resolvers['notification.ask'](undefined)
      resolvers['notification.failed'](undefined)
      resolvers['notification.goal'](undefined)
    })
    await flush()
    expect(section()).toBeNull()

    await act(async () => {
      resolvers['notification.done']('false')
    })
    await flush()
    expect(section()).not.toBeNull()
    expect(states()).toEqual([true, false, true, true])
  })

  it('NK-D2 缺省：四行的顺序与文案、都开着；只读这四个键，不写', async () => {
    await mount()
    expect(section()!.querySelector('h3')!.textContent).toBe('Notifications')

    const rows = [...section()!.querySelectorAll('[data-notification-kind]')]
    expect(rows.map((el) => el.getAttribute('data-notification-kind'))).toEqual(KINDS)
    expect(rows.map((el) => el.textContent)).toEqual([
      'Waiting for you',
      'Run finished',
      'Run failed',
      'Goal ended or paused'
    ])

    expect(states()).toEqual([true, true, true, true])
    expect(get.mock.calls.map(([key]) => key)).toEqual(KEYS)
    expect(api.settings.set).not.toHaveBeenCalled()
  })

  it.each([
    ['false', false],
    ['true', true],
    ['', true],
    ['FALSE', true],
    ['0', true]
  ])('NK-D3 notification.done = %j → 开着 = %s；另外三类还开着', async (value, on) => {
    stored['notification.done'] = value
    await mount()
    expect(states()).toEqual([true, on, true, true])
  })

  it("NK-D4 点两下 done：写 'false' 再写 'true'，都是字符串；只有这一行变", async () => {
    await mount()

    click(toggle('done'))
    expect(states()).toEqual([true, false, true, true])
    expect(setCalls()).toEqual([{ key: 'notification.done', value: 'false' }])

    click(toggle('done'))
    expect(states()).toEqual([true, true, true, true])
    expect(setCalls()).toEqual([
      { key: 'notification.done', value: 'false' },
      { key: 'notification.done', value: 'true' }
    ])
  })

  it('NK-D5 存着 done 关：依次点 ask、failed、done，每次都基于最新状态', async () => {
    stored['notification.done'] = 'false'
    await mount()

    click(toggle('ask'))
    click(toggle('failed'))
    click(toggle('done'))

    expect(states()).toEqual([false, true, false, true])
    expect(setCalls()).toEqual([
      { key: 'notification.ask', value: 'false' },
      { key: 'notification.failed', value: 'false' },
      { key: 'notification.done', value: 'true' }
    ])
  })

  it.each([
    ['ask', en.settings.notificationAskHint],
    ['done', en.settings.notificationDoneHint],
    ['failed', en.settings.notificationFailedHint]
  ] as const)('NK-D6 聚焦 %s 行的问号：气泡是它的说明', async (kind, hint) => {
    await mount()
    const button = row(kind).querySelector<HTMLButtonElement>('[data-info-hint]')!
    expect(document.body.querySelector('[data-info-tip]')).toBeNull()

    act(() => button.focus())
    expect(document.body.querySelector('[data-info-tip]')!.textContent).toBe(hint)

    act(() => button.blur())
    expect(document.body.querySelector('[data-info-tip]')).toBeNull()
  })
})

describe('GeneralSettings', () => {
  const notificationReads = (): unknown[] =>
    get.mock.calls.map(([key]) => key).filter((key) => key.startsWith('notification.'))

  it('NK-D7a 桌面：有通知这一节，读这四个键', async () => {
    await mount(GeneralSettings)
    expect(section()).not.toBeNull()
    expect(notificationReads()).toEqual(KEYS)
  })

  it('NK-D7b web 客户端：没有这一节、不读这几个键，其余照常', async () => {
    mocks.web = true
    await mount(GeneralSettings)
    expect(section()).toBeNull()
    expect(notificationReads()).toEqual([])
    expect(m!.container.querySelector('[data-stub-appearance]')).not.toBeNull()
  })
})
