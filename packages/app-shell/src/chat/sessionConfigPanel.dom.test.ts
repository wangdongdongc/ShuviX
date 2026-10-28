// @vitest-environment jsdom
/**
 * 会话配置面板的扩展能力一节（SessionConfigPanel；jsdom）—— 会话已有 Agent 运行时也能改 MCP
 * （2026-10-26：后端当场重配那个 agent），会打穿提示词缓存的改动先问一句：
 *
 *   RU-24 有 agent：MCP 的勾选框都可点、没有组名旁的锁（`data-ext-lock`）、没有 aria-disabled；卡片的
 *         说明（问号气泡）是 sessionConfig.extensionsDesc
 *   RU-25 面板自己挂着一个确认框宿主，输入框也挂着一个：同一时刻只有一个框；问到一半把面板关掉 → 框还在
 *         （输入框那个接着画），确认得了、写得进去
 *   RU-26 面板里勾一项 → 先 `agent.previewChange`（整份新勾选）；保不住 → 确认框，取消什么都不写，确认才
 *         `session.updateEnabledTools`；知识库一行从不预判
 *   SC-K1/2 技能不按会话勾选（2026-10-28）：tools.list 里就算混着 `skill:` 项（group `__skills__`）也不画，
 *         卡上没有技能一行；没有 MCP、没有候选知识库时整节不显示（只有技能项也一样）
 *
 * 用真的 `@shuvix/chat-ui`（useSessionTools / CacheBreakConfirmHost / chatStore），后端是 `window.api` 上的
 * 一个替身（getChatApi / getSessionChannelApi / getHostApi 都回落到它）。输入框那个宿主用一个单独挂上的
 * CacheBreakConfirmHost 代替 —— InputArea 自己挂着它由 chat-ui 的 inputAreaWelcomeSend RU-22 钉着。
 * 确认框的 store 是模块级的：每个用例把挂上的东西卸干净。文件是 `.ts`，一律 createElement；i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AgentChangePreview } from '@shuvix/chat-protocol/chatApi'
import { CacheBreakConfirmHost, useChatStore } from '@shuvix/chat-ui'
import type { ToolItem } from '../common/ToolSelectList'
import { SessionConfigPanel } from './SessionConfigPanel'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-config'

const ITEMS: ToolItem[] = [
  { name: 'mcp:ctx', label: 'ctx', group: 'mcp:ctx', serverStatus: 'connected' },
  { name: 'mcp:foo', label: 'foo', group: 'mcp:foo', serverStatus: 'disconnected' },
  { name: 'mcp:bar', label: 'bar', group: 'mcp:bar', serverStatus: 'disconnected' }
]

/** 旧宿主 / 别的来源可能还给的技能项：`skill:` 条目与内置的 `skill` 工具本身 */
const SKILL_ITEMS: ToolItem[] = [
  { name: 'mcp:foo', label: 'foo skill', group: '__skills__' },
  { name: 'skill', label: 'skill', group: 'general' }
]

const api = {
  list: vi.fn(async (): Promise<ToolItem[]> => ITEMS),
  init: vi.fn(),
  previewChange: vi.fn<(params: Record<string, unknown>) => Promise<AgentChangePreview>>(),
  updateEnabledTools: vi.fn(),
  updateKnowledgeBases: vi.fn(),
  baseOptions: vi.fn(),
  listAcl: vi.fn(async () => [])
}

function windowApi(): unknown {
  return {
    tools: { list: api.list },
    agent: { init: api.init, previewChange: api.previewChange },
    session: {
      updateEnabledTools: api.updateEnabledTools,
      updateKnowledgeBases: api.updateKnowledgeBases,
      listAcl: api.listAcl
    },
    knowledge: { baseOptions: api.baseOptions },
    app: {},
    events: { subscribe: () => () => {} }
  }
}

const LOST: AgentChangePreview = {
  locked: true,
  cache: 'lost',
  reasons: ['tools'],
  promptTokens: 900
}

/** 挂着的 root（afterEach 一并卸掉，后挂的先卸） */
const mounted: { container: HTMLDivElement; root: Root }[] = []

