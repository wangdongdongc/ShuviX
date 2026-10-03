// @vitest-environment jsdom
/**
 * ToolPicker（输入框的工具选择器）DOM 测试（jsdom）—— 档案声明的 mcp:/skill: 项（`declaredBy`）：
 *
 *   - 画成**已勾、锁住**：勾选框勾着且禁用、行上 `data-declared` + `aria-disabled`、挂一把
 *     `data-tool-declared` 小锁，悬停说是哪个档案声明的（sessionConfig.extensionDeclared）；
 *     它是**开着的**，所以不压暗（没有 opacity-40）—— 压暗专属「运行时已建、整排只读」；
 *   - 算进触发钮的计数与悬浮摘要（它确实生效），但勾选写回时**不碰它**：会话勾选只是在它之上
 *     叠加，写进去的永远只有会话自己勾的那些；已经混进勾选里的声明项也不会被顺手抹掉；
 *   - 组件自己挡住对它的切换 —— 禁用的勾选框浏览器根本不派发 click，所以先摘掉 disabled 再点
 *     （与 e2e `toolPickerPane.toggle(…, { force: true })` 同一个办法）才证明得了这一点；
 *   - 运行时已建（sessionAgentCreated）时整排只读，声明项与其它行一样压暗、换成只读的悬停原因；
 *   - 欢迎页（没有会话，TP-10..14）：照样渲染，勾的是新会话的草稿（`welcomeEnabledTools`，不走 IPC），
 *     条目按欢迎页新建会话将用的档案列（`tools.list(undefined, {profile:'chat'})`）；别的会话有没有
 *     运行时与它无关；会话一换，晚到的那份条目不上屏。
 *
 * 数据走真的 `useSessionTools` + 真的 chatStore；包入口 `@shuvix/chat-ui` 整个顶掉（同
 * useSessionTools.test.ts 的做法：入口会带上模块加载期就读 window.location 的 useSessionInit），
 * 只留两个通道：`getSessionChannelApi().tools.list` 供条目，`getHostApi().session.updateEnabledTools`
 * 记下写入。i18n 走真 zh 资源，悬停文案一律用同一个实例的 `i18n.t` 现算，不抄文案。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { ToolItem } from '../../common/ToolSelectList'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  updateEnabledTools: vi.fn(),
  init: vi.fn()
}))

vi.mock('@shuvix/chat-ui', () => ({
  getSessionChannelApi: () => ({ tools: { list: mocks.list }, agent: { init: mocks.init } }),
  getHostApi: () => ({ session: { updateEnabledTools: mocks.updateEnabledTools } })
}))

import { useChatStore } from '../../../stores/chatStore'
import { ToolPicker } from '../ToolPicker'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-picker'
const PROFILE = 'Work'

/** 条目：两组各有一项被档案声明；内置工具条目（general 组）选择器本就不展示 */
const ITEMS: ToolItem[] = [
  { name: 'read', label: 'read', group: 'general', defaultEnabled: true },
  {
    name: 'mcp:ctx',
    label: 'ctx',
    group: 'mcp:ctx',
    serverStatus: 'connected',
    declaredBy: PROFILE
  },
  { name: 'mcp:other', label: 'other', group: 'mcp:other', serverStatus: 'disconnected' },
  {
    name: 'skill:builtin:drawing',
    label: 'draw inline figures',
    group: '__skills__',
    isBuiltin: true,
    declaredBy: PROFILE
  },
  { name: 'skill:foo', label: 'foo skill', group: '__skills__' },
  { name: 'skill:bar', label: 'bar skill', group: '__skills__' }
]
const DECLARED = ['mcp:ctx', 'skill:builtin:drawing']
const UNDECLARED = ['mcp:other', 'skill:foo', 'skill:bar']

let container: HTMLDivElement
let root: Root

/** 让异步到货的条目（tools.list 的 then）与写入的 promise 落定 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 种一条当前会话：它自己的勾选 + 此刻有没有运行时 */
function seedSession(enabledTools: string[], created = false): void {
  useChatStore.setState({
    sessions: [
      {
        id: SID,
        title: 'Picker',
        projectId: null,
        parentId: null,
        settings: { enabledTools },
        createdAt: 0,
        updatedAt: 0,
        lastActiveAt: 0
      }
    ],
    sessionAgentCreated: created ? { [SID]: true } : {},
    sessionClosing: {},
    sessionMcpConnecting: {}
  })
  useChatStore.getState().setActiveSessionId(SID)
}

