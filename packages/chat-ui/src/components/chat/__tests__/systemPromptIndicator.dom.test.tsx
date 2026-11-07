// @vitest-environment jsdom
/**
 * 「系统提示词的来源改了」的提示（SystemPromptIndicator；jsdom，2026-11-06）：系统提示词第一次建 agent 时冻结，
 * 之后不再自己变；主进程 `agent.systemPromptStatus` 报哪几段的来源与冻结的版本不同，就在输入卡片底部工具行、
 * 用量环左边放一个暗色小图标（用户裁决：放着不管也基本不影响体验）。点开一个小气泡，[重建] =
 * `agent.rebuildSystemPrompt`。
 *
 *   UI-1  没有 HostApi → 什么都不画、也不问
 *   UI-2  HostApi 没有这两个方法（只有其中一个也算）→ 什么都不画
 *   UI-3  sessionId 为 null → 什么都不画、不问
 *   UI-4  frozen:false / stale [] → 不画
 *   UI-5  stale [persona, project_instructions{CLAUDE.md}, knowledge_bases] → 图标：data-stale、按钮的
 *         aria-label / title = staleTitle、aria-expanded；点开气泡（role=dialog）：staleDetail 里的来源列表、
 *         提示行、[重建]；再点收起
 *   UI-6  指令文件那一段没带文件名 → 「instruction file」
 *   UI-7  跑着的时候图标照旧（不收起、不重问），重建按钮不可点、提示行是「等它停下」；一轮跑完重问恰一次
 *   UI-8  挂上、换会话、sessionAgentCreated 翻转、窗口拿到焦点、visibilitychange→visible 各问恰一次；
 *         visibilitychange→hidden 不问
 *   UI-9  回答乱序：后发的那次说了算；A→B 时 A 的回答迟到 → 不落到 B 上
 *   UI-10 查询 reject → 收起
 *   UI-11 点 [重建]：恰一次调用、等待期间按钮禁用（连点只发一次）、成功 → 气泡收起、重问，答 frozen:false → 图标消失
 *   UI-12 答 busy → 提示行换成「等它停下」、气泡还开着、按钮恢复；新的一次回答（拿到焦点 / 一轮跑完）到了才清
 *   UI-13 重建 reject → 照样重问、气泡收起；没有未处理的 rejection
 *   UI-15 （D7）重建途中切到别的会话：新会话照它自己的状态画，没有「忙」提示、按钮可用；A 的重建落定之后
 *         什么都不动（不替 A 重问，B 的图标不被盖掉）
 *   UI-16 en / zh / ja 都有 systemPrompt.{staleTitle, staleDetail（含 {{sources}}）, staleHint, rebuild, rebuildBusy,
 *         listSeparator, source.<六个段落>}；staleBanner / dismiss 已经没有了
 *   UI-17 InputArea 里图标在底部工具行、紧挨在用量环 `[data-context-ring]` 之前；只有渠道 API 的 InputArea
 *         （Chrome 侧边栏）不画
 *   UI-18 气泡开着：在外面 pointerdown / 按 Esc 收起；在气泡里 pointerdown、按别的键不收起
 *   UI-19 跑着的时候窗口拿到焦点 / 页面重新可见也不重问（图标照旧）；跑完之后照常问
 *   UI-20 气泡按会话开：A 上开着、切到 B（B 也有提示）→ B 的气泡是关的；切回 A → 仍是开的（`openFor` 还记着 A；
 *         真点侧栏切会话时，外面那一下 pointerdown 先把它收了）
 *
 * （UI-14「× 收起」随提醒条一起删了：图标没有关掉这一说。）
 *
 * 图标从 `../../api/chatApi` 取 HostApi（不经包入口），所以后端是 `window.api` 上的替身；InputArea 自己走
 * `@shuvix/chat-ui`，这里把它接到同一个真模块上（UI-17 的渠道端要真的只有 `setSessionChannelApi`）。
 * 每个用例用自己的会话 id（`fresh()`）。i18n 走真 en 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '@shuvix/chat-protocol/i18n/locales/en.json'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import ja from '@shuvix/chat-protocol/i18n/locales/ja.json'
import type {
  RebuildSystemPromptResult,
  SystemPromptStatus
} from '@shuvix/chat-protocol/systemPromptStatus'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { SessionView } from '@shuvix/chat-protocol/types/sessionView'

const mocks = vi.hoisted(() => ({
  models: { activeProvider: 'prov-1', activeModel: 'model-m' }
}))

// InputArea 走包入口：接到真的 api 模块上，渠道端（setSessionChannelApi）与完整宿主（window.api）都是真口径
vi.mock('@shuvix/chat-ui', async () => {
  const real = await import('../../../api/chatApi')
  return {
    getHostApi: real.getHostApi,
    getSessionChannelApi: real.getSessionChannelApi,
    useChatHost: () => ({
      models: {
        activeProvider: mocks.models.activeProvider,
        activeModel: mocks.models.activeModel,
        setActiveProvider: vi.fn(),
        setActiveModel: vi.fn()
      }
    })
  }
})

import { setSessionChannelApi } from '../../../api/chatApi'
import { applySessionView, selectIsStreaming, useChatStore } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { SystemPromptIndicator } from '../SystemPromptIndicator'
import { InputArea, type InputAreaProps } from '../InputArea'
import { V, assistant, resetStore, store, text, user } from '../../../__tests__/support/views'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const STALE: SystemPromptStatus = {
  frozen: true,
  stale: [
    { key: 'persona' },
    { key: 'project_instructions', file: 'CLAUDE.md' },
    { key: 'knowledge_bases' }
  ]
}
const STALE_KEYS = 'persona project_instructions knowledge_bases'
const ONLY_KNOWLEDGE: SystemPromptStatus = { frozen: true, stale: [{ key: 'knowledge_bases' }] }
const ONLY_PERSONA: SystemPromptStatus = { frozen: true, stale: [{ key: 'persona' }] }
const CURRENT: SystemPromptStatus = { frozen: true, stale: [] }
const NOT_FROZEN: SystemPromptStatus = { frozen: false, stale: [] }

const S = en.systemPrompt
const detailText = (sources: string): string => S.staleDetail.replace('{{sources}}', sources)

// ─── 替身后端 ───

/** 每条会话此刻的回答（没写 → 没冻结） */
let answers: Record<string, SystemPromptStatus>
/** 给了就把每次查询挂起，按到达次序排在这里，由用例逐个落定 */
let held: { sessionId: string; reply: Deferred<SystemPromptStatus> }[] | null
let rebuildReply: Deferred<RebuildSystemPromptResult>

