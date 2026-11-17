// @vitest-environment jsdom
/**
 * 设置面板的叠放布局（components/settings/SettingsPanel.tsx 的 `stacked`，手机布局；jsdom）。
 *
 * 契约：`stacked` → 交给容器的分区是十一个固定分区 + `extraTabs`（排最后；带 `after` 的插在那个分区后面，
 * 2026-11-17），各带分组（basics / capabilities / experimental / maintenance / about）；分区列表露出来时取四个
 * 行尾的值（开着几家提供商、开着几台 MCP 服务器、远程访问开没开、内置浏览器开着几个标签页 —— 最后一个只有传了
 * id 为 `browser` 的额外分区才有地方画），`stackedValuesEpoch` 一变也重取一遍，每露出来一次取一次，零与取不到都不画，先前那一次迟到的回包不认；地址栏的 hash 点名了某个
 * 分区就直接进去（那时不取值）。不传 `stacked` → 桌面的容器参数，一个值都不取。
 *
 *   SP-1 分区的顺序与分组；额外分区排最后、带着给它的 group
 *   SP-2 实验标记只在语音 / 触发器 / Telegram Bots 上
 *   SP-3 / SP-4 三个值；零 → 不画
 *   SP-5 第一次就取不到：那一行没有值，另外两行照常
 *   SP-6 列表每露出来一次重取一次（进分区不取）
 *   SP-7 先前那一次迟到的回包不认
 *   SP-8 / SP-9 hash 点名了分区：直接进去、不取值；不认识的 hash → 列表
 *   SP-10 onStackedDepthChange 原样交给容器
 *   SP-11 点额外分区：不写 store；再点固定分区回到 store 那一条路
 *   SP-12 桌面：没有 stacked、可拖拽的头部、交通灯留白；没有值、不取值
 *   SP-13 重取失败：那一行先前的值撤掉（B5），另外两行照旧
 *
 * 手机布局的「浏览器」那一行（2026-11-17；编号另起，免得与上面的撞）：
 *   SP-B1 / B2 / B3 额外分区：不带 `after` 排最后；`after: 'mcp'` 紧跟在 mcp 后面；`after` 不认识 → 排最后
 *   SP-B4 两个额外分区一插一追加；同一个 `after` 的两个：后给的那个紧挨着锚点
 *   SP-B5 `after` 不往下传
 *   SP-B6 / B7 带 `onOpen` 的额外分区：函数原样交给容器，调它不离开列表、不写 store；不带的照旧进分区
 *   SP-B8 `browser` 那一行的值：3 → 「3 tabs」、1 → 「1 tab」、空 / 取不到 → 没有值，别的行照常
 *   SP-B9 桌面：额外分区（带 `after` / `onOpen` 也一样）不进左侧导航，不取标签页
 *   SP-B10 `stackedValuesEpoch` 变了：四个值重取一遍；没变不重取；不在列表上时变了也不取
 *
 * 容器（@shuvix/app-shell 的 SettingsContainer）换成记 props 的替身，各分区的内容组件都是空的；settingsStore 是
 * 一个只有 activeSettingsTab 的小 zustand store。文件是 `.ts`，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'

type Props = Record<string, unknown>
interface TabProps {
  id: string
  label: string
  onOpen?: () => void
  group?: string
  experimental?: string
  value?: unknown
}
interface StackedProps {
  showList: boolean
  onBack: () => void
  onDepthChange?: (depth: number) => void
}

const rec = vi.hoisted(() => ({
  container: [] as Array<Record<string, unknown>>,
  setTab: null as unknown as Mock<(tab: string) => void>
}))

vi.mock('@shuvix/app-shell', async () => {
  const { createElement: h } = await import('react')
  return {
    SettingsContainer: (props: Props) => {
      rec.container.push(props)
      return h('div', { 'data-stub-container': '' })
    }
  }
})
vi.mock('../../../stores/settingsStore', async () => {
  const { create } = await import('zustand')
  const { vi: v } = await import('vitest')
  interface State {
    activeSettingsTab: string
    setActiveSettingsTab: (tab: string) => void
  }
  const useSettingsStore = create<State>((set) => {
    rec.setTab = v.fn((tab: string) => set({ activeSettingsTab: tab }))
    return { activeSettingsTab: 'general', setActiveSettingsTab: rec.setTab }
  })
  return { useSettingsStore }
})
vi.mock('../GeneralSettings', () => ({ GeneralSettings: () => null }))
vi.mock('../ArchivedSettings', () => ({ ArchivedSettings: () => null }))
vi.mock('../ProviderSettings', () => ({ ProviderSettings: () => null }))
vi.mock('../MonitorSettings', () => ({
  MonitorSettings: () => null,
  MONITOR_SUB_TABS: new Set(['httpLogs', 'classifierLogs', 'appLog'])
}))
vi.mock('../AboutSettings', () => ({ AboutSettings: () => null }))
vi.mock('../McpSettings', () => ({ McpSettings: () => null }))
vi.mock('../NetworkAccessSettings', () => ({ NetworkAccessSettings: () => null }))
vi.mock('../ToolSettings', () => ({ ToolSettings: () => null }))
vi.mock('../TelegramBotsSettings', () => ({ TelegramBotsSettings: () => null }))
vi.mock('../VoiceSettings', () => ({ VoiceSettings: () => null }))
vi.mock('../TriggerSettings', () => ({ TriggerSettings: () => null }))

import { SettingsPanel, type SettingsPanelProps } from '../SettingsPanel'
import { useSettingsStore } from '../../../stores/settingsStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** SettingsPanel 的参数带缺省值（`= {}`），createElement 的重载认不出它的 props 类型 —— 显式收窄成必传 */
const Panel = SettingsPanel as (props: SettingsPanelProps) => React.JSX.Element

