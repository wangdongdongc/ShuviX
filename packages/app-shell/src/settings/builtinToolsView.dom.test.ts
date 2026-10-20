// @vitest-environment jsdom
/**
 * 「LLM 工具」设置页的平台标签（jsdom）—— 列表在任何平台上都列出全部内置工具，平台特定的那几个
 * （bash = macOS / Linux，powershell = Windows）在工具名后挂一个小标签，说它在哪些平台上存在：
 *
 *   - 导航行与右侧 metadata 卡片各有一个，`data-tool-platforms` 是平台键（空格分隔），文字是展示名；
 *   - 悬停文案是 `settings.toolPlatformOnly`（用同一个 i18n 实例现算，不抄文案）；
 *   - 没声明平台的工具（以及声明了空数组的）不画标签。
 *
 * 手机的叠放设置（BuiltinToolsView 作为真 SettingsContainer `stacked` 里一个分区的内容；stackedSettings.tsx）：
 *   BT-1 载入后是一整屏的列表：`[data-tool-row]` = 各工具名（原序）再接宿主追加页的 id；行上的字是
 *        `label || name`；平台特定的工具带平台标签；没有 metadata 卡片、没有详情；level section、头部是分区名
 *   BT-2 点 bash → 详情里是它的 metadata 卡片 + 宿主注入的那块；列表没了；level item、返回键 = 分区名、
 *        头部 = bash 的标签
 *   BT-3 点追加页那一行 → 详情是它的内容、头部是它的标签
 *   BT-4 返回 → 列表、level section；再返回 → 容器的 onBack 一次
 *   BT-5 工具定义还没到时追加页那一行已经在、能打开；定义到了详情不被换掉；loadDefinitions 只调一次
 *   BT-6 不叠放（桌面）：没有任何 `[data-stacked-*]`
 *   BT-7 标签为空的工具：行上是名字，打开后头部也是名字
 *
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'
import { BuiltinToolsView, type BuiltinToolsViewProps } from './BuiltinToolsView'
import { SettingsContainer } from './SettingsContainer'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PARAMS = { type: 'object', properties: {} } as BuiltinToolDefinition['parameters']

const def = (name: string, extra: Partial<BuiltinToolDefinition> = {}): BuiltinToolDefinition => ({
  name,
  label: `${name}-label`,
  group: 'general',
  icon: 'Terminal',
  description: `${name} description`,
  parameters: PARAMS,
  ...extra
})

const DEFS: BuiltinToolDefinition[] = [
  def('bash', { platforms: ['darwin', 'linux'] }),
  def('powershell', { platforms: ['win32'] }),
  def('read', { icon: 'FileText' }),
  def('odd', { platforms: [] })
]

let container: HTMLDivElement
let root: Root

async function renderView(): Promise<void> {
  await act(async () => {
    root.render(createElement(BuiltinToolsView, { loadDefinitions: async () => DEFS }))
  })
}

/** 左侧导航里某个工具的那一行（按标签文字找） */
function navRow(name: string): HTMLButtonElement {
  const hit = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.querySelector('.truncate')?.textContent === `${name}-label`
  )
  if (!hit) throw new Error(`nav row ${name} not rendered`)
  return hit
}

/** 右侧 metadata 卡片里的平台标签 —— 页面上不在导航按钮里的那一个 */
function cardTag(): HTMLElement | null {
  const tags = [...container.querySelectorAll<HTMLElement>('[data-tool-platforms]')]
  return tags.find((t) => !t.closest('button')) ?? null
}