async function mount(
  node: Parameters<Root['render']>[0]
): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const entry = { container, root }
  mounted.push(entry)
  await act(async () => {
    root.render(node)
  })
  await flush()
  return {
    container,
    unmount: async () => {
      const at = mounted.indexOf(entry)
      if (at < 0) return
      mounted.splice(at, 1)
      await act(async () => root.unmount())
      container.remove()
    }
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const mountPanel = (): ReturnType<typeof mount> =>
  mount(createElement(SessionConfigPanel, { sessionId: SID }))
/** 输入框那个宿主的替身 */
const mountInputHost = (): ReturnType<typeof mount> => mount(createElement(CacheBreakConfirmHost))

const extItem = (key: string): HTMLLabelElement => {
  const hit = [...document.querySelectorAll<HTMLLabelElement>('label[data-ext-item]')].find(
    (label) => label.getAttribute('data-ext-item') === key
  )
  if (!hit) throw new Error(`extension item ${key} not rendered`)
  return hit
}
const extBox = (key: string): HTMLInputElement =>
  extItem(key).querySelector('input[type="checkbox"]') as HTMLInputElement
const kbBox = (name: string): HTMLInputElement => {
  const hit = document.querySelector<HTMLLabelElement>(`label[data-knowledge-base="${name}"]`)
  if (!hit) throw new Error(`knowledge base ${name} not rendered`)
  return hit.querySelector('input[type="checkbox"]') as HTMLInputElement
}
const dialogs = (): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>('[data-cache-break-confirm]')
]

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
}
async function answerDialog(text: string): Promise<void> {
  const [dialog] = dialogs()
  const btn = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.textContent === text
  )
  if (!btn) throw new Error(`dialog button ${text} not rendered`)
  await click(btn)
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
  api.list.mockReset().mockImplementation(async () => ITEMS)
  api.init.mockReset().mockResolvedValue({
    success: true,
    created: true,
    provider: 'p',
    model: 'm',
    workingDirectory: '/w',
    enabledTools: ['mcp:foo']
  })
  api.previewChange
    .mockReset()
    .mockResolvedValue({ locked: true, cache: 'kept', reasons: [], promptTokens: 0 })
  api.updateEnabledTools.mockReset().mockResolvedValue({ success: true })
  api.updateKnowledgeBases.mockReset().mockResolvedValue({ success: true })
  api.baseOptions.mockReset().mockResolvedValue({
    options: [{ name: 'notes', label: 'notes' }],
    selected: [],
    explicit: false
  })
  api.listAcl.mockClear()
  ;(window as unknown as { api?: unknown }).api = windowApi()
  useChatStore.setState({
    sessions: [
      {
        id: SID,
        title: 'Config',
        projectId: null,
        parentId: null,
        settings: { enabledTools: ['mcp:foo'] },
        createdAt: 0,
        updatedAt: 0,
        lastActiveAt: 0
      }
    ],
    sessionAgentCreated: {},
    sessionClosing: {}
  })
})

afterEach(async () => {
  for (const entry of mounted.splice(0).reverse()) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
  delete (window as unknown as { api?: unknown }).api
  document.body.innerHTML = ''
})

