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
 *   CP-1..14 `section`：只画其中一段（手机布局的会话详情页，每一段各是一页）；缺省 = 整份面板（见文件末尾的 describe）
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
import type { AclEntry } from '@shuvix/chat-protocol/sessionAcl'
import { CacheBreakConfirmHost, useChatStore } from '@shuvix/chat-ui'
import type { ToolItem } from '../common/ToolSelectList'
import { SessionConfigPanel, type SessionConfigSection } from './SessionConfigPanel'

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
  listAcl: vi.fn(async (): Promise<AclEntry[]> => [])
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
  api.listAcl.mockReset().mockImplementation(async () => [])
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

/**
 * `section`：只画其中一段（手机布局的会话详情页：每一段各是一页）。缺省 = 整份面板（桌面的弹窗与空会话页）。
 *
 *   CP-1 / CP-2 不给 `section`：整份面板照旧；文件访问一节收着还是摆开仍由 aclExpanded 定
 *   CP-3 / CP-4 `extensions` 只有 MCP 那一行、`knowledge` 只有知识库那一行；都不取权限表
 *   CP-5 / CP-6 那一行没有条目 → 什么都不画（另一行有条目也一样）
 *   CP-7 / CP-8 单段里勾选照旧：MCP 会打穿缓存的先问，知识库直接写
 *   CP-9  `paths`：只有文件访问，一开始就全摆开；不取工具清单
 *   CP-10..12 `sessions` / `widgets`：只有那一卡；没有行 → 一句空态
 *   CP-13 `knowledge` 的气泡里没有 MCP 那段说明，知识库那段还在
 *   CP-14 `extensions` 的气泡里没有知识库那段，MCP 的说明还在
 */