async function renderPicker(items: ToolItem[] = ITEMS): Promise<void> {
  mocks.list.mockResolvedValue(items)
  await act(async () => {
    root.render(createElement(ToolPicker))
  })
  await flush()
}

const pickerRoot = (): HTMLElement => {
  const el = container.querySelector<HTMLElement>('[data-tool-picker]')
  if (!el) throw new Error('tool picker not rendered')
  return el
}
const trigger = (): HTMLButtonElement => pickerRoot().querySelector('button') as HTMLButtonElement

async function openPanel(): Promise<void> {
  if (container.querySelector('label[data-tool-item]')) return
  await act(async () => {
    trigger().click()
  })
  await flush()
  if (!container.querySelector('label[data-tool-item]')) throw new Error('panel did not open')
}

const row = (name: string): HTMLLabelElement => {
  const hit = [...container.querySelectorAll<HTMLLabelElement>('label[data-tool-item]')].find(
    (label) => label.getAttribute('data-tool-item') === name
  )
  if (!hit) throw new Error(`row ${name} not rendered`)
  return hit
}
const box = (name: string): HTMLInputElement =>
  row(name).querySelector('input[type="checkbox"]') as HTMLInputElement

async function click(name: string): Promise<void> {
  await act(async () => {
    box(name).click()
  })
  await flush()
}

/** 绕过禁用态硬点：摘掉 disabled、点、再装回（React 只在 prop 变化时才碰 disabled） */
async function forceClick(name: string): Promise<void> {
  const input = box(name)
  const wasDisabled = input.disabled
  input.disabled = false
  await act(async () => {
    input.click()
  })
  input.disabled = wasDisabled
  await flush()
}

/** 触发钮上两组的计数（按组图标认：MCP = lucide-server，Skills = lucide-book-open） */
function counts(): { mcp: string | null; skill: string | null } {
  const groups = [...trigger().querySelectorAll(':scope > span')]
  const countBy = (icon: string): string | null =>
    groups.find((g) => g.querySelector(`svg.${icon}`))?.querySelector(':scope > span')
      ?.textContent ?? null
  return { mcp: countBy('lucide-server'), skill: countBy('lucide-book-open') }
}

/** 悬浮摘要（面板收起时才渲染）里某个组标签后面那串名字 */
function summaryOf(tag: '[MCP]' | '[Skills]'): string | null {
  const label = [...pickerRoot().querySelectorAll('span')].find((span) => span.textContent === tag)
  return label?.nextElementSibling?.textContent ?? null
}

const storedTools = (): string[] | undefined =>
  useChatStore.getState().sessions.find((s) => s.id === SID)?.settings.enabledTools

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  mocks.list.mockReset()
  mocks.updateEnabledTools.mockReset()
  mocks.updateEnabledTools.mockResolvedValue({ success: true })
  mocks.init.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('档案声明的条目：已勾、锁住、不压暗', () => {
  it('TP-1 声明项：data-declared + aria-disabled、勾着且禁用、挂声明锁、悬停说是谁声明的、不压暗', async () => {
    seedSession(['skill:foo'])
    await renderPicker()
    await openPanel()
    const declaredHint = i18n.t('sessionConfig.extensionDeclared', { profile: PROFILE })
    // 文案真的解析出来了（不是裸 key），而且点了档案的名
    expect(declaredHint).not.toBe('sessionConfig.extensionDeclared')
    expect(declaredHint).toContain(PROFILE)
    for (const name of DECLARED) {
      const label = row(name)
      expect(label.hasAttribute('data-declared'), name).toBe(true)
      expect(label.getAttribute('aria-disabled'), name).toBe('true')
      expect(box(name).checked, name).toBe(true)
      expect(box(name).disabled, name).toBe(true)
      expect(label.querySelector('[data-tool-declared]'), name).not.toBeNull()
      expect(label.title, name).toBe(declaredHint)
      // 它是开着的：压暗专属「运行时已建」的只读态
      expect(label.className, name).not.toContain('opacity-40')
    }
  })

  it('TP-2 其它条目照常：可勾、只有会话自己勾的 foo 是勾着的，不带声明标记与声明锁', async () => {
    seedSession(['skill:foo'])
    await renderPicker()
    await openPanel()
    for (const name of UNDECLARED) {
      const label = row(name)
      expect(box(name).disabled, name).toBe(false)
      expect(box(name).checked, name).toBe(name === 'skill:foo')
      expect(label.hasAttribute('data-declared'), name).toBe(false)
      expect(label.getAttribute('aria-disabled'), name).toBeNull()
      expect(label.querySelector('[data-tool-declared]'), name).toBeNull()
    }
  })

  it('TP-3 声明项算进计数与悬浮摘要：MCP 1（ctx）、Skills 2（drawing, foo）', async () => {
    seedSession(['skill:foo'])
    await renderPicker()
    // 面板收起时：触发钮计数 + 悬浮摘要
    expect(counts()).toEqual({ mcp: '1', skill: '2' })
    expect(summaryOf('[MCP]')).toBe('ctx')
    expect(summaryOf('[Skills]')).toBe('drawing, foo')
  })
})

