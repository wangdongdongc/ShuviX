// @vitest-environment jsdom
/**
 * ExtensionsSection（会话设置与项目编辑页共用的扩展能力卡）DOM 测试（jsdom）—— 两条展示规矩：
 *
 *   - agent 档案声明的项（`declaredBy`）恒生效：画成已勾、禁用、`data-declared` + `aria-disabled`，
 *     挂一把 `data-ext-declared` 小锁，悬停说是哪个档案声明的；它是**开着的**，所以不压暗、不换
 *     禁用光标（那是整卡只读的样子）。它不在勾选里，也不会经 onToggle 被写进勾选 —— 组件自己挡，
 *     不只靠 disabled（禁用的勾选框浏览器不派发 click，所以先摘掉 disabled 再点才证明得了）；
 *   - 每组里 ShuviX 自带的项（内置 MCP / 内置技能）排最前，其余保持传入顺序（稳定排序，不按字母）；
 *     排序不改调用方传进来的数组。
 *
 * 文件是 `.ts`（app-shell 的单测只收 `*.test.ts`），所以不写 JSX，一律 createElement。
 * i18n 走真 zh 资源，悬停文案用同一个实例的 `i18n.t` 现算，不抄文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { ToolItem } from '../common/ToolSelectList'
import { ExtensionsSection, type ExtensionsSectionProps } from './ExtensionsSection'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PROFILE = 'Work'
const READONLY_HINT = 'READ-ONLY: the agent already exists'

const mcp = (name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  name: `mcp:${name}`,
  label: name,
  group: `mcp:${name}`,
  ...extra
})
const skill = (name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  name: `skill:${name}`,
  label: `${name} description`,
  group: '__skills__',
  ...extra
})

/** 一张有声明项的卡：MCP 里 ctx 被声明，Skills 里内置 drawing 被声明 */
const MCP_TOOLS = [mcp('ctx', { declaredBy: PROFILE }), mcp('other')]
const SKILL_TOOLS = [skill('builtin:drawing', { declaredBy: PROFILE }), skill('foo'), skill('bar')]

let container: HTMLDivElement
let root: Root
let onToggle: ReturnType<typeof vi.fn>

function render(props: Partial<ExtensionsSectionProps> = {}): void {
  act(() => {
    root.render(
      createElement(ExtensionsSection, {
        title: 'Extensions',
        mcpTools: MCP_TOOLS,
        skillTools: SKILL_TOOLS,
        enabledTools: ['skill:foo'],
        onToggle: onToggle as unknown as (toolName: string) => void,
        ...props
      })
    )
  })
}

const items = (): HTMLLabelElement[] => [
  ...container.querySelectorAll<HTMLLabelElement>('label[data-ext-item]')
]
const keys = (): string[] => items().map((label) => label.getAttribute('data-ext-item') ?? '')
const item = (key: string): HTMLLabelElement => {
  const hit = items().find((label) => label.getAttribute('data-ext-item') === key)
  if (!hit) throw new Error(`item ${key} not rendered`)
  return hit
}
const box = (key: string): HTMLInputElement =>
  item(key).querySelector('input[type="checkbox"]') as HTMLInputElement

function click(key: string): void {
  act(() => {
    box(key).click()
  })
}