describe('SessionConfigPanel · 扩展能力（有 agent 也能改）', () => {
  it('RU-24 有 agent：勾选框都可点、没有 aria-disabled、组名旁没有锁；说明是 extensionsDesc', async () => {
    const panel = await mountPanel()
    // 面板挂载时自己回拉了一次 init：这条会话有 agent
    expect(api.init).toHaveBeenCalledWith({ sessionId: SID })
    expect(useChatStore.getState().sessionAgentCreated[SID]).toBe(true)

    for (const key of ['mcp:ctx', 'mcp:foo', 'mcp:bar']) {
      expect(extBox(key).disabled, key).toBe(false)
      expect(extItem(key).hasAttribute('aria-disabled'), key).toBe(false)
      expect(extItem(key).className, key).not.toContain('cursor-not-allowed')
    }
    expect(extBox('mcp:foo').checked).toBe(true)
    expect(document.querySelector('[data-ext-lock]')).toBeNull()

    const hint = panel.container.querySelector<HTMLElement>('[data-info-hint]')
    expect(hint).not.toBeNull()
    act(() => {
      hint!.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })
      )
    })
    const desc = i18n.t('sessionConfig.extensionsDesc')
    expect(desc).not.toBe('sessionConfig.extensionsDesc')
    expect(document.querySelector('[data-info-tip]')?.textContent).toContain(desc)
  })

  it('RU-26 勾一项 → 先预判整份新勾选；保不住 → 确认框，取消零写入；再勾、确认 → 写入', async () => {
    api.previewChange.mockResolvedValue(LOST)
    await mountPanel()

    await click(extBox('mcp:bar'))
    expect(api.previewChange).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      enabledTools: ['mcp:foo', 'mcp:bar']
    })
    expect(dialogs()).toHaveLength(1)
    expect(dialogs()[0].textContent).toContain(i18n.t('cacheBreak.reasonTools'))

    await answerDialog(i18n.t('common.cancel'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(dialogs()).toHaveLength(0)
    expect(api.updateEnabledTools).not.toHaveBeenCalled()
    expect(storedTools()).toEqual(['mcp:foo'])
    expect(extBox('mcp:bar').checked).toBe(false)

    await click(extBox('mcp:bar'))
    await answerDialog(i18n.t('cacheBreak.confirm'))
    expect(api.updateEnabledTools).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      enabledTools: ['mcp:foo', 'mcp:bar']
    })
    expect(storedTools()).toEqual(['mcp:foo', 'mcp:bar'])
    expect(extBox('mcp:bar').checked).toBe(true)
  })

  it('RU-26 知识库一行从不预判：勾一下直接 updateKnowledgeBases', async () => {
    api.previewChange.mockResolvedValue(LOST)
    await mountPanel()
    await click(kbBox('notes'))
    expect(api.updateKnowledgeBases).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      knowledgeBases: ['notes']
    })
    expect(api.previewChange).not.toHaveBeenCalled()
    expect(dialogs()).toHaveLength(0)
  })

  it('RU-25 面板与输入框各挂一个宿主 → 只有一个框；问到一半关掉面板 → 框还在、确认得了、写得进去', async () => {
    api.previewChange.mockResolvedValue(LOST)
    await mountInputHost()
    const panel = await mountPanel()

    await click(extBox('mcp:bar'))
    expect(dialogs()).toHaveLength(1)

    await panel.unmount()
    expect(dialogs()).toHaveLength(1)
    expect(api.updateEnabledTools).not.toHaveBeenCalled()

    await answerDialog(i18n.t('cacheBreak.confirm'))
    expect(dialogs()).toHaveLength(0)
    expect(api.updateEnabledTools).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      enabledTools: ['mcp:foo', 'mcp:bar']
    })
  })
})

describe('SessionConfigPanel · 技能不按会话勾选（2026-10-28）', () => {
  const extKeys = (): string[] =>
    [...document.querySelectorAll<HTMLLabelElement>('label[data-ext-item]')].map(
      (label) => label.getAttribute('data-ext-item') ?? ''
    )

  it('SC-K1 tools.list 里混着技能项也不画：只有 MCP 的三项，没有技能组名、没有 skill: 条目', async () => {
    api.list.mockImplementation(async () => [...ITEMS, ...SKILL_ITEMS])
    await mountPanel()
    expect(extKeys()).toEqual(['mcp:ctx', 'mcp:foo', 'mcp:bar'])
    // 整节在（SC-K2 的「不显示」据此才有对照）
    expect(document.body.textContent).toContain(i18n.t('sessionConfig.extensionsGroup'))
    expect(document.querySelectorAll('[data-ext-item^="skill"]')).toHaveLength(0)
    const skillsGroup = i18n.t('projectForm.skillsGroup')
    expect(skillsGroup).not.toBe('projectForm.skillsGroup')
    expect(document.body.textContent).not.toContain(skillsGroup)
  })

  it('SC-K2 没有 MCP、没有候选知识库 → 整节不显示（只有技能项也一样）', async () => {
    api.list.mockImplementation(async () => SKILL_ITEMS)
    api.baseOptions.mockResolvedValue({ options: [], selected: [], explicit: false })
    const panel = await mountPanel()
    expect(api.list).toHaveBeenCalled()
    expect(extKeys()).toEqual([])
    const title = i18n.t('sessionConfig.extensionsGroup')
    expect(title).not.toBe('sessionConfig.extensionsGroup')
    expect(panel.container.textContent).not.toContain(title)
  })
})