const FIXED_TABS = [
  'general',
  'providers',
  'tools',
  'mcp',
  'network',
  'voice',
  'triggers',
  'telegramBots',
  'monitor',
  'archived',
  'about'
]
const FIXED_GROUPS = [
  'basics',
  'basics',
  'capabilities',
  'capabilities',
  'capabilities',
  'experimental',
  'experimental',
  'experimental',
  'maintenance',
  'maintenance',
  'about'
]

const api = {
  provider: { listEnabled: vi.fn<() => Promise<unknown[]>>() },
  mcp: { list: vi.fn<() => Promise<Array<{ isEnabled: unknown }>>>() },
  network: { status: vi.fn<() => Promise<{ enabled: boolean }>>() },
  browserView: { listTabs: vi.fn<() => Promise<unknown[]>>() },
  app: { platform: 'darwin' }
}

let container: HTMLDivElement
let root: Root

/** 一个额外分区；`group` 给 null = 不带分组 */
const extraTab = (id = 'agents', group: string | null = 'maintenance'): TabProps & Props => ({
  id,
  label: `Extra ${id}`,
  ...(group === null ? {} : { group }),
  content: null
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}
async function render(props: SettingsPanelProps = {}): Promise<void> {
  act(() => root.render(createElement(Panel, props)))
  await flush()
}

const last = (): Record<string, unknown> => rec.container.at(-1)!
const tabs = (): TabProps[] => last().tabs as TabProps[]
const tab = (id: string): TabProps => {
  const found = tabs().find((t) => t.id === id)
  if (!found) throw new Error(`tab ${id} not passed`)
  return found
}
const stacked = (): StackedProps => last().stacked as StackedProps
async function changeTab(id: string): Promise<void> {
  act(() => (last().onTabChange as (id: string) => void)(id))
  await flush()
}
async function backToList(): Promise<void> {
  act(() => stacked().onBack())
  await flush()
}
const fetchCounts = (): number[] => [
  api.provider.listEnabled.mock.calls.length,
  api.mcp.list.mock.calls.length,
  api.network.status.mock.calls.length,
  api.browserView.listTabs.mock.calls.length
]

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  rec.container.length = 0
  rec.setTab.mockClear()
  useSettingsStore.setState({ activeSettingsTab: 'general' })
  api.provider.listEnabled.mockReset().mockResolvedValue(['x', 'y', 'z'])
  api.mcp.list
    .mockReset()
    .mockResolvedValue([{ isEnabled: true }, { isEnabled: false }, { isEnabled: 1 }])
  api.network.status.mockReset().mockResolvedValue({ enabled: true })
  api.browserView.listTabs.mockReset().mockResolvedValue([{ id: 't1' }, { id: 't2' }, { id: 't3' }])
  api.app.platform = 'darwin'
  ;(window as unknown as { api: unknown }).api = api
  window.location.hash = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.location.hash = ''
})