describe('SessionConfigPanel · section（只画一段）', () => {
  const mountSection = (section: SessionConfigSection): ReturnType<typeof mount> =>
    mount(createElement(SessionConfigPanel, { sessionId: SID, section }))

  let seq = 0
  const aclRow = (over: Partial<AclEntry>): AclEntry => {
    seq += 1
    return {
      id: `e${seq}`,
      sessionId: SID,
      kind: 'path',
      target: `/t${seq}`,
      access: 'write',
      source: 'user',
      sourceKey: '',
      createdAt: seq,
      updatedAt: seq,
      ...over
    }
  }
  const workdir = (): AclEntry => aclRow({ source: 'workdir', target: '/Users/u/proj' })
  const system = (): AclEntry => aclRow({ source: 'system', target: '/tmp/s1', sourceKey: 'tmp' })
  const sessionRow = (): AclEntry => aclRow({ kind: 'session', target: 'sess-a', access: 'read' })
  const widgetRow = (): AclEntry => aclRow({ kind: 'widget', target: 'reading', access: 'read' })
  const withRows = (...rows: AclEntry[]): void => {
    api.listAcl.mockImplementation(async () => rows)
  }
  /** 工作目录、一条收着的会话目录、一条会话行、一条小组件行 */
  const mixed = (): AclEntry[] => [workdir(), system(), sessionRow(), widgetRow()]

  const all = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)]
  const one = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel)
  const headings = (): string[] => all('h3').map((el) => el.textContent ?? '')
  const pathSources = (): string[] =>
    all('[data-session-acl] [data-acl-entry]').map((el) => el.dataset.aclSource!)
  /** 标题旁的问号气泡（悬上去才挂到 body 上） */
  const openHint = (root: HTMLElement): HTMLElement | null => {
    const btn = root.querySelector<HTMLElement>('[data-info-hint]')
    if (!btn) return null
    act(() => {
      btn.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })
      )
    })
    return one('[data-info-tip]')
  }

  beforeEach(() => {
    seq = 0
  })

  it('CP-1 不给 section：整份面板 —— 扩展能力（MCP + 知识库）与文件访问，没有空态那句话', async () => {
    withRows(workdir())
    const panel = await mountPanel()
    const first = panel.container.firstElementChild as HTMLElement
    expect(first.tagName).toBe('DIV')
    expect(first.classList.contains('space-y-5')).toBe(true)
    expect(all('label[data-ext-item]')).toHaveLength(3)
    expect(one('label[data-knowledge-base="notes"]')).not.toBeNull()
    expect(one('[data-session-acl]')).not.toBeNull()
    expect(one('[data-acl-empty]')).toBeNull()
  })

  it('CP-2 不给 section：文件访问收着还是摆开仍由 aclExpanded 定', async () => {
    withRows(workdir(), system())
    const collapsed = await mountPanel()
    expect(one('[data-acl-toggle]')!.textContent).toBe(i18n.t('sessionAcl.showAll', { count: 1 }))
    expect(pathSources()).toEqual(['workdir'])
    await collapsed.unmount()

    await mount(createElement(SessionConfigPanel, { sessionId: SID, aclExpanded: true }))
    expect(one('[data-acl-toggle]')!.textContent).toBe(i18n.t('sessionAcl.showLess'))
    expect(pathSources()).toEqual(['workdir', 'system'])
  })

  it('CP-3 extensions：只有 MCP 那一行；不取权限表、没有整份面板那层', async () => {
    withRows(...mixed())
    const panel = await mountSection('extensions')
    expect(all('label[data-ext-item]')).toHaveLength(3)
    expect(all('label[data-knowledge-base]')).toHaveLength(0)
    expect(headings()).toEqual([i18n.t('sessionConfig.extensionsGroup')])
    expect(one('[data-session-acl]')).toBeNull()
    expect(api.listAcl).not.toHaveBeenCalled()
    expect(panel.container.querySelector('.space-y-5')).toBeNull()
  })

  it('CP-4 knowledge：只有知识库那一行；不取权限表', async () => {
    withRows(...mixed())
    await mountSection('knowledge')
    expect(one('label[data-knowledge-base="notes"]')).not.toBeNull()
    expect(all('label[data-ext-item]')).toHaveLength(0)
    expect(headings()).toEqual([i18n.t('sessionConfig.knowledgeGroup')])
    expect(one('[data-session-acl]')).toBeNull()
    expect(api.listAcl).not.toHaveBeenCalled()
  })

  it('CP-5 extensions 没有 MCP：什么都不画（有候选知识库也一样）', async () => {
    api.list.mockImplementation(async () => [])
    await mountSection('extensions')
    expect(api.list).toHaveBeenCalled()
    expect(api.baseOptions).toHaveBeenCalled()
    expect(headings()).toEqual([])
    expect(all('input[type="checkbox"]')).toHaveLength(0)
  })

  it('CP-6 knowledge 没有候选库：什么都不画（有 MCP 也一样）', async () => {
    api.baseOptions.mockResolvedValue({ options: [], selected: [], explicit: false })
    await mountSection('knowledge')
    expect(api.list).toHaveBeenCalled()
    expect(headings()).toEqual([])
    expect(all('input[type="checkbox"]')).toHaveLength(0)
  })

  it('CP-7 extensions：会打穿缓存的勾选照样先问，确认才写', async () => {
    api.previewChange.mockResolvedValue(LOST)
    await mountSection('extensions')
    await click(extBox('mcp:bar'))
    expect(dialogs()).toHaveLength(1)
    expect(api.updateEnabledTools).not.toHaveBeenCalled()
    await answerDialog(i18n.t('cacheBreak.confirm'))
    expect(api.updateEnabledTools).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      enabledTools: ['mcp:foo', 'mcp:bar']
    })
  })

  it('CP-8 knowledge：勾一下直接写，不预判', async () => {
    api.previewChange.mockResolvedValue(LOST)
    await mountSection('knowledge')
    await click(kbBox('notes'))
    expect(api.updateKnowledgeBases).toHaveBeenCalledExactlyOnceWith({
      id: SID,
      knowledgeBases: ['notes']
    })
    expect(api.previewChange).not.toHaveBeenCalled()
    expect(dialogs()).toHaveLength(0)
  })

  it('CP-9 paths：只有文件访问，一开始就全摆开；不取工具清单', async () => {
    withRows(...mixed())
    await mountSection('paths')
    expect(api.listAcl).toHaveBeenCalledWith(SID)
    expect(headings()).toEqual([i18n.t('sessionAcl.title')])
    expect(pathSources()).toEqual(['workdir', 'system'])
    expect(one('[data-acl-toggle]')!.textContent).toBe(i18n.t('sessionAcl.showLess'))
    expect(one('[data-acl-add]')).not.toBeNull()
    expect(one('[data-session-acl-sessions]')).toBeNull()
    expect(one('[data-session-acl-widgets]')).toBeNull()
    expect(one('[data-acl-empty]')).toBeNull()
    expect(api.list).not.toHaveBeenCalled()
    expect(api.init).not.toHaveBeenCalled()
  })

  it('CP-10 sessions 有行：只有会话访问那一卡', async () => {
    withRows(...mixed())
    await mountSection('sessions')
    expect(headings()).toEqual([i18n.t('sessionAcl.sessionsTitle')])
    expect(one('[data-session-acl-sessions]')).not.toBeNull()
    expect(all('[data-acl-kind="session"]').map((el) => el.dataset.aclTarget)).toEqual(['sess-a'])
    expect(one('[data-session-acl]')).toBeNull()
    expect(one('[data-session-acl-widgets]')).toBeNull()
    expect(one('[data-acl-add]')).toBeNull()
    expect(one('[data-acl-empty]')).toBeNull()
  })

  it('CP-11 sessions 没有行：一句空态，没有卡', async () => {
    withRows(workdir())
    await mountSection('sessions')
    const sentence = i18n.t('sessionAcl.sessionsEmpty')
    expect(sentence).not.toBe('sessionAcl.sessionsEmpty')
    expect(one('[data-acl-empty="sessions"]')!.textContent).toBe(sentence)
    expect(all('section')).toHaveLength(0)
  })

  it('CP-12 widgets 有行：只有小组件访问那一卡', async () => {
    withRows(...mixed())
    await mountSection('widgets')
    expect(headings()).toEqual([i18n.t('sessionAcl.widgetsTitle')])
    expect(all('[data-acl-kind="widget"]').map((el) => el.dataset.aclTarget)).toEqual(['reading'])
    expect(one('[data-session-acl]')).toBeNull()
    expect(one('[data-session-acl-sessions]')).toBeNull()
    expect(one('[data-acl-add]')).toBeNull()
    expect(one('[data-acl-empty]')).toBeNull()
  })

  it('CP-12 widgets 没有行：一句空态，没有卡', async () => {
    withRows(workdir(), sessionRow())
    await mountSection('widgets')
    const sentence = i18n.t('sessionAcl.widgetsEmpty')
    expect(sentence).not.toBe('sessionAcl.widgetsEmpty')
    expect(one('[data-acl-empty="widgets"]')!.textContent).toBe(sentence)
    expect(all('section')).toHaveLength(0)
    expect(one('[data-acl-empty="sessions"]')).toBeNull()
  })

  it('CP-13 knowledge：气泡里没有 MCP 那段说明，知识库那段还在', async () => {
    const panel = await mountSection('knowledge')
    const tip = openHint(panel.container)
    expect(tip).not.toBeNull()
    const kbHint = i18n.t('sessionConfig.knowledgeDefault')
    expect(kbHint).not.toBe('sessionConfig.knowledgeDefault')
    expect(tip!.textContent).toBe(kbHint)
    expect(tip!.querySelector('[data-knowledge-hint]')?.textContent).toBe(kbHint)
    expect(tip!.textContent).not.toContain(i18n.t('sessionConfig.extensionsDesc'))
  })

  it('CP-14 extensions：气泡里没有知识库那段，MCP 的说明还在', async () => {
    const panel = await mountSection('extensions')
    const tip = openHint(panel.container)
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toBe(i18n.t('sessionConfig.extensionsDesc'))
    expect(tip!.querySelector('[data-knowledge-hint]')).toBeNull()
    expect(tip!.textContent).not.toContain(i18n.t('sessionConfig.knowledgeDefault'))
  })
})
