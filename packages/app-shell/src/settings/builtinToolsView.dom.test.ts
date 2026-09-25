// @vitest-environment jsdom
/**
 * 「LLM 工具」设置页的平台标签（jsdom）—— 列表在任何平台上都列出全部内置工具，平台特定的那几个
 * （bash = macOS / Linux，powershell = Windows）在工具名后挂一个小标签，说它在哪些平台上存在：
 *
 *   - 导航行与右侧 metadata 卡片各有一个，`data-tool-platforms` 是平台键（空格分隔），文字是展示名；
 *   - 悬停文案是 `settings.toolPlatformOnly`（用同一个 i18n 实例现算，不抄文案）；
 *   - 没声明平台的工具（以及声明了空数组的）不画标签。
 *
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { BuiltinToolDefinition } from '@shuvix/chat-protocol/chatApi'
import { BuiltinToolsView } from './BuiltinToolsView'

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
})