const systemPromptStatus = vi.fn((sessionId: string): Promise<SystemPromptStatus> => {
  if (held) {
    const reply = deferred<SystemPromptStatus>()
    held.push({ sessionId, reply })
    return reply.promise
  }
  return Promise.resolve(answers[sessionId] ?? NOT_FROZEN)
})
const rebuildSystemPrompt = vi.fn(
  (_sessionId: string): Promise<RebuildSystemPromptResult> => rebuildReply.promise
)

function installHost(
  agent: Record<string, unknown> = { systemPromptStatus, rebuildSystemPrompt }
): void {
  ;(window as unknown as { api: unknown }).api = { agent }
}

function removeHost(): void {
  delete (window as unknown as { api?: unknown }).api
}

let counter = 0
const fresh = (label: string): string => `${label}-${++counter}`

const queriesOf = (sessionId: string): number =>
  systemPromptStatus.mock.calls.filter(([id]) => id === sessionId).length

// ─── 挂载与查询 DOM ───

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function show(sessionId: string | null): Promise<void> {
  await act(async () => {
    root.render(createElement(SystemPromptIndicator, { sessionId }))
  })
  await flush()
}

const indicator = (): HTMLElement | null =>
  container.querySelector('[data-system-prompt-indicator]')
const iconButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-system-prompt-indicator-button]')!
const popover = (): HTMLElement | null => container.querySelector('[data-system-prompt-popover]')
const rebuildButton = (): HTMLButtonElement =>
  container.querySelector<HTMLButtonElement>('[data-system-prompt-rebuild]')!
const hint = (): string | null =>
  container.querySelector('[data-system-prompt-hint]')?.textContent ?? null
/** 气泡里第一行（哪几样改了） */
const detail = (): string | null => popover()?.firstElementChild?.textContent ?? null

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

async function openPopover(): Promise<void> {
  if (!popover()) await click(iconButton())
  expect(popover()).not.toBeNull()
}

async function pointerDown(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  })
}