describe('勾选写回：只写会话自己的那些', () => {
  it('TP-4 绕过禁用态硬点声明项 → 什么也不写（组件自己挡住，不只靠 disabled）', async () => {
    seedSession(['skill:foo'])
    await renderPicker()
    await openPanel()
    for (const name of DECLARED) await forceClick(name)
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(storedTools()).toEqual(['skill:foo'])
    // 点完仍是已勾、锁住
    for (const name of DECLARED) expect(box(name).checked, name).toBe(true)
    // 对照：同一个硬点手法落在普通条目上是真能写进去的 —— 上面的「没写」不是手法失灵
    await forceClick('skill:bar')
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['skill:foo', 'skill:bar']
    })
  })

  it('TP-5 勾上 bar → 恰好写一次，写的是 [foo, bar]（声明项不被写进勾选）', async () => {
    seedSession(['skill:foo'])
    await renderPicker()
    await openPanel()
    await click('skill:bar')
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['skill:foo', 'skill:bar']
    })
    expect(storedTools()).toEqual(['skill:foo', 'skill:bar'])
  })

  it('TP-6 取消 foo → 写 []（声明项照样开着，但它从来不在勾选里）', async () => {
    seedSession(['skill:foo'])
    await renderPicker()
    await openPanel()
    await click('skill:foo')
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({ id: SID, enabledTools: [] })
    expect(box('skill:builtin:drawing').checked).toBe(true)
  })

  it('TP-7 勾选里已经混着声明项：计数不重复（2 而非 3），取消 foo 也不会把它顺手抹掉', async () => {
    seedSession(['skill:builtin:drawing', 'skill:foo'])
    await renderPicker()
    expect(counts().skill).toBe('2')
    await openPanel()
    await click('skill:foo')
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['skill:builtin:drawing']
    })
  })
})

describe('运行时已建：整排只读，声明项也不例外', () => {
  it('TP-8 每一行都禁用 + aria-disabled；声明项仍勾着、改挂只读原因并压暗；触发钮挂锁；硬点什么也不写', async () => {
    seedSession(['skill:foo'], true)
    await renderPicker()
    expect(pickerRoot().querySelector('[data-tool-lock]')).not.toBeNull()
    await openPanel()
    const lockedHint = i18n.t('sessionConfig.extensionsLocked')
    expect(lockedHint).not.toBe('sessionConfig.extensionsLocked')
    for (const name of [...DECLARED, ...UNDECLARED]) {
      expect(row(name).getAttribute('aria-disabled'), name).toBe('true')
      expect(box(name).disabled, name).toBe(true)
    }
    for (const name of DECLARED) {
      const label = row(name)
      expect(box(name).checked, name).toBe(true)
      // 只读的原因盖过「谁声明的」：此刻改不了的理由是运行时已建
      expect(label.title, name).toBe(lockedHint)
      expect(label.className, name).toContain('cursor-not-allowed')
      expect(label.className, name).toContain('opacity-40')
    }
    for (const name of [...DECLARED, ...UNDECLARED]) await forceClick(name)
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(storedTools()).toEqual(['skill:foo'])
  })
})

describe('回归：没有任何声明项时一切照旧', () => {
  it('TP-9 条目都不带 declaredBy → 计数只算会话勾选（MCP 0、Skills 1），面板里没有声明锁', async () => {
    seedSession(['skill:foo'])
    await renderPicker(ITEMS.map(({ declaredBy: _declaredBy, ...rest }) => rest))
    expect(counts()).toEqual({ mcp: '0', skill: '1' })
    await openPanel()
    expect(container.querySelector('[data-tool-declared]')).toBeNull()
    expect(container.querySelector('label[data-declared]')).toBeNull()
    expect(box('mcp:ctx').disabled).toBe(false)
    expect(box('mcp:ctx').checked).toBe(false)
  })
})

