// @vitest-environment jsdom
/**
 * ExtensionsSection（会话设置与项目编辑页共用的扩展能力卡）DOM 测试（jsdom）—— 两条展示规矩：
 *
 *   - agent 档案声明的项（`declaredBy`）**缺省勾上、可以取消**：画成已勾、可点，带 `data-declared`，
 *     没有 `aria-disabled`、没有声明锁，悬停说是哪个档案带的、取消只在这里生效；取消写的是勾选里的
 *     取消记号 `-<name>`（chat-protocol `toolSelection`），交回调用方的 `onChange(next)` 是整份新勾选；
 *     传进来的数组不被改动。整卡只读时一次点击也不交出去 —— 组件自己挡，不只靠 disabled（禁用的
 *     勾选框浏览器不派发 click，所以先摘掉 disabled 再点才证明得了）；
 *   - 每组里 ShuviX 自带的项（内置 MCP / 内置技能）排最前，其余保持传入顺序（稳定排序，不按字母）；
 *     排序不改调用方传进来的数组；
 *   - 内置项（MCP / 技能 / 知识库）以界面语言的名字为主：内置记号（小包裹图标，读屏名「内置」）+ 名字，标识名小字并排（只差大小写
 *     时不重复），悬停是界面语言的说明（builtinExtensionCopy）；别的项就是标识名；
 *   - 知识库一行（`knowledge`）**不随只读上锁**：整卡只读时 MCP / Skills 压暗挂锁，知识库照样可点、
 *     不挂锁，点一下交回库名；内置库 `shuvix` 与内置 MCP / 技能同一个画法；没有候选库时这一行与它那段说明
 *     都不出现；
 *     它那段说明与卡片说明叠在同一个问号气泡里、排在后面（带 `data-knowledge-hint`）。
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
let onChange: ReturnType<typeof vi.fn<(next: string[]) => void>>

function render(props: Partial<ExtensionsSectionProps> = {}): void {
  act(() => {
    root.render(
      createElement(ExtensionsSection, {
        title: 'Extensions',
        mcpTools: MCP_TOOLS,
        skillTools: SKILL_TOOLS,
        enabledTools: ['skill:foo'],
        onChange,
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
  onChange = vi.fn<(next: string[]) => void>()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('档案声明的项：缺省勾上、可以取消', () => {
  it('ES-1 声明项不在勾选里也画成已勾：可点、data-declared、无 aria-disabled、无声明锁、悬停说谁带的；手型光标、不压暗', () => {
    render()
    const declaredHint = i18n.t('sessionConfig.extensionDeclared', { profile: PROFILE })
    expect(declaredHint).not.toBe('sessionConfig.extensionDeclared')
    expect(declaredHint).toContain(PROFILE)
    for (const key of ['mcp:ctx', 'skill:builtin:drawing']) {
      const label = item(key)
      expect(box(key).checked, key).toBe(true)
      expect(box(key).disabled, key).toBe(false)
      expect(label.hasAttribute('data-declared'), key).toBe(true)
      expect(label.hasAttribute('aria-disabled'), key).toBe(false)
      expect(label.querySelector('[data-ext-declared]'), key).toBeNull()
      expect(label.title, key).toBe(declaredHint)
      expect(label.className, key).toContain('cursor-pointer')
      // 压暗与禁用光标专属「整卡只读」
      expect(label.className, key).not.toContain('opacity-40')
      expect(label.className, key).not.toContain('cursor-not-allowed')
    }
    // 对照：没被声明的照常 —— 勾没勾看勾选，可点，没有声明标记
    for (const key of ['mcp:other', 'skill:foo', 'skill:bar']) {
      expect(box(key).checked, key).toBe(key === 'skill:foo')
      expect(box(key).disabled, key).toBe(false)
      expect(item(key).hasAttribute('data-declared'), key).toBe(false)
      expect(item(key).hasAttribute('aria-disabled'), key).toBe(false)
    }
    // 整张卡里没有任何声明锁；卡片没有只读：组名旁一把锁都没有
    expect(container.querySelectorAll('[data-ext-declared]')).toHaveLength(0)
    expect(container.querySelectorAll('[data-ext-lock]')).toHaveLength(0)
  })

  it('ES-2 点声明项 → onChange 交回带取消记号的整份勾选；再点被取消的 → 撤掉记号；普通项照常增删；传入数组不被改动', () => {
    const enabled = Object.freeze(['skill:foo']) as string[]
    render({ enabledTools: enabled })

    click('mcp:ctx')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(['skill:foo', '-mcp:ctx'])

    click('skill:bar')
    expect(onChange).toHaveBeenLastCalledWith(['skill:foo', 'skill:bar'])
    click('skill:foo')
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(enabled).toEqual(['skill:foo'])

    // 取消过作图技能的勾选：那一行画成未勾，但仍是声明项、仍可点
    const optedOut = Object.freeze(['-skill:builtin:drawing']) as string[]
    render({ enabledTools: optedOut })
    expect(box('skill:builtin:drawing').checked).toBe(false)
    expect(box('skill:builtin:drawing').disabled).toBe(false)
    expect(item('skill:builtin:drawing').hasAttribute('data-declared')).toBe(true)
    expect(item('skill:builtin:drawing').hasAttribute('aria-disabled')).toBe(false)
    // 另一个声明项不受这条记号影响
    expect(box('mcp:ctx').checked).toBe(true)

    click('skill:builtin:drawing')
    expect(onChange).toHaveBeenCalledTimes(4)
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(optedOut).toEqual(['-skill:builtin:drawing'])
  })

  it('ES-6 没被声明的项：勾 + 取消两个记号同时在时算没勾；点它 → 只留名字', () => {
    render({ enabledTools: ['-skill:bar', 'skill:bar'] })
    expect(box('skill:bar').checked).toBe(false)
    expect(item('skill:bar').hasAttribute('data-declared')).toBe(false)
    click('skill:bar')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(['skill:bar'])
  })
})

describe('整卡只读（会话已有 Agent 运行时）', () => {
  it('ES-3 只读压过声明：声明项的悬停换成只读原因、压暗 + 禁用光标、仍勾着且禁用；两组各挂一把锁；硬点哪一行都没用', () => {
    render({ readonly: true, readonlyHint: READONLY_HINT })
    for (const key of ['mcp:ctx', 'skill:builtin:drawing']) {
      const label = item(key)
      expect(label.title, key).toBe(READONLY_HINT)
      expect(label.className, key).toContain('cursor-not-allowed')
      expect(label.className, key).toContain('opacity-40')
      expect(label.getAttribute('aria-disabled'), key).toBe('true')
      expect(box(key).checked, key).toBe(true)
      expect(box(key).disabled, key).toBe(true)
    }
    expect(container.querySelectorAll('[data-ext-lock]')).toHaveLength(2)
    // 用户那一侧：禁用的勾选框点了没有任何反应
    for (const key of keys()) click(key)
    // 绕过禁用态硬点每一行（声明项与普通项都算）：组件自己挡，一次也不交出去
    for (const key of keys()) forceClick(key)
    expect(onChange).not.toHaveBeenCalled()
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
    // 被声明的 user-b / bar 仍在同组非内置项里的原位（没有因为「缺省勾上」被提到前面）
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

describe('知识库一行：与 MCP / Skills 同卡，但不随只读上锁', () => {
  const OPTIONS = [
    { name: 'notes', label: 'notes' },
    { name: 'shuvix', label: 'ShuviX guide' }
  ]
  const kbLabels = (): HTMLLabelElement[] => [
    ...container.querySelectorAll<HTMLLabelElement>('label[data-knowledge-base]')
  ]
  const kbBox = (name: string): HTMLInputElement => {
    const hit = kbLabels().find((label) => label.getAttribute('data-knowledge-base') === name)
    if (!hit) throw new Error(`knowledge base ${name} not rendered`)
    return hit.querySelector('input[type="checkbox"]') as HTMLInputElement
  }
  /** 标题旁的问号气泡（悬上去才挂到 body 上） */
  const hintText = (): string => {
    const btn = container.querySelector<HTMLElement>('[data-info-hint]')
    if (!btn) return ''
    act(() => {
      btn.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })
      )
    })
    return document.querySelector('[data-info-tip]')?.textContent ?? ''
  }

  it('ES-7 整卡只读：MCP / Skills 两把锁，知识库可点、不压暗、无 aria-disabled，点一下交回库名、不碰扩展能力勾选', () => {
    const onToggle = vi.fn<(name: string) => void>()
    render({
      readonly: true,
      readonlyHint: READONLY_HINT,
      knowledge: { options: OPTIONS, selected: ['shuvix'], onToggle }
    })
    expect(container.querySelectorAll('[data-ext-lock]')).toHaveLength(2)
    expect(kbLabels().map((label) => label.getAttribute('data-knowledge-base'))).toEqual([
      'notes',
      'shuvix'
    ])
    for (const label of kbLabels()) {
      expect(label.hasAttribute('aria-disabled')).toBe(false)
      expect(label.className).not.toContain('opacity-40')
      expect(label.className).toContain('cursor-pointer')
    }
    expect(kbBox('notes')).toMatchObject({ checked: false, disabled: false })
    expect(kbBox('shuvix')).toMatchObject({ checked: true, disabled: false })
    // 内置库与内置 MCP / 技能同一个画法：内置记号 + 界面语言的名字（标识名并排），悬停是界面语言的说明；
    // 用户库没有内置记号，名字就是目录名
    const [notes, shuvix] = kbLabels()
    expect(shuvix.querySelector('[data-builtin-badge]')?.getAttribute('aria-label')).toBe(
      i18n.t('input.skillBuiltinBadge')
    )
    expect(shuvix.querySelector('[data-chip-name]')?.textContent).toBe(
      i18n.t('knowledge.builtinBaseName')
    )
    expect(shuvix.querySelector('[data-chip-identifier]')?.textContent).toBe('shuvix')
    expect(shuvix.title).toBe(i18n.t('knowledge.builtinBase'))
    expect(notes.querySelector('[data-builtin-badge]')).toBeNull()
    expect(notes.querySelector('[data-chip-name]')?.textContent).toBe('notes')
    expect(notes.querySelector('[data-chip-identifier]')).toBeNull()
    act(() => {
      kbBox('notes').click()
    })
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('notes')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('ES-8 说明：卡片那句在前、知识库那段在后（data-knowledge-hint）；没有候选库时这一行和它那段都不出现', () => {
    render({
      footer: 'CARD',
      knowledge: { options: OPTIONS, selected: [], onToggle: vi.fn(), hint: 'KB-HINT' }
    })
    expect(hintText()).toBe('CARDKB-HINT')
    expect(document.querySelector('[data-info-tip] [data-knowledge-hint]')?.textContent).toBe(
      'KB-HINT'
    )
    act(() => root.unmount())
    document.body.innerHTML = ''
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    render({
      footer: 'CARD',
      knowledge: { options: [], selected: [], onToggle: vi.fn(), hint: 'KB-HINT' }
    })
    expect(kbLabels()).toHaveLength(0)
    expect(container.textContent).not.toContain(i18n.t('sessionConfig.knowledgeGroup'))
    expect(hintText()).toBe('CARD')
  })
})