describe('SettingsPanel stacked: the tabs handed to the container', () => {
  it('SP-1 the eleven sections in order with their groups; extra tabs last, keeping the group they were given', async () => {
    await render({
      stacked: true,
      extraTabs: [extraTab('agents', 'maintenance'), extraTab('loose', null)] as never
    })
    expect(tabs().map((t) => t.id)).toEqual([...FIXED_TABS, 'agents', 'loose'])
    expect(tabs().map((t) => t.group)).toEqual([...FIXED_GROUPS, 'maintenance', undefined])
    expect(last().title).toBe(i18n.t('settings.title'))
    expect(stacked().showList).toBe(true)
    expect(last().activeTab).toBe('general')
  })

  it('SP-2 the experimental mark is on voice / triggers / telegramBots only', async () => {
    await render({ stacked: true, extraTabs: [extraTab()] as never })
    expect(
      tabs()
        .filter((t) => t.experimental !== undefined)
        .map((t) => [t.id, t.experimental])
    ).toEqual([
      ['voice', 'voice'],
      ['triggers', 'triggers'],
      ['telegramBots', 'telegramBots']
    ])
  })

  it('SP-10 onStackedDepthChange is handed to the container as is', async () => {
    const onStackedDepthChange = vi.fn()
    await render({ stacked: true, onStackedDepthChange })
    expect(stacked().onDepthChange).toBe(onStackedDepthChange)
  })

  it('SP-11 selecting an extra tab does not write the store; a fixed tab afterwards goes through the store again', async () => {
    await render({ stacked: true, extraTabs: [extraTab()] as never })
    await changeTab('agents')
    expect(last().activeTab).toBe('agents')
    expect(rec.setTab).not.toHaveBeenCalled()
    expect(stacked().showList).toBe(false)

    await backToList()
    expect(stacked().showList).toBe(true)
    await changeTab('general')
    expect(last().activeTab).toBe('general')
    expect(rec.setTab.mock.calls).toEqual([['general']])
    expect(stacked().showList).toBe(false)

    await backToList()
    await changeTab('mcp')
    expect(last().activeTab).toBe('mcp')
  })
})