async function press(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

async function focusWindow(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await flush()
}

let visibility: DocumentVisibilityState = 'visible'
async function setVisibility(state: DocumentVisibilityState): Promise<void> {
  visibility = state
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await flush()
}

/** 让会话跑起来 / 停下（只经视图写，与真流程一样） */
async function run(sessionId: string, state: 'busy' | 'idle'): Promise<void> {
  await act(async () => {
    applySessionView(sessionId, V(sessionId, { run: { state } }))
  })
  await flush()
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
    showSupportNotice: false
  })
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility
  })
})

beforeEach(() => {
  answers = {}
  held = null
  rebuildReply = deferred()
  visibility = 'visible'
  systemPromptStatus.mockClear()
  rebuildSystemPrompt.mockClear()
  installHost()
  resetStore(null)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('SystemPromptIndicator · when nothing is drawn', () => {
  it('UI-1 no HostApi: nothing is drawn and nothing is asked', async () => {
    removeHost()
    const sid = fresh('ui1')
    answers[sid] = STALE
    await show(sid)
    await focusWindow()
    expect(indicator()).toBeNull()
    expect(container.innerHTML).toBe('')
    expect(systemPromptStatus).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>]>([
    ['neither method', {}],
    ['only systemPromptStatus', { systemPromptStatus }],
    ['only rebuildSystemPrompt', { rebuildSystemPrompt }]
  ])('UI-2 a HostApi with %s: nothing is drawn', async (_label, agent) => {
    installHost(agent)
    const sid = fresh('ui2')
    answers[sid] = STALE
    await show(sid)
    expect(indicator()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('UI-3 sessionId null: nothing is drawn and nothing is asked', async () => {
    await show(null)
    await focusWindow()
    expect(indicator()).toBeNull()
    expect(systemPromptStatus).not.toHaveBeenCalled()
  })

  it.each<[string, SystemPromptStatus]>([
    ['frozen:false', NOT_FROZEN],
    ['frozen:false even with stale entries', { frozen: false, stale: [{ key: 'persona' }] }],
    ['frozen with stale []', CURRENT]
  ])('UI-4 %s: nothing is drawn', async (_label, status) => {
    const sid = fresh('ui4')
    answers[sid] = status
    await show(sid)
    expect(queriesOf(sid)).toBe(1)
    expect(indicator()).toBeNull()
  })
})

describe('SystemPromptIndicator · what it says', () => {
  it('UI-5 stale persona + CLAUDE.md + knowledge bases: the icon, then the popover with the sources, the hint and [Rebuild]; a second click closes it', async () => {
    const sid = fresh('ui5')
    answers[sid] = STALE
    await show(sid)
    expect(systemPromptStatus.mock.calls).toEqual([[sid]])
    expect(indicator()).not.toBeNull()
    expect(indicator()!.getAttribute('data-stale')).toBe(STALE_KEYS)
    expect(iconButton().getAttribute('aria-label')).toBe(S.staleTitle)
    expect(iconButton().getAttribute('title')).toBe(S.staleTitle)
    expect(iconButton().getAttribute('aria-expanded')).toBe('false')
    // 只有图标：气泡要点开才有
    expect(popover()).toBeNull()

    await click(iconButton())
    expect(popover()).not.toBeNull()
    expect(popover()!.getAttribute('role')).toBe('dialog')
    expect(iconButton().getAttribute('aria-expanded')).toBe('true')
    expect(detail()).toBe(detailText('agent profile, CLAUDE.md, knowledge bases'))
    expect(hint()).toBe(S.staleHint)
    expect(rebuildButton().textContent).toBe(S.rebuild)
    expect(rebuildButton().disabled).toBe(false)
    // 点开不发任何东西
    expect(rebuildSystemPrompt).not.toHaveBeenCalled()
    expect(systemPromptStatus).toHaveBeenCalledTimes(1)

    await click(iconButton())
    expect(popover()).toBeNull()
    expect(iconButton().getAttribute('aria-expanded')).toBe('false')
    expect(iconButton().getAttribute('title')).toBe(S.staleTitle)
  })

  it('UI-5 every source key has its own label', async () => {
    const sid = fresh('ui5-all')
    answers[sid] = {
      frozen: true,
      stale: [
        { key: 'persona' },
        { key: 'placeholders' },
        { key: 'project_instructions', file: 'AGENTS.md' },
        { key: 'project_prompt' },
        { key: 'knowledge_bases' },
        { key: 'bot_profile' }
      ]
    }
    await show(sid)
    await openPopover()
    expect(detail()).toBe(
      detailText(
        [
          S.source.persona,
          S.source.placeholders,
          'AGENTS.md',
          S.source.project_prompt,
          S.source.knowledge_bases,
          S.source.bot_profile
        ].join(S.listSeparator)
      )
    )
  })

  it('UI-6 the instruction-file section without a file name reads "instruction file"', async () => {
    const sid = fresh('ui6')
    answers[sid] = { frozen: true, stale: [{ key: 'project_instructions' }] }
    await show(sid)
    await openPopover()
    expect(detail()).toBe(detailText(S.source.project_instructions))
    expect(S.source.project_instructions).toBe('instruction file')
  })

  it('UI-18 an open popover closes on a pointerdown outside and on Escape; a pointerdown inside it or another key keeps it', async () => {
    const sid = fresh('ui18')
    answers[sid] = STALE
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    await show(sid)

    await openPopover()
    await pointerDown(popover()!)
    expect(popover()).not.toBeNull()
    await pointerDown(container.querySelector('[data-system-prompt-hint]')!)
    expect(popover()).not.toBeNull()
    await press('Enter')
    expect(popover()).not.toBeNull()
    await pointerDown(outside)
    expect(popover()).toBeNull()
    expect(iconButton().getAttribute('aria-expanded')).toBe('false')

    await openPopover()
    await press('Escape')
    expect(popover()).toBeNull()

    // 收起之后外面的点按什么都不做（图标还在）
    await pointerDown(outside)
    expect(indicator()).not.toBeNull()
    expect(rebuildSystemPrompt).not.toHaveBeenCalled()
  })
  it('UI-20 the popover is open per session: opened on A, B (also stale) shows it closed; back on A it is still open', async () => {
    const a = fresh('ui20a')
    const b = fresh('ui20b')
    answers[a] = STALE
    answers[b] = ONLY_PERSONA
    await show(a)
    await openPopover()
    expect(iconButton().getAttribute('aria-expanded')).toBe('true')

    await show(b)
    expect(indicator()!.getAttribute('data-stale')).toBe('persona')
    expect(popover()).toBeNull()
    expect(iconButton().getAttribute('aria-expanded')).toBe('false')

    await show(a)
    expect(indicator()!.getAttribute('data-stale')).toBe(STALE_KEYS)
    expect(popover()).not.toBeNull()
    expect(iconButton().getAttribute('aria-expanded')).toBe('true')

    // 在 B 上打开、回到 A：A 是关的（只有一条会话的气泡开着）
    await show(b)
    await openPopover()
    await show(a)
    expect(popover()).toBeNull()
  })
})

describe('SystemPromptIndicator · when it asks', () => {
  it('UI-7 while the session runs the icon stays, the rebuild is disabled with the busy hint, nothing is asked; the run end asks exactly once', async () => {
    const sid = fresh('ui7')
    resetStore(sid)
    answers[sid] = STALE
    await show(sid)
    await openPopover()
    expect(queriesOf(sid)).toBe(1)

    await run(sid, 'busy')
    expect(selectIsStreaming(store())).toBe(true)
    // 图标与气泡照旧，不随每一轮闪一下
    expect(indicator()!.getAttribute('data-stale')).toBe(STALE_KEYS)
    expect(popover()).not.toBeNull()
    expect(rebuildButton().disabled).toBe(true)
    expect(hint()).toBe(S.rebuildBusy)
    await click(rebuildButton())
    expect(rebuildSystemPrompt).not.toHaveBeenCalled()
    // 跑着的时候不重问（agent 建好 / 关停也一样）
    await act(async () => store().setAgentCreated(sid, true))
    await flush()
    expect(queriesOf(sid)).toBe(1)

    answers[sid] = ONLY_KNOWLEDGE
    await run(sid, 'idle')
    expect(selectIsStreaming(store())).toBe(false)
    expect(queriesOf(sid)).toBe(2)
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
    expect(rebuildButton().disabled).toBe(false)
    expect(hint()).toBe(S.staleHint)
  })

  it('UI-7 an icon that was never shown does not appear mid-run from the mount query of a streaming session', async () => {
    const sid = fresh('ui7b')
    resetStore(sid)
    answers[sid] = STALE
    await run(sid, 'busy')
    await show(sid)
    // 挂上时就在跑：不问，也就没有图标
    expect(queriesOf(sid)).toBe(0)
    expect(indicator()).toBeNull()
    await run(sid, 'idle')
    expect(queriesOf(sid)).toBe(1)
    expect(indicator()).not.toBeNull()
  })

  it('UI-19 while the session runs, window focus and visibilitychange → visible ask nothing; the icon stays; after the run they ask again', async () => {
    const sid = fresh('ui19')
    resetStore(sid)
    answers[sid] = STALE
    await show(sid)
    expect(queriesOf(sid)).toBe(1)
    await run(sid, 'busy')
    answers[sid] = ONLY_KNOWLEDGE
    await focusWindow()
    await setVisibility('hidden')
    await setVisibility('visible')
    expect(queriesOf(sid)).toBe(1)
    expect(indicator()!.getAttribute('data-stale')).toBe(STALE_KEYS)

    await run(sid, 'idle')
    expect(queriesOf(sid)).toBe(2)
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
    await focusWindow()
    expect(queriesOf(sid)).toBe(3)
    await setVisibility('visible')
    expect(queriesOf(sid)).toBe(4)
  })

  it('UI-8 one query each for mount, a session change, a sessionAgentCreated flip, window focus and visibilitychange → visible; none for → hidden', async () => {
    const a = fresh('ui8a')
    const b = fresh('ui8b')
    await show(a)
    expect(systemPromptStatus.mock.calls).toEqual([[a]])

    await show(b)
    expect(systemPromptStatus.mock.calls).toEqual([[a], [b]])

    await act(async () => store().setAgentCreated(b, true))
    await flush()
    expect(systemPromptStatus).toHaveBeenCalledTimes(3)
    await act(async () => store().setAgentCreated(b, false))
    await flush()
    expect(systemPromptStatus).toHaveBeenCalledTimes(4)
    // 别的会话的 agent 翻转不算
    await act(async () => store().setAgentCreated(a, true))
    await flush()
    expect(systemPromptStatus).toHaveBeenCalledTimes(4)

    await focusWindow()
    expect(systemPromptStatus).toHaveBeenCalledTimes(5)

    await setVisibility('hidden')
    expect(systemPromptStatus).toHaveBeenCalledTimes(5)
    await setVisibility('visible')
    expect(systemPromptStatus).toHaveBeenCalledTimes(6)
    expect(systemPromptStatus.mock.calls.slice(2).every(([id]) => id === b)).toBe(true)
  })

  it('UI-8 a re-render with the same props or opening the popover does not ask again; after unmount, focus asks nothing', async () => {
    const sid = fresh('ui8c')
    answers[sid] = STALE
    await show(sid)
    await show(sid)
    await openPopover()
    expect(systemPromptStatus).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(systemPromptStatus).toHaveBeenCalledTimes(1)
    root = createRoot(container)
  })

  it('UI-9 answers out of order: the later request wins', async () => {
    const sid = fresh('ui9')
    held = []
    await show(sid)
    await focusWindow()
    expect(held.map((entry) => entry.sessionId)).toEqual([sid, sid])
    // 后发的那次先回来
    await act(async () => held![1]!.reply.resolve(ONLY_PERSONA))
    await flush()
    expect(indicator()!.getAttribute('data-stale')).toBe('persona')
    // 先发的那次迟到：不盖
    await act(async () => held![0]!.reply.resolve(CURRENT))
    await flush()
    expect(indicator()!.getAttribute('data-stale')).toBe('persona')
  })

  it('UI-9 A → B with A answering late: the late answer does not land on B', async () => {
    const a = fresh('ui9a')
    const b = fresh('ui9b')
    held = []
    await show(a)
    await show(b)
    expect(held.map((entry) => entry.sessionId)).toEqual([a, b])
    await act(async () => held![1]!.reply.resolve(ONLY_KNOWLEDGE))
    await flush()
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
    await act(async () => held![0]!.reply.resolve(ONLY_PERSONA))
    await flush()
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
  })

  it('UI-9 A → B with A answering late and B not answered yet: B shows nothing of A', async () => {
    const a = fresh('ui9c')
    const b = fresh('ui9d')
    held = []
    await show(a)
    await show(b)
    await act(async () => held![0]!.reply.resolve(STALE))
    await flush()
    expect(indicator()).toBeNull()
  })

  it('UI-10 a query that rejects hides the icon', async () => {
    const sid = fresh('ui10')
    answers[sid] = STALE
    await show(sid)
    expect(indicator()).not.toBeNull()
    systemPromptStatus.mockImplementationOnce(() => Promise.reject(new Error('closed')))
    await focusWindow()
    expect(indicator()).toBeNull()
    // 下一次回答正常又画出来
    await focusWindow()
    expect(indicator()).not.toBeNull()
  })
})

describe('SystemPromptIndicator · rebuild', () => {
  it('UI-11 one call, disabled while pending (a second click sends nothing), success → the popover closes, it asks again, frozen:false → gone', async () => {
    const sid = fresh('ui11')
    answers[sid] = STALE
    await show(sid)
    await openPopover()
    await click(rebuildButton())
    expect(rebuildSystemPrompt.mock.calls).toEqual([[sid]])
    expect(rebuildButton().disabled).toBe(true)
    await click(rebuildButton())
    expect(rebuildSystemPrompt).toHaveBeenCalledTimes(1)
    // 还没落定：不乐观收起、不重问
    expect(popover()).not.toBeNull()
    expect(queriesOf(sid)).toBe(1)

    answers[sid] = NOT_FROZEN
    await act(async () => rebuildReply.resolve({ success: true }))
    await flush()
    expect(queriesOf(sid)).toBe(2)
    expect(popover()).toBeNull()
    expect(indicator()).toBeNull()
  })

  it('UI-11 success but the sources still differ: the popover closes, the icon shows the new answer, reopening shows an enabled button', async () => {
    const sid = fresh('ui11b')
    answers[sid] = STALE
    await show(sid)
    await openPopover()
    await click(rebuildButton())
    answers[sid] = ONLY_KNOWLEDGE
    await act(async () => rebuildReply.resolve({ success: true }))
    await flush()
    expect(popover()).toBeNull()
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
    await openPopover()
    expect(rebuildButton().disabled).toBe(false)
  })

  it('UI-12 busy: the busy hint, the popover stays open, the button is re-enabled; a fresh answer on focus clears the hint', async () => {
    const sid = fresh('ui12')
    answers[sid] = STALE
    await show(sid)
    await openPopover()
    await click(rebuildButton())
    await act(async () => rebuildReply.resolve({ success: false, reason: 'busy' }))
    await flush()
    expect(popover()).not.toBeNull()
    expect(hint()).toBe(S.rebuildBusy)
    expect(rebuildButton().disabled).toBe(false)
    // 「忙」不重问
    expect(queriesOf(sid)).toBe(1)

    await focusWindow()
    expect(queriesOf(sid)).toBe(2)
    expect(hint()).toBe(S.staleHint)
    expect(popover()).not.toBeNull()
  })

  it('UI-12 busy, then the run ends: the hint clears with the answer that follows, not with the streaming change alone', async () => {
    const sid = fresh('ui12b')
    resetStore(sid)
    answers[sid] = STALE
    await show(sid)
    await openPopover()
    await click(rebuildButton())
    await act(async () => rebuildReply.resolve({ success: false, reason: 'busy' }))
    await flush()
    expect(hint()).toBe(S.rebuildBusy)

    held = []
    await run(sid, 'busy')
    expect(hint()).toBe(S.rebuildBusy)
    await run(sid, 'idle')
    expect(held.map((entry) => entry.sessionId)).toEqual([sid])
    // 跑完了、回答还没到：提示行还是「忙」（答了忙的那一次还没作废）
    expect(hint()).toBe(S.rebuildBusy)
    await act(async () => held![0]!.reply.resolve(STALE))
    await flush()
    expect(hint()).toBe(S.staleHint)
  })

  it('UI-13 a rebuild that rejects still asks again and closes the popover; no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const sid = fresh('ui13')
      answers[sid] = STALE
      await show(sid)
      await openPopover()
      await click(rebuildButton())
      answers[sid] = ONLY_PERSONA
      await act(async () => rebuildReply.reject(new Error('ipc gone')))
      await flush()
      await flush()
      expect(queriesOf(sid)).toBe(2)
      expect(popover()).toBeNull()
      expect(indicator()!.getAttribute('data-stale')).toBe('persona')
      await openPopover()
      expect(hint()).toBe(S.staleHint)
      expect(rebuildButton().disabled).toBe(false)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('UI-15 (D7) switching sessions while a rebuild is in flight: the new session shows its own status, no busy hint, an enabled button; when A settles nothing is touched', async () => {
    const a = fresh('ui15a')
    const b = fresh('ui15b')
    const outside = document.createElement('div')
    document.body.appendChild(outside)
    answers[a] = STALE
    answers[b] = ONLY_KNOWLEDGE
    await show(a)
    await openPopover()
    await click(rebuildButton())
    expect(rebuildButton().disabled).toBe(true)

    // 切会话之前先点到别处（侧栏）：气泡收起
    await pointerDown(outside)
    await show(b)
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
    await openPopover()
    // A 的「重建中」不落到 B 上
    expect(rebuildButton().disabled).toBe(false)
    expect(hint()).toBe(S.staleHint)
    const queriesOfA = queriesOf(a)

    answers[a] = NOT_FROZEN
    await act(async () => rebuildReply.resolve({ success: true }))
    await flush()
    // 已经切走：不替 A 重问，B 的图标与气泡原样
    expect(queriesOf(a)).toBe(queriesOfA)
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
    expect(popover()).not.toBeNull()
    expect(hint()).toBe(S.staleHint)
    expect(rebuildButton().disabled).toBe(false)
  })

  it('UI-15 (D7) the rebuild of A settles before B has its answer: B still gets its own answer', async () => {
    const a = fresh('ui15c')
    const b = fresh('ui15d')
    answers[a] = STALE
    await show(a)
    await openPopover()
    await click(rebuildButton())
    held = []
    await show(b)
    expect(held.map((entry) => entry.sessionId)).toEqual([b])

    await act(async () => rebuildReply.resolve({ success: true }))
    await flush()
    // A 的重建落定不发新的查询（否则 B 那一次的回答会被当成过期的丢掉）
    expect(held.map((entry) => entry.sessionId)).toEqual([b])
    await act(async () => held![0]!.reply.resolve(ONLY_KNOWLEDGE))
    await flush()
    expect(indicator()!.getAttribute('data-stale')).toBe('knowledge_bases')
  })

  it('UI-15 (D7) A answers busy after the switch: B shows no busy hint; back on A the hint is the ordinary one', async () => {
    const a = fresh('ui15e')
    const b = fresh('ui15f')
    answers[a] = STALE
    answers[b] = ONLY_KNOWLEDGE
    await show(a)
    await openPopover()
    await click(rebuildButton())
    await show(b)
    await act(async () => rebuildReply.resolve({ success: false, reason: 'busy' }))
    await flush()
    await openPopover()
    expect(hint()).toBe(S.staleHint)
    await show(a)
    expect(indicator()!.getAttribute('data-stale')).toBe(STALE_KEYS)
    await openPopover()
    expect(hint()).toBe(S.staleHint)
  })
})

describe('locales', () => {
  it('UI-16 en / zh / ja carry the systemPrompt keys; staleDetail interpolates {{sources}}; staleBanner and dismiss are gone', () => {
    const KEYS = [
      'staleTitle',
      'staleDetail',
      'staleHint',
      'rebuild',
      'rebuildBusy',
      'listSeparator'
    ]
    const SOURCES = [
      'persona',
      'placeholders',
      'project_instructions',
      'project_prompt',
      'knowledge_bases',
      'bot_profile'
    ]
    for (const [lang, locale] of [
      ['en', en],
      ['zh', zh],
      ['ja', ja]
    ] as const) {
      const block = (locale as unknown as { systemPrompt?: Record<string, unknown> }).systemPrompt
      expect(block, lang).toBeDefined()
      expect(Object.keys(block!).sort(), lang).toEqual([...KEYS, 'source'].sort())
      for (const key of KEYS) {
        expect(typeof block![key], `${lang}.${key}`).toBe('string')
        expect((block![key] as string).length, `${lang}.${key}`).toBeGreaterThan(0)
      }
      expect(block!.staleDetail as string, lang).toContain('{{sources}}')
      expect(block, lang).not.toHaveProperty('staleBanner')
      expect(block, lang).not.toHaveProperty('dismiss')
      const source = block!.source as Record<string, unknown>
      expect(Object.keys(source).sort(), lang).toEqual([...SOURCES].sort())
      for (const key of SOURCES) {
        expect(typeof source[key], `${lang}.source.${key}`).toBe('string')
        expect((source[key] as string).length, `${lang}.source.${key}`).toBeGreaterThan(0)
      }
    }
  })
})

// ─── InputArea 里的位置（UI-17）───

describe('UI-17 inside InputArea', () => {
  const P = 'prov-1'
  const M = 'model-m'

  const PROVIDER: ProviderInfo = {
    id: P,
    name: 'openai',
    displayName: 'Prov One',
    apiKey: '',
    baseUrl: '',
    apiProtocol: 'openai-completions' as ProviderInfo['apiProtocol'],
    metadata: '',
    isBuiltin: 0,
    isEnabled: 1,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const MODEL: AvailableModel = {
    id: 'row-m',
    providerId: P,
    modelId: M,
    isEnabled: 1,
    sortOrder: 0,
    capabilities: '{}',
    providerName: 'openai'
  }

  /** InputArea 要的那份后端（同 inputAreaInterrupted.dom.test.tsx），外加这两个方法 */
  function areaApi(): Record<string, unknown> {
    return {
      session: { list: async () => [] },
      agent: {
        init: async () => ({
          success: true,
          created: true,
          provider: P,
          model: M,
          capabilities: {},
          modelMetadata: {},
          workingDirectory: '/w',
          enabledTools: []
        }),
        prompt: vi.fn(() => new Promise(() => {})),
        continue: vi.fn(() => new Promise(() => {})),
        steer: vi.fn(async () => ({ success: true })),
        followUp: vi.fn(async () => ({ success: true })),
        withdrawQueued: vi.fn(async () => ({ result: 'aborted' as const })),
        abort: vi.fn(async () => ({ success: true })),
        respondToInput: async () => ({ success: true }),
        systemPromptStatus,
        rebuildSystemPrompt
      },
      tools: { list: async () => [] },
      files: { scan: async () => ({ root: null, paths: [] }) },
      mentions: { listKnowledgeEntries: async () => [] },
      events: { subscribe: () => () => {} },
      app: { openSettings: () => {} }
    }
  }

  function prepare(sid: string): void {
    useModelCatalogStore.setState({
      loaded: true,
      providers: [PROVIDER],
      availableModels: [MODEL]
    })
    resetStore(sid)
    useChatStore.setState({
      sessions: [
        {
          id: sid,
          title: sid,
          projectId: null,
          parentId: null,
          settings: {},
          createdAt: 0,
          updatedAt: 0,
          lastActiveAt: 0
        }
      ],
      slashCommands: []
    })
  }

  /** 空闲、有上一次请求的用量（用量环要有它才画） */
  function idleView(sid: string): SessionView {
    return V(sid, {
      messages: [user('u1', 'first', sid), assistant('a1', [text('ok')], sid)],
      run: { state: 'idle' },
      context: { usedTokens: 1200 }
    })
  }

  async function mountArea(props: InputAreaProps = { inline: true }): Promise<void> {
    await act(async () => {
      const Area = InputArea as (p: InputAreaProps) => React.JSX.Element
      root.render(createElement(Area, props))
    })
    await flush()
  }

  it('UI-17 the indicator sits in the bottom tool row, right before the context-usage ring', async () => {
    const sid = fresh('ui17')
    ;(window as unknown as { api: unknown }).api = areaApi()
    prepare(sid)
    answers[sid] = STALE
    await act(async () => applySessionView(sid, idleView(sid)))
    await mountArea()

    const shown = indicator()
    const ring = container.querySelector('[data-context-ring]')
    expect(shown).not.toBeNull()
    expect(ring).not.toBeNull()
    expect(systemPromptStatus).toHaveBeenCalledWith(sid)
    expect(shown!.nextElementSibling).toBe(ring)
    expect(shown!.parentElement).toBe(ring!.parentElement)
    // 不占输入区：在输入框之后（底部工具行），不是卡片顶上的一条
    const textarea = container.querySelector('textarea')!
    expect(textarea.compareDocumentPosition(shown!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // 渠道端的注入不能撤回（模块级）：这一条放在文件最后
  it('UI-17 a channel-only InputArea (setSessionChannelApi, no HostApi) shows no indicator and asks nothing', async () => {
    const sid = fresh('ui17ch')
    removeHost()
    setSessionChannelApi(areaApi() as never)
    prepare(sid)
    answers[sid] = STALE
    await act(async () => applySessionView(sid, idleView(sid)))
    await mountArea()
    // 输入卡片照常，图标没有
    expect(container.querySelector('textarea')).not.toBeNull()
    expect(container.querySelector('[data-context-ring]')).not.toBeNull()
    expect(indicator()).toBeNull()
    await focusWindow()
    expect(systemPromptStatus).not.toHaveBeenCalled()
  })
})