/** 绕过禁用态硬点：摘掉 disabled、点、再装回（React 只在 prop 变化时才碰 disabled） */
function forceClick(key: string): void {
  const input = box(key)
  const wasDisabled = input.disabled
  input.disabled = false
  act(() => {
    input.click()
  })
  input.disabled = wasDisabled
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  onToggle = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('档案声明的项：已勾、锁住、点不动', () => {
  it('ES-1 声明项不在勾选里也画成已勾：禁用、data-declared、aria-disabled、声明锁、悬停说谁声明的；不压暗', () => {
    render()
    const declaredHint = i18n.t('sessionConfig.extensionDeclared', { profile: PROFILE })
    expect(declaredHint).not.toBe('sessionConfig.extensionDeclared')
    expect(declaredHint).toContain(PROFILE)
    for (const key of ['mcp:ctx', 'skill:builtin:drawing']) {
      const label = item(key)
      expect(box(key).checked, key).toBe(true)
      expect(box(key).disabled, key).toBe(true)
      expect(label.hasAttribute('data-declared'), key).toBe(true)
      expect(label.getAttribute('aria-disabled'), key).toBe('true')
      expect(label.querySelector('[data-ext-declared]'), key).not.toBeNull()
      expect(label.title, key).toBe(declaredHint)
      // 它是开着的：压暗与禁用光标专属「整卡只读」
      expect(label.className, key).not.toContain('opacity-40')
      expect(label.className, key).not.toContain('cursor-not-allowed')
    }
    // 对照：没被声明的照常 —— 勾没勾看勾选，可点，没有声明标记
    for (const key of ['mcp:other', 'skill:foo', 'skill:bar']) {
      expect(box(key).checked, key).toBe(key === 'skill:foo')
      expect(box(key).disabled, key).toBe(false)
      expect(item(key).hasAttribute('data-declared'), key).toBe(false)
      expect(item(key).querySelector('[data-ext-declared]'), key).toBeNull()
    }
    // 卡片没有只读：组名旁一把锁都没有
    expect(container.querySelectorAll('[data-ext-lock]')).toHaveLength(0)
  })

  it('ES-2 硬点声明项 → onToggle 不被调用；点别的条目 → 恰好一次、带它自己的 key', () => {
    render()
    forceClick('mcp:ctx')
    forceClick('skill:builtin:drawing')
    expect(onToggle).not.toHaveBeenCalled()

    // 同一个手法落在普通条目上（它本就可点）是真能到 onToggle 的 —— 上面的「没调」不是手法失灵
    forceClick('skill:bar')
    expect(onToggle).toHaveBeenCalledTimes(1)
    expect(onToggle).toHaveBeenCalledWith('skill:bar')
  })
})

describe('整卡只读（会话已有 Agent 运行时）', () => {
  it('ES-3 只读压过声明：声明项的悬停换成只读原因、压暗 + 禁用光标、仍勾着；两组各挂一把锁；点了都没用', () => {
    render({ readonly: true, readonlyHint: READONLY_HINT })
    for (const key of ['mcp:ctx', 'skill:builtin:drawing']) {
      const label = item(key)
      expect(label.title, key).toBe(READONLY_HINT)
      expect(label.className, key).toContain('cursor-not-allowed')
      expect(label.className, key).toContain('opacity-40')
      expect(box(key).checked, key).toBe(true)
      expect(box(key).disabled, key).toBe(true)
    }
    expect(container.querySelectorAll('[data-ext-lock]')).toHaveLength(2)
    // 用户那一侧：禁用的勾选框点了没有任何反应
    for (const key of keys()) click(key)
    // 声明项连绕过禁用态都点不动（组件自己挡）
    forceClick('mcp:ctx')
    forceClick('skill:builtin:drawing')
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('每组里内置项排前，其余保持传入顺序', () => {
  const MCP_INPUT: ToolItem[] = [
    mcp('user-a'),
    mcp('ssh', { isBuiltin: true }),
    mcp('user-b', { declaredBy: PROFILE }),
    mcp('tavily', { isBuiltin: true })
  ]
  const SKILL_INPUT: ToolItem[] = [
    skill('foo'),
    skill('builtin:zeta'),
    skill('bar', { declaredBy: PROFILE }),
    skill('builtin:alpha')
  ]

  it('ES-4 MCP → ssh, tavily, user-a, user-b；Skills → zeta, alpha, foo, bar（稳定排序，不按字母；声明与否不挪位置）', () => {
    render({ mcpTools: MCP_INPUT, skillTools: SKILL_INPUT, enabledTools: [] })
    expect(keys()).toEqual([
      'mcp:ssh',
      'mcp:tavily',
      'mcp:user-a',
      'mcp:user-b',
      'skill:builtin:zeta',
      'skill:builtin:alpha',
      'skill:foo',
      'skill:bar'
    ])
    // 被声明的 user-b / bar 仍在同组非内置项里的原位（没有因为「已勾、锁住」被提到前面）
    expect(item('mcp:user-b').hasAttribute('data-declared')).toBe(true)
    expect(item('skill:bar').hasAttribute('data-declared')).toBe(true)
  })

  it('ES-5 排序不改调用方的数组：传进来的 mcpTools / skillTools 原样不动', () => {
    const mcpTools = Object.freeze([...MCP_INPUT]) as ToolItem[]
    const skillTools = Object.freeze([...SKILL_INPUT]) as ToolItem[]
    const before = [mcpTools.map((t) => t.name), skillTools.map((t) => t.name)]
    // 冻结的数组上原地 sort 会直接抛错 —— 渲染得出来本身就说明没有原地排
    expect(() => render({ mcpTools, skillTools, enabledTools: [] })).not.toThrow()
    expect([mcpTools.map((t) => t.name), skillTools.map((t) => t.name)]).toEqual(before)
    expect(keys()).toHaveLength(MCP_INPUT.length + SKILL_INPUT.length)
  })
})