describe('SettingsPanel stacked: the row values', () => {
  it('SP-3 enabled providers, enabled MCP servers, remote access on / off; no value key on the other tabs', async () => {
    await render({ stacked: true, extraTabs: [extraTab()] as never })
    expect(tab('providers').value).toBe(3)
    expect(tab('mcp').value).toBe(2)
    expect(tab('network').value).toBe(i18n.t('mobile.on'))
    for (const t of tabs()) {
      if (['providers', 'mcp', 'network'].includes(t.id)) continue
      expect('value' in t, t.id).toBe(false)
    }
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
  })

  it('SP-3 remote access off reads Off', async () => {
    api.network.status.mockResolvedValue({ enabled: false })
    await render({ stacked: true })
    expect(tab('network').value).toBe(i18n.t('mobile.off'))
    expect(i18n.t('mobile.off')).not.toBe(i18n.t('mobile.on'))
  })

  it('SP-4 zero is not shown: empty lists give no value', async () => {
    api.provider.listEnabled.mockResolvedValue([])
    api.mcp.list.mockResolvedValue([{ isEnabled: false }, { isEnabled: 0 }])
    await render({ stacked: true })
    expect(tab('providers').value).toBeUndefined()
    expect(tab('mcp').value).toBeUndefined()
    expect(tab('network').value).toBe(i18n.t('mobile.on'))

    act(() => root.unmount())
    root = createRoot(container)
    api.mcp.list.mockResolvedValue([])
    await render({ stacked: true })
    expect(tab('mcp').value).toBeUndefined()
  })

  it('SP-5 a failed first fetch: no value on that row, the other two still get theirs', async () => {
    api.provider.listEnabled.mockRejectedValue(new Error('offline'))
    await render({ stacked: true })
    expect(tab('providers').value).toBeUndefined()
    expect(tab('mcp').value).toBe(2)
    expect(tab('network').value).toBe(i18n.t('mobile.on'))
  })

  it('SP-5 every fetch failing leaves all three rows without a value', async () => {
    api.provider.listEnabled.mockRejectedValue(new Error('offline'))
    api.mcp.list.mockRejectedValue(new Error('offline'))
    api.network.status.mockRejectedValue(new Error('offline'))
    await render({ stacked: true })
    expect(tab('providers').value).toBeUndefined()
    expect(tab('mcp').value).toBeUndefined()
    expect(tab('network').value).toBeUndefined()
  })

  it('SP-6 fetched again each time the list shows, not when a section opens', async () => {
    await render({ stacked: true })
    expect(fetchCounts()).toEqual([1, 1, 1, 1])

    await changeTab('providers')
    expect(stacked().showList).toBe(false)
    expect(rec.setTab.mock.calls).toEqual([['providers']])
    expect(fetchCounts()).toEqual([1, 1, 1, 1])

    api.provider.listEnabled.mockResolvedValue(['only'])
    api.mcp.list.mockResolvedValue([{ isEnabled: true }, { isEnabled: true }, { isEnabled: true }])
    api.network.status.mockResolvedValue({ enabled: false })
    await backToList()
    expect(stacked().showList).toBe(true)
    expect(fetchCounts()).toEqual([2, 2, 2, 2])
    expect(tab('providers').value).toBe(1)
    expect(tab('mcp').value).toBe(3)
    expect(tab('network').value).toBe(i18n.t('mobile.off'))
  })

  it('SP-7 a late answer from an earlier showing of the list is dropped', async () => {
    let releaseFirst: (list: unknown[]) => void = () => {}
    api.provider.listEnabled.mockImplementationOnce(
      () =>
        new Promise<unknown[]>((resolve) => {
          releaseFirst = resolve
        })
    )
    await render({ stacked: true })
    expect('value' in tab('providers')).toBe(false)

    api.provider.listEnabled.mockResolvedValue([1, 2, 3, 4, 5])
    await changeTab('providers')
    await backToList()
    expect(tab('providers').value).toBe(5)

    await act(async () => {
      releaseFirst(Array.from({ length: 9 }))
    })
    await flush()
    expect(tab('providers').value).toBe(5)
  })

  it('SP-13 a failed refetch clears that row’s value; the other two keep theirs', async () => {
    await render({ stacked: true })
    expect(tab('providers').value).toBe(3)

    await changeTab('providers')
    api.provider.listEnabled.mockRejectedValue(new Error('offline'))
    await backToList()
    expect(fetchCounts()).toEqual([2, 2, 2, 2])
    expect(tab('providers').value).toBeUndefined()
    expect(tab('mcp').value).toBe(2)
    expect(tab('network').value).toBe(i18n.t('mobile.on'))
  })
})

describe('SettingsPanel stacked: the address hash', () => {
  it('SP-8 a hash naming a section opens it at once: no list, no fetch', async () => {
    window.location.hash = '#settings/providers'
    await render({ stacked: true })
    expect(stacked().showList).toBe(false)
    expect(rec.setTab.mock.calls).toEqual([['providers']])
    expect(last().activeTab).toBe('providers')
    expect(fetchCounts()).toEqual([0, 0, 0, 0])
    expect(tabs().some((t) => 'value' in t)).toBe(false)

    // 退回列表才取
    await backToList()
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
    expect(tab('providers').value).toBe(3)
  })

  it('SP-9 an unknown hash shows the list', async () => {
    window.location.hash = '#settings/nope'
    await render({ stacked: true })
    expect(stacked().showList).toBe(true)
    expect(rec.setTab).not.toHaveBeenCalled()
    expect(last().activeTab).toBe('general')
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
  })
})