describe('内置 MCP / 技能以界面语言的名字为主', () => {
  it('ES-9 名字是界面文案、标识名并排（只差大小写时不重复）、悬停是界面文案；别的项是标识名、没有并排的那一份', () => {
    render({
      mcpTools: [
        mcp('ssh', { isBuiltin: true }),
        mcp('browser', { isBuiltin: true }),
        mcp('other')
      ],
      skillTools: [skill('builtin:drawing'), skill('foo')],
      enabledTools: []
    })
    const nameOf = (key: string): string | null =>
      item(key).querySelector('[data-chip-name]')?.textContent ?? null
    const idOf = (key: string): string | null =>
      item(key).querySelector('[data-chip-identifier]')?.textContent ?? null

    expect(nameOf('mcp:browser')).toBe(i18n.t('tool.browserLabel'))
    expect(idOf('mcp:browser')).toBe('browser')
    expect(item('mcp:browser').title).toBe(i18n.t('tool.browserHint'))
    expect(nameOf('mcp:ssh')).toBe(i18n.t('tool.sshLabel'))
    expect(idOf('mcp:ssh')).toBeNull()
    expect(nameOf('skill:builtin:drawing')).toBe(i18n.t('builtinSkill.drawing.label'))
    expect(idOf('skill:builtin:drawing')).toBe('drawing')
    expect(item('skill:builtin:drawing').title).toBe(i18n.t('builtinSkill.drawing.hint'))
    expect(nameOf('mcp:other')).toBe('other')
    expect(idOf('mcp:other')).toBeNull()
    expect(nameOf('skill:foo')).toBe('foo')
    expect(idOf('skill:foo')).toBeNull()
  })
})