/** 右侧卡片当前展示的是哪个工具 */
function cardName(): string | null {
  return container.querySelector('code.font-semibold')?.textContent ?? null
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('BuiltinToolsView —— 平台标签', () => {
  it('F5 — 导航行：bash 挂「macOS · Linux」、powershell 挂「Windows」，悬停说只在这些平台上可用', async () => {
    await renderView()

    const bashTag = navRow('bash').querySelector<HTMLElement>('[data-tool-platforms]')
    expect(bashTag).not.toBeNull()
    expect(bashTag!.getAttribute('data-tool-platforms')).toBe('darwin linux')
    expect(bashTag!.textContent).toBe('macOS · Linux')
    const title = i18n.t('settings.toolPlatformOnly', { platforms: 'macOS · Linux' })
    expect(title).not.toBe('settings.toolPlatformOnly')
    expect(title).toContain('macOS · Linux')
    expect(bashTag!.getAttribute('title')).toBe(title)

    const psTag = navRow('powershell').querySelector<HTMLElement>('[data-tool-platforms]')
    expect(psTag).not.toBeNull()
    expect(psTag!.getAttribute('data-tool-platforms')).toBe('win32')
    expect(psTag!.textContent).toBe('Windows')
    expect(psTag!.getAttribute('title')).toBe(
      i18n.t('settings.toolPlatformOnly', { platforms: 'Windows' })
    )
  })

  it('F5 — 没声明平台的 read 与声明了空数组的工具：导航行上都没有标签', async () => {
    await renderView()
    expect(navRow('read').querySelector('[data-tool-platforms]')).toBeNull()
    expect(navRow('odd').querySelector('[data-tool-platforms]')).toBeNull()
    // 整页只有 bash / powershell 两个导航标签 + 当前卡片（首项 bash）的一个
    expect(container.querySelectorAll('[data-tool-platforms]')).toHaveLength(3)
  })

  it('F5 — metadata 卡片同样挂标签：默认选中首项 bash；点 powershell 换成 Windows；点 read 没有', async () => {
    await renderView()
    expect(cardName()).toBe('bash')
    expect(cardTag()?.getAttribute('data-tool-platforms')).toBe('darwin linux')

    act(() => navRow('powershell').click())
    expect(cardName()).toBe('powershell')
    const tag = cardTag()
    expect(tag).not.toBeNull()
    expect(tag!.getAttribute('data-tool-platforms')).toBe('win32')
    expect(tag!.textContent).toBe('Windows')
    expect(container.querySelectorAll('[data-tool-platforms="win32"]')).toHaveLength(2)

    act(() => navRow('read').click())
    expect(cardName()).toBe('read')
    expect(cardTag()).toBeNull()
  })

  it('BT-6 — 桌面布局里没有任何叠放的标记', async () => {
    await renderView()
    expect(cardName()).toBe('bash')
    expect(
      container.querySelector('[data-stacked-list], [data-stacked-detail], [data-stacked-row]')
    ).toBeNull()
  })
})

describe('BuiltinToolsView —— 手机的叠放设置', () => {
  const T = '设置'
  const L = zh.settings.tabTools
  const STACKED_DEFS: BuiltinToolDefinition[] = [...DEFS, def('nolabel', { label: '' })]
  const EXTRA = {
    id: 'browser-data',
    label: 'Browser data',
    content: createElement('div', { 'data-x': '' })
  }

  let spySection: ReturnType<typeof vi.fn<() => void>>
  beforeEach(() => {
    spySection = vi.fn<() => void>()
  })

  async function renderStacked(
    loadDefinitions: BuiltinToolsViewProps['loadDefinitions'] = async () => STACKED_DEFS
  ): Promise<void> {
    await act(async () => {
      root.render(
        createElement(SettingsContainer, {
          tabs: [
            {
              id: 'tools',
              label: L,
              content: createElement(BuiltinToolsView, {
                loadDefinitions,
                renderToolExtra: (name: string) =>
                  name === 'bash' ? createElement('i', { 'data-extra': name }) : null,
                extraTabs: [EXTRA]
              })
            }
          ],
          activeTab: 'tools',
          onTabChange: () => {},
          title: T,
          stacked: { showList: false, onBack: spySection }
        })
      )
    })
  }

  const $ = (sel: string): HTMLElement | null => container.querySelector<HTMLElement>(sel)
  const rows = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>('[data-stacked-list] [data-tool-row]')
  ]
  const row = (id: string): HTMLElement => {
    const hit = container.querySelector<HTMLElement>(
      `[data-stacked-list] [data-tool-row=${JSON.stringify(id)}]`
    )
    if (!hit) throw new Error(`stacked row ${id} not rendered`)
    return hit
  }
  const rowLabel = (el: HTMLElement): string =>
    (el.querySelector('span.truncate')?.textContent ?? '').trim()
  const level = (): string | null =>
    $('[data-settings-back]')?.getAttribute('data-settings-level') ?? null
  const heading = (): string | null => $('[data-settings-heading]')?.textContent ?? null
  const back = (): { text: string; aria: string | null } => {
    const b = $('[data-settings-back]')!
    return { text: (b.textContent ?? '').trim(), aria: b.getAttribute('aria-label') }
  }
  const tap = (el: HTMLElement): void => act(() => el.click())

  it('BT-1 — 载入后是一整屏的列表：工具名原序再接追加页；字是 label || name；平台标签；没有卡片、没有详情', async () => {
    await renderStacked()

    expect(rows().map((r) => r.getAttribute('data-tool-row'))).toEqual([
      'bash',
      'powershell',
      'read',
      'odd',
      'nolabel',
      'browser-data'
    ])
    expect(rows().every((r) => r.hasAttribute('data-stacked-row'))).toBe(true)
    expect(rows().map(rowLabel)).toEqual([
      'bash-label',
      'powershell-label',
      'read-label',
      'odd-label',
      'nolabel',
      'Browser data'
    ])
    const platforms = (id: string): string | null =>
      row(id).querySelector('[data-tool-platforms]')?.getAttribute('data-tool-platforms') ?? null
    expect(platforms('bash')).toBe('darwin linux')
    expect(platforms('powershell')).toBe('win32')
    expect(platforms('read')).toBeNull()
    expect(platforms('odd')).toBeNull()
    expect(platforms('browser-data')).toBeNull()
    expect(cardName()).toBeNull()
    expect($('[data-stacked-detail]')).toBeNull()
    expect(level()).toBe('section')
    expect(heading()).toBe(L)
    expect(back()).toEqual({ text: T, aria: T })
  })

  it('BT-2 — 点 bash：详情是它的卡片 + 宿主注入的那块；头部到第二层', async () => {
    await renderStacked()
    tap(row('bash'))

    const detail = $('[data-stacked-detail]')
    expect(detail).not.toBeNull()
    expect(detail!.querySelector('code.font-semibold')?.textContent).toBe('bash')
    expect(detail!.querySelector('[data-extra="bash"]')).not.toBeNull()
    expect($('[data-stacked-list]')).toBeNull()
    expect($('[data-tool-row]')).toBeNull()
    expect(level()).toBe('item')
    expect(back()).toEqual({ text: L, aria: L })
    expect(heading()).toBe('bash-label')
  })

  it('BT-3 — 点追加页：详情是它的内容、头部是它的标签', async () => {
    await renderStacked()
    tap(row('browser-data'))

    expect($('[data-stacked-detail] [data-x]')).not.toBeNull()
    expect(cardName()).toBeNull()
    expect(heading()).toBe('Browser data')
    expect(level()).toBe('item')
  })

  it('BT-4 — 返回回到列表；再返回才是容器的 onBack', async () => {
    await renderStacked()
    tap(row('read'))
    expect(level()).toBe('item')

    tap($('[data-settings-back]')!)
    expect($('[data-stacked-list]')).not.toBeNull()
    expect($('[data-stacked-detail]')).toBeNull()
    expect(level()).toBe('section')
    expect(heading()).toBe(L)
    expect(spySection).not.toHaveBeenCalled()

    tap($('[data-settings-back]')!)
    expect(spySection).toHaveBeenCalledTimes(1)
  })

  it('BT-5 — 定义还没到：追加页那一行已在、能打开；定义到了详情不被换掉；只载一次', async () => {
    let resolve!: (defs: BuiltinToolDefinition[]) => void
    const loadDefinitions = vi.fn(
      () =>
        new Promise<BuiltinToolDefinition[]>((res) => {
          resolve = res
        })
    )
    await renderStacked(loadDefinitions)
    expect(rows().map((r) => r.getAttribute('data-tool-row'))).toEqual(['browser-data'])

    tap(row('browser-data'))
    expect($('[data-stacked-detail] [data-x]')).not.toBeNull()

    await act(async () => {
      resolve(STACKED_DEFS)
    })
    expect($('[data-stacked-detail] [data-x]')).not.toBeNull()
    expect(heading()).toBe('Browser data')
    expect(cardName()).toBeNull()
    expect(loadDefinitions).toHaveBeenCalledTimes(1)

    tap($('[data-settings-back]')!)
    expect(rows()).toHaveLength(STACKED_DEFS.length + 1)
    expect(loadDefinitions).toHaveBeenCalledTimes(1)
  })

  it('BT-7 — 标签为空的工具：行上是名字，打开后头部也是名字', async () => {
    await renderStacked()
    expect(rowLabel(row('nolabel'))).toBe('nolabel')

    tap(row('nolabel'))
    expect(heading()).toBe('nolabel')
    expect(cardName()).toBe('nolabel')
  })
})