describe('SettingsPanel on the desktop (no stacked)', () => {
  it('SP-12 no stacked prop, a draggable header, traffic-light room on darwin; the eleven tabs without values; nothing fetched', async () => {
    await render({ extraTabs: [extraTab()] as never })
    expect(last().stacked).toBeUndefined()
    expect(last().draggableHeader).toBe(true)
    expect(last().macTrafficLights).toBe(true)
    expect(tabs().map((t) => t.id)).toEqual(FIXED_TABS)
    expect(tabs().some((t) => 'value' in t)).toBe(false)
    expect(fetchCounts()).toEqual([0, 0, 0, 0])

    await changeTab('mcp')
    expect(rec.setTab.mock.calls).toEqual([['mcp']])
    expect(last().activeTab).toBe('mcp')
    expect(last().stacked).toBeUndefined()
    expect(fetchCounts()).toEqual([0, 0, 0, 0])
  })

  it('SP-12 no traffic-light room off darwin', async () => {
    api.app.platform = 'linux'
    await render()
    expect(last().macTrafficLights).toBe(false)
    expect(last().draggableHeader).toBe(true)
  })
})

describe('SettingsPanel stacked: extra tabs placed with `after`, opened with `onOpen`', () => {
  const browserTab = (extra: Props = {}): TabProps & Props => ({
    ...extraTab('browser', 'capabilities'),
    ...extra
  })
  const ids = (): string[] => tabs().map((t) => t.id)
  const withAfter = (anchor: string, ...added: string[]): string[] => {
    const at = FIXED_TABS.indexOf(anchor)
    return [...FIXED_TABS.slice(0, at + 1), ...added, ...FIXED_TABS.slice(at + 1)]
  }

  it('SP-B1 an extra tab without `after` is the last row', async () => {
    await render({ stacked: true, extraTabs: [browserTab()] as never })
    expect(ids()).toEqual([...FIXED_TABS, 'browser'])
  })

  it('SP-B2 `after: mcp` puts it right after mcp, before network', async () => {
    await render({ stacked: true, extraTabs: [browserTab({ after: 'mcp' })] as never })
    expect(ids()).toEqual(withAfter('mcp', 'browser'))
    expect(ids()[ids().indexOf('browser') + 1]).toBe('network')
    expect(tab('browser').group).toBe('capabilities')
  })

  it('SP-B3 an `after` naming no section appends the tab at the end', async () => {
    await render({ stacked: true, extraTabs: [browserTab({ after: 'nope' })] as never })
    expect(ids()).toEqual([...FIXED_TABS, 'browser'])
  })

  it('SP-B4 one inserted and one appended; of two with the same `after` the later one sits next to the anchor', async () => {
    await render({
      stacked: true,
      extraTabs: [browserTab({ after: 'mcp' }), extraTab('agents')] as never
    })
    expect(ids()).toEqual([...withAfter('mcp', 'browser'), 'agents'])

    act(() => root.unmount())
    root = createRoot(container)
    await render({
      stacked: true,
      extraTabs: [
        { ...extraTab('first'), after: 'mcp' },
        { ...extraTab('second'), after: 'mcp' },
        // 排在另一个额外分区后面也行（它已经在列表里了）
        { ...extraTab('third'), after: 'first' }
      ] as never
    })
    expect(ids()).toEqual(withAfter('mcp', 'second', 'first', 'third'))
  })

  it('SP-B5 `after` is not handed down on the tab', async () => {
    await render({
      stacked: true,
      extraTabs: [browserTab({ after: 'mcp' }), { ...extraTab('agents'), after: 'nope' }] as never
    })
    expect('after' in tab('browser')).toBe(false)
    expect('after' in tab('agents')).toBe(false)
  })

  it('SP-B6 an extra tab with onOpen: the function reaches the container as is; calling it stays on the list and writes nothing', async () => {
    const onOpen = vi.fn()
    const onStackedDepthChange = vi.fn()
    await render({
      stacked: true,
      onStackedDepthChange,
      extraTabs: [browserTab({ after: 'mcp', onOpen })] as never
    })
    expect(tab('browser').onOpen).toBe(onOpen)
    act(() => tab('browser').onOpen!())
    await flush()
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(stacked().showList).toBe(true)
    expect(last().activeTab).toBe('general')
    expect(rec.setTab).not.toHaveBeenCalled()
    expect(onStackedDepthChange).not.toHaveBeenCalled()
    // 没离开列表，值也不重取
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
  })

  it('SP-B7 an extra tab without onOpen still opens as a section', async () => {
    await render({
      stacked: true,
      extraTabs: [browserTab({ after: 'mcp', onOpen: vi.fn() }), extraTab('agents')] as never
    })
    expect(tab('agents').onOpen).toBeUndefined()
    await changeTab('agents')
    expect(last().activeTab).toBe('agents')
    expect(stacked().showList).toBe(false)
  })

  it('SP-B8 the browser row reads the number of open tabs', async () => {
    await render({ stacked: true, extraTabs: [browserTab({ after: 'mcp' })] as never })
    expect(tab('browser').value).toBe('3 tabs')
    expect(tab('browser').value).toBe(i18n.t('browser.manager.tabCount', { count: 3 }))
  })

  it('SP-B8 one tab is singular', async () => {
    api.browserView.listTabs.mockResolvedValue([{ id: 't1' }])
    await render({ stacked: true, extraTabs: [browserTab()] as never })
    expect(tab('browser').value).toBe('1 tab')
  })

  it('SP-B8 no tabs → no value', async () => {
    api.browserView.listTabs.mockResolvedValue([])
    await render({ stacked: true, extraTabs: [browserTab()] as never })
    expect(tab('browser').value).toBeUndefined()
    expect(tab('mcp').value).toBe(2)
  })

  it('SP-B8 the tab list refused → no value on that row; the other rows keep theirs', async () => {
    api.browserView.listTabs.mockRejectedValue(new Error('not allowed'))
    await render({ stacked: true, extraTabs: [browserTab()] as never })
    expect(tab('browser').value).toBeUndefined()
    expect(tab('providers').value).toBe(3)
    expect(tab('mcp').value).toBe(2)
    expect(tab('network').value).toBe(i18n.t('mobile.on'))
  })

  it('SP-B8 without a `browser` tab the count has no row to land on', async () => {
    await render({ stacked: true, extraTabs: [extraTab()] as never })
    expect(
      tabs()
        .filter((t) => 'value' in t)
        .map((t) => t.id)
    ).toEqual(['providers', 'mcp', 'network'])
  })

  it('SP-B9 on the desktop extra tabs stay out of the nav whatever they carry, and the tab list is not fetched', async () => {
    await render({ extraTabs: [browserTab({ after: 'mcp', onOpen: vi.fn() })] as never })
    expect(ids()).toEqual(FIXED_TABS)
    expect(tabs().some((t) => t.onOpen !== undefined)).toBe(false)
    expect(api.browserView.listTabs).not.toHaveBeenCalled()
  })
})