// ─── 欢迎页：草稿与档案 chat ────────────────────────────────────────────────

describe('欢迎页（没有会话）：勾的是新会话的草稿', () => {
  const CHAT = 'Chat Persona'
  /** 欢迎页那份条目：声明项由 chat 档案声明 */
  const WELCOME_ITEMS: ToolItem[] = ITEMS.map((it) =>
    it.declaredBy ? { ...it, declaredBy: CHAT } : it
  )
  const welcomeDraft = (): string[] => useChatStore.getState().welcomeEnabledTools

  /** 欢迎页：别的会话（SID）有运行时也照样；草稿按给的种 */
  function seedWelcome(draft: string[] = [], sessionTools: string[] = ['skill:bar']): void {
    seedSession(sessionTools, true)
    useChatStore.setState({ welcomeEnabledTools: draft })
    useChatStore.getState().setActiveSessionId(null)
  }

  /** 按调用参数分两份：有 sid → 会话那份（Work 声明），没有 → 欢迎页那份（chat 声明） */
  function listBySid(): void {
    mocks.list.mockImplementation((sid?: string) => Promise.resolve(sid ? ITEMS : WELCOME_ITEMS))
  }

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(createElement(ToolPicker))
    })
    await flush()
  }

  it("TP-10 渲染；tools.list 的参数正好是 (undefined, {profile:'chat'})；不锁；声明项照常已勾锁住、悬停点 chat", async () => {
    seedWelcome()
    listBySid()
    await mount()
    expect(mocks.list).toHaveBeenCalled()
    for (const call of mocks.list.mock.calls) expect(call).toEqual([undefined, { profile: 'chat' }])
    expect(pickerRoot().hasAttribute('data-locked')).toBe(false)
    expect(pickerRoot().querySelector('[data-tool-lock]')).toBeNull()

    await openPanel()
    const hint = i18n.t('sessionConfig.extensionDeclared', { profile: CHAT })
    expect(hint).toContain(CHAT)
    for (const name of DECLARED) {
      expect(row(name).hasAttribute('data-declared'), name).toBe(true)
      expect(box(name).checked, name).toBe(true)
      expect(box(name).disabled, name).toBe(true)
      expect(row(name).title, name).toBe(hint)
      expect(row(name).className, name).not.toContain('opacity-40')
    }
    for (const name of UNDECLARED) expect(box(name).disabled, name).toBe(false)
  })

  it('TP-11 勾 skill:foo → 草稿 [skill:foo]、零 IPC、计数跟着变；再取消 → []', async () => {
    seedWelcome()
    listBySid()
    await mount()
    expect(counts()).toEqual({ mcp: '1', skill: '1' })
    await openPanel()

    await click('skill:foo')
    expect(welcomeDraft()).toEqual(['skill:foo'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(box('skill:foo').checked).toBe(true)
    expect(counts()).toEqual({ mcp: '1', skill: '2' })

    await click('skill:foo')
    expect(welcomeDraft()).toEqual([])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
    expect(counts()).toEqual({ mcp: '1', skill: '1' })
    // 别的会话的勾选不受影响
    expect(storedTools()).toEqual(['skill:bar'])
  })

  it('TP-12 硬点声明项 → 草稿不变', async () => {
    seedWelcome(['skill:foo'])
    listBySid()
    await mount()
    await openPanel()
    const before = welcomeDraft()
    for (const name of DECLARED) await forceClick(name)
    expect(welcomeDraft()).toBe(before)
    expect(welcomeDraft()).toEqual(['skill:foo'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()
  })

  it('TP-13 欢迎页那份挂着时切到会话，会话那份先回并上屏；欢迎页那份晚到被忽略', async () => {
    seedWelcome()
    let resolveWelcome!: (items: ToolItem[]) => void
    mocks.list.mockImplementation((sid?: string) =>
      sid
        ? Promise.resolve(ITEMS)
        : new Promise<ToolItem[]>((r) => {
            resolveWelcome = r
          })
    )
    await mount()
    // 欢迎页那份还没回：没有条目，不渲染
    expect(container.querySelector('[data-tool-picker]')).toBeNull()

    await act(async () => {
      useChatStore.getState().setActiveSessionId(SID)
    })
    await flush()
    // 会话那份（Work 声明 mcp:ctx、drawing；会话自己勾 bar）上屏，且是只读的
    expect(summaryOf('[MCP]')).toBe('ctx')
    expect(summaryOf('[Skills]')).toBe('drawing, bar')
    expect(pickerRoot().hasAttribute('data-locked')).toBe(true)

    // 欢迎页那份晚到：带一个只属于它的条目 —— 不能上屏
    resolveWelcome([...WELCOME_ITEMS, { name: 'skill:late', label: 'late', group: '__skills__' }])
    await flush()
    await openPanel()
    expect(container.querySelector('label[data-tool-item="skill:late"]')).toBeNull()
    expect(row('mcp:ctx').title).toBe(i18n.t('sessionConfig.extensionsLocked'))
  })

  it('TP-13 反方向：会话那份挂着时切到欢迎页，欢迎页那份先回并上屏；会话那份晚到被忽略', async () => {
    seedSession(['skill:bar'], true)
    useChatStore.setState({ welcomeEnabledTools: [] })
    let resolveSession!: (items: ToolItem[]) => void
    mocks.list.mockImplementation((sid?: string) =>
      sid
        ? new Promise<ToolItem[]>((r) => {
            resolveSession = r
          })
        : Promise.resolve(WELCOME_ITEMS)
    )
    await mount()
    expect(container.querySelector('[data-tool-picker]')).toBeNull()

    await act(async () => {
      useChatStore.getState().setActiveSessionId(null)
    })
    await flush()
    // 欢迎页：只有声明项开着（草稿为空），不锁
    expect(summaryOf('[Skills]')).toBe('drawing')
    expect(pickerRoot().hasAttribute('data-locked')).toBe(false)

    resolveSession([...ITEMS, { name: 'skill:late', label: 'late', group: '__skills__' }])
    await flush()
    expect(summaryOf('[Skills]')).toBe('drawing')
    // 打开面板会再拉一次（欢迎页那份）；晚到的会话条目始终没上屏
    await openPanel()
    expect(container.querySelector('label[data-tool-item="skill:late"]')).toBeNull()
    expect(row('skill:builtin:drawing').title).toBe(
      i18n.t('sessionConfig.extensionDeclared', { profile: CHAT })
    )
  })

  it('TP-14 草稿与会话勾选互不串：各显示各的，在会话里勾不碰草稿，在欢迎页勾不碰会话', async () => {
    seedSession(['skill:bar'])
    useChatStore.setState({ welcomeEnabledTools: ['skill:foo'] })
    useChatStore.getState().setActiveSessionId(null)
    listBySid()
    await mount()
    await openPanel()
    expect(box('skill:foo').checked).toBe(true)
    expect(box('skill:bar').checked).toBe(false)

    // 欢迎页勾 bar：只进草稿
    await click('skill:bar')
    expect(welcomeDraft()).toEqual(['skill:foo', 'skill:bar'])
    expect(storedTools()).toEqual(['skill:bar'])
    expect(mocks.updateEnabledTools).not.toHaveBeenCalled()

    // 切到会话（没有运行时）：显示会话自己的勾选
    await act(async () => {
      useChatStore.getState().setActiveSessionId(SID)
    })
    await flush()
    await openPanel()
    expect(box('skill:bar').checked).toBe(true)
    expect(box('skill:foo').checked).toBe(false)

    // 会话里勾 foo：只写会话，草稿不动
    await click('skill:foo')
    expect(mocks.updateEnabledTools).toHaveBeenCalledTimes(1)
    expect(mocks.updateEnabledTools).toHaveBeenCalledWith({
      id: SID,
      enabledTools: ['skill:bar', 'skill:foo']
    })
    expect(welcomeDraft()).toEqual(['skill:foo', 'skill:bar'])

    // 回到欢迎页：草稿原样
    await act(async () => {
      useChatStore.getState().setActiveSessionId(null)
    })
    await flush()
    await openPanel()
    expect(box('skill:foo').checked).toBe(true)
    expect(box('skill:bar').checked).toBe(true)
    expect(welcomeDraft()).toEqual(['skill:foo', 'skill:bar'])
  })
})