describe('SettingsPanel stacked: stackedValuesEpoch', () => {
  const props = (epoch?: number): SettingsPanelProps => ({
    stacked: true,
    extraTabs: [{ ...extraTab('browser', 'capabilities'), after: 'mcp' }] as never,
    ...(epoch === undefined ? {} : { stackedValuesEpoch: epoch })
  })

  it('SP-B10 a changed epoch refetches all four values while the list shows', async () => {
    await render(props(1))
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
    expect(tab('browser').value).toBe('3 tabs')

    api.browserView.listTabs.mockResolvedValue([{ id: 't1' }, { id: 't2' }])
    await render(props(0))
    expect(fetchCounts()).toEqual([2, 2, 2, 2])
    expect(tab('browser').value).toBe('2 tabs')

    api.browserView.listTabs.mockResolvedValue([])
    await render(props(1))
    expect(fetchCounts()).toEqual([3, 3, 3, 3])
    expect(tab('browser').value).toBeUndefined()
  })

  it('SP-B10 the same epoch on a re-render fetches nothing; leaving it out is epoch 0', async () => {
    await render(props())
    await render(props(0))
    await render(props())
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
  })

  it('SP-B10 a changed epoch inside a section fetches nothing', async () => {
    await render(props(0))
    await changeTab('providers')
    await render(props(1))
    expect(stacked().showList).toBe(false)
    expect(fetchCounts()).toEqual([1, 1, 1, 1])
    await backToList()
    expect(fetchCounts()).toEqual([2, 2, 2, 2])
  })
})
