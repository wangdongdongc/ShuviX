// @vitest-environment jsdom
/**
 * ModelPicker（输入框的模型选择器）DOM 测试（jsdom）—— 会话已有 Agent 运行时也能换模型（2026-10-26：
 * 后端当场重配那个 agent），所以**没有只读态**：
 *
 *   - 有没有运行时 / 关停中都一样：触发钮没有锁（没有 `data-model-lock` / `data-model-locked`），全名
 *     tooltip 照常，模型行可点（RU-14）；锁态的 prop 与文案（modelLocked / input.modelLocked）都已退役；
 *   - 选一个模型（会话里）→ 先 `agent.previewChange({sessionId, provider, model})` 问主进程会不会打穿提示词
 *     缓存（不看 sessionAgentCreated —— 有没有 agent 也由它答），预判落定之前界面不换；保得住 / 没 agent →
 *     `agent.setModel({sessionId, provider, model})`（不再带 baseUrl / apiProtocol），按新模型能力更新
 *     store；保不住 → 确认框（CacheBreakConfirmHost），取消什么都不改、确认才写；框开着时会话换了 → 确认了
 *     也不写（RU-15..19）；选的就是当前那一个 → 不预判、不写；改思考档位从不预判（RU-20）；
 *   - 后端拒绝（锁住的 agent 用不了这个模型）→ 回拉 `agent.init`：显示真实模型、能力点与勾选；init 也失败 →
 *     回到选之前显示的那一个；await 期间当前会话换了 → 既不回拉也不写能力点；
 *   - 欢迎页（没有会话）：不锁，选模型 / 改档位都只改界面，由输入框在新建会话时写进去；宿主启动时种的
 *     默认档（`seedDefaultThinkingLevel`）被点一档就不再算默认档（MP-13，点的就是种下的那一档也算），
 *     换模型不碰它（MP-14）—— 欢迎页发送据此决定写不写档位；
 *   - MP-12 思考档位一行的顺序与文案就是共享的那一份（`SELECTABLE_THINKING_LEVELS` +
 *     `THINKING_LEVEL_LABEL_KEYS`）—— 设置页的默认思考等级读的也是它，两处不各写一份。
 *
 * 包入口 `@shuvix/chat-ui` 整个顶掉（同 toolPicker.dom.test.tsx）：`getHostApi` 给 agent.setModel /
 * setThinkingLevel / app.openSettings，`getSessionChannelApi` 给 agent.init，`useChatHost().models` 是
 * 一个可变替身（setter 有记录、改了会触发重渲染，触发钮上显示的就是它）。缓存确认（CacheBreakConfirm）
 * 不经包入口、从 `api/chatApi` 取 HostApi，所以预判挂在 `window.api.agent.previewChange` 上（缺省答 none：
 * 照改不问）；要确认框的用例在旁边挂一个真的 CacheBreakConfirmHost。目录走真的 modelCatalogStore，渲染真的
 * ModelSelect；文案用同一个 i18n 实例现算。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { AgentChangePreview, AgentInitResult } from '@shuvix/chat-protocol/chatApi'
import {
  SELECTABLE_THINKING_LEVELS,
  THINKING_LEVEL_LABEL_KEYS
} from '@shuvix/chat-protocol/types/thinking'

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const models = { activeProvider: '', activeModel: '', version: 0 }
  const notify = (): void => {
    models.version += 1
    for (const l of listeners) l()
  }
  return {
    listeners,
    models,
    notify,
    setActiveProvider: vi.fn((id: string) => {
      models.activeProvider = id
      notify()
    }),
    setActiveModel: vi.fn((id: string) => {
      models.activeModel = id
      notify()
    }),
    setModel: vi.fn(),
    previewChange: vi.fn<(params: Record<string, unknown>) => Promise<AgentChangePreview>>(),
    setThinkingLevel: vi.fn(),
    openSettings: vi.fn(),
    init: vi.fn()
  }
})

vi.mock('@shuvix/chat-ui', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    getHostApi: () => ({
      agent: { setModel: mocks.setModel, setThinkingLevel: mocks.setThinkingLevel },
      app: { openSettings: mocks.openSettings }
    }),
    getSessionChannelApi: () => ({ agent: { init: mocks.init } }),
    useChatHost: () => {
      useSyncExternalStore(
        (cb: () => void) => {
          mocks.listeners.add(cb)
          return () => mocks.listeners.delete(cb)
        },
        () => mocks.models.version
      )
      return {
        models: {
          activeProvider: mocks.models.activeProvider,
          activeModel: mocks.models.activeModel,
          setActiveProvider: mocks.setActiveProvider,
          setActiveModel: mocks.setActiveModel
        }
      }
    }
  }
})

import {
  applySessionView,
  resetSessionViewStateForTests,
  useChatStore,
  type Session
} from '../../../stores/chatStore'
import { emptySessionView } from '@shuvix/chat-protocol/types/sessionView'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { ModelPicker } from '../ModelPicker'
import { ModelSelect } from '../ModelSelect'
import { CacheBreakConfirmHost } from '../CacheBreakConfirm'
import {
  ChatHostContext,
  type ChatDensity,
  type ChatHostValue
} from '../../../host/chatHostContext'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-model'
const S2 = 'sess-other'
const P = 'prov-1'
const A = 'model-a'
const B = 'model-b'

const CAPS_A = { vision: false, reasoning: false, maxInputTokens: 100_000 }
const CAPS_B = { vision: true, reasoning: true, maxInputTokens: 200_000 }

const PROVIDER: ProviderInfo = {
  id: P,
  name: 'openai',
  displayName: 'Prov One',
  apiKey: '',
  baseUrl: 'https://prov.example/v1',
  apiProtocol: 'openai-completions' as ProviderInfo['apiProtocol'],
  metadata: '',
  isBuiltin: 0,
  isEnabled: 1,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0
}
const modelRow = (modelId: string, caps: object): AvailableModel => ({
  id: `row-${modelId}`,
  providerId: P,
  modelId,
  isEnabled: 1,
  sortOrder: 0,
  capabilities: JSON.stringify(caps),
  providerName: 'openai'
})

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 手动落定的 Promise（await 期间切会话用） */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const sessionRow = (id: string, enabledTools: string[] = []): Session => ({
  id,
  title: id,
  projectId: null,
  parentId: null,
  settings: { enabledTools },
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0
})

/** 种当前会话（null = 欢迎页）+ 宿主此刻显示的模型 */
function seed(opts: {
  active: string | null
  created?: Record<string, boolean>
  closing?: Record<string, boolean>
  hostProvider?: string
  hostModel?: string
}): void {
  useChatStore.setState({
    sessions: [sessionRow(SID, ['skill:old']), sessionRow(S2)],
    sessionAgentCreated: opts.created ?? {},
    sessionClosing: opts.closing ?? {},
    // 不是宿主种子（store 是模块级单例，前一个用例的种子会串过来）；要默认档的用例自己再种
    thinkingLevel: 'medium',
    thinkingLevelIsDefault: false,
    modelSupportsReasoning: false,
    modelSupportsVision: false,
    maxContextTokens: 100_000,
    usedContextTokens: 1234,
    sessionViews: {}
  })
  // 上下文占用来自会话视图（P3-08）：两条会话的视图都报 1234
  resetSessionViewStateForTests()
  for (const id of [SID, S2]) {
    applySessionView(id, { ...emptySessionView(id), context: { usedTokens: 1234 } })
  }
  useChatStore.getState().setActiveSessionId(opts.active)
  mocks.models.activeProvider = opts.hostProvider ?? P
  mocks.models.activeModel = opts.hostModel ?? A
  mocks.notify()
}

/** 包一层宿主上下文给控件密度（手机布局给 'touch'）；不给 = 没有 Provider（compact） */
function withDensity(el: React.ReactElement, density?: ChatDensity): React.ReactElement {
  return density
    ? createElement(ChatHostContext.Provider, { value: { density } as ChatHostValue }, el)
    : el
}

/**
 * `withConfirmHost`：旁边挂一个真的确认框宿主（输入框里就挂着一个），保不住缓存时才画得出框；
 * `density`：控件密度；`readonly`：ModelPicker 的只读
 */
async function renderPicker(
  opts: { withConfirmHost?: boolean; density?: ChatDensity; readonly?: boolean } = {}
): Promise<void> {
  const Picker = ModelPicker as (props: { readonly?: boolean }) => React.JSX.Element
  const picker = opts.readonly
    ? createElement(Picker, { readonly: true })
    : createElement(ModelPicker)
  await act(async () => {
    root.render(
      withDensity(
        opts.withConfirmHost
          ? createElement(Fragment, null, picker, createElement(CacheBreakConfirmHost))
          : picker,
        opts.density
      )
    )
  })
  await flush()
}

const container0 = (): HTMLElement => {
  const el = container.firstElementChild as HTMLElement | null
  if (!el) throw new Error('model picker not rendered')
  return el
}
const trigger = (): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>('button')
  if (!el) throw new Error('trigger not rendered')
  return el
}
const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-model-panel]')
const item = (modelId: string, providerId = P): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>(
    `[data-model-item="${providerId}/${modelId}"]`
  )
  if (!el) throw new Error(`model row ${providerId}/${modelId} not rendered`)
  return el
}
const thinkingButton = (level: string): HTMLButtonElement => {
  const el = document.querySelector<HTMLButtonElement>(`[data-thinking-level="${level}"]`)
  if (!el) throw new Error(`thinking level ${level} not rendered`)
  return el
}
/** 悬浮全名 tooltip（inline、已选、面板收起时才渲染） */
const nameTooltip = (): Element | null =>
  container0().querySelector(':scope > div.pointer-events-none')

async function openPanel(): Promise<void> {
  if (panel()) return
  await act(async () => {
    trigger().click()
  })
  await flush()
  if (!panel()) throw new Error('panel did not open')
}

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
}

/** 缓存确认框（portal 到 body；不在为 null） */
const confirmDialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-cache-break-confirm]')
async function answerDialog(text: string): Promise<void> {
  const btn = [...(confirmDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.textContent === text
  )
  if (!btn) throw new Error(`dialog button ${text} not rendered`)
  await clickEl(btn)
}
/** 取消走 ConfirmDialog 的退出动画（120ms）之后才落定 */
async function cancelDialog(): Promise<void> {
  await answerDialog(i18n.t('common.cancel'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200))
  })
  await flush()
}
const preview = (over: Partial<AgentChangePreview> = {}): AgentChangePreview => ({
  locked: true,
  cache: 'kept',
  reasons: [],
  promptTokens: 0,
  ...over
})
const LOST = preview({ cache: 'lost', reasons: ['model'], promptTokens: 4321 })
const host = (): { provider: string; model: string } => ({
  provider: mocks.models.activeProvider,
  model: mocks.models.activeModel
})
const store = (): ReturnType<typeof useChatStore.getState> => useChatStore.getState()
const toolsOf = (id: string): string[] | undefined =>
  store().sessions.find((s) => s.id === id)?.settings.enabledTools

const initResult = (over: Partial<AgentInitResult> = {}): AgentInitResult => ({
  success: true,
  created: true,
  provider: P,
  model: A,
  capabilities: CAPS_A,
  modelMetadata: {} as AgentInitResult['modelMetadata'],
  workingDirectory: '/w',
  enabledTools: ['mcp:real'],
  ...over
})

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
})

beforeEach(() => {
  for (const fn of [
    mocks.setActiveProvider,
    mocks.setActiveModel,
    mocks.setModel,
    mocks.setThinkingLevel,
    mocks.openSettings,
    mocks.init
  ]) {
    fn.mockClear()
  }
  mocks.setModel.mockReset().mockResolvedValue({ success: true })
  mocks.previewChange
    .mockReset()
    .mockResolvedValue({ locked: false, cache: 'none', reasons: [], promptTokens: 0 })
  ;(window as unknown as { api?: unknown }).api = { agent: { previewChange: mocks.previewChange } }
  mocks.setThinkingLevel.mockReset().mockResolvedValue({ success: true })
  mocks.init.mockReset()
  useModelCatalogStore.setState({
    loaded: true,
    providers: [PROVIDER],
    availableModels: [modelRow(A, CAPS_A), modelRow(B, CAPS_B)]
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete (window as unknown as { api?: unknown }).api
})

describe('没有运行时：照常换模型', () => {
  it('MP-1 无锁；选 B → 先预判、再 setModel 恰一次 {sessionId, provider, model}；host 变 B、面板收起、能力点取 B', async () => {
    seed({ active: SID })
    await renderPicker()
    expect(container0().hasAttribute('data-model-locked')).toBe(false)
    expect(container.querySelector('[data-model-lock]')).toBeNull()
    expect(trigger().title).toBe('')

    await openPanel()
    expect(item(B).disabled).toBe(false)
    await clickEl(item(B))

    expect(mocks.previewChange).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(mocks.setModel).toHaveBeenCalledTimes(1)
    expect(mocks.previewChange.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setModel.mock.invocationCallOrder[0]
    )
    // 只这三个键 —— 热切换的 baseUrl / apiProtocol 覆盖值已随运行期换模型一起退役
    expect(mocks.setModel.mock.calls[0]).toEqual([{ sessionId: SID, provider: P, model: B }])
    expect(Object.keys(mocks.setModel.mock.calls[0][0]).sort()).toEqual([
      'model',
      'provider',
      'sessionId'
    ])
    expect(host()).toEqual({ provider: P, model: B })
    expect(panel()).toBeNull()
    expect(trigger().textContent).toContain(B)
    expect(store().modelSupportsVision).toBe(true)
    expect(store().maxContextTokens).toBe(200_000)
    expect(store().usedContextTokens).toBeNull()
    expect(mocks.init).not.toHaveBeenCalled()
  })
})

describe('运行时已建：照样能换模型（没有只读态）', () => {
  it('MP-2 RU-14 触发钮没有锁、悬停没有原因、全名 tooltip 照常；面板里模型行都可点、选中行高亮', async () => {
    seed({ active: SID, created: { [SID]: true } })
    await renderPicker()
    expect(container0().hasAttribute('data-model-locked')).toBe(false)
    expect(container.querySelector('[data-model-lock]')).toBeNull()
    expect(trigger().title).toBe('')
    expect(nameTooltip()).not.toBeNull()
    expect(nameTooltip()!.textContent).toBe(A)

    await openPanel()
    for (const id of [A, B]) {
      const row = item(id)
      expect(row.disabled, id).toBe(false)
      expect(row.hasAttribute('aria-disabled'), id).toBe(false)
      expect(row.title, id).toBe('')
      expect(row.className, id).not.toContain('cursor-not-allowed')
      expect(row.className, id).not.toContain('opacity-40')
    }
    expect(item(A).className).toContain('font-medium')
    expect(thinkingButton('high').disabled).toBe(false)
  })

  it('MP-2 对照：没有运行时也一样，全名 tooltip 在、触发钮没有原因', async () => {
    seed({ active: SID })
    await renderPicker()
    expect(nameTooltip()).not.toBeNull()
    expect(nameTooltip()!.textContent).toBe(A)
    expect(trigger().title).toBe('')
  })

  it('MP-3 有运行时，选 B（保得住缓存）→ 预判、再 setModel；host 变 B、面板收起', async () => {
    seed({ active: SID, created: { [SID]: true } })
    mocks.previewChange.mockResolvedValue(preview())
    await renderPicker()
    await openPanel()
    await clickEl(item(B))
    expect(mocks.previewChange).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(mocks.setModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(mocks.previewChange.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setModel.mock.invocationCallOrder[0]
    )
    expect(host()).toEqual({ provider: P, model: B })
    expect(panel()).toBeNull()
  })

  it('MP-4 有运行时点档位 → setThinkingLevel({sessionId, level})，store 的 thinkingLevel 跟着变', async () => {
    seed({ active: SID, created: { [SID]: true } })
    await renderPicker()
    await openPanel()
    await clickEl(thinkingButton('high'))
    expect(mocks.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(mocks.setThinkingLevel).toHaveBeenCalledWith({ sessionId: SID, level: 'high' })
    expect(store().thinkingLevel).toBe('high')
    expect(mocks.setModel).not.toHaveBeenCalled()
  })

  it('MP-5 只有 sessionClosing[sid] 为真（关停中）也不锁：模型行可点，选 B 照常写', async () => {
    seed({ active: SID, closing: { [SID]: true } })
    await renderPicker()
    expect(container0().hasAttribute('data-model-locked')).toBe(false)
    expect(container.querySelector('[data-model-lock]')).toBeNull()
    await openPanel()
    expect(item(B).disabled).toBe(false)
    await clickEl(item(B))
    expect(mocks.setModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
  })

  it('MP-10 sessionAgentCreated 翻来翻去什么都不变：组件不重挂（触发钮是同一个节点）、一直没有锁', async () => {
    seed({ active: SID })
    await renderPicker()
    const btn = trigger()
    const box = container0()

    for (const created of [true, false]) {
      await act(async () => {
        store().setAgentCreated(SID, created)
      })
      expect(trigger()).toBe(btn)
      expect(container0()).toBe(box)
      expect(box.hasAttribute('data-model-locked')).toBe(false)
      expect(btn.querySelector('[data-model-lock]')).toBeNull()
      expect(btn.title).toBe('')
    }
  })
})

describe('换模型之前先问缓存（RU-15..21）', () => {
  it('RU-15 选的就是当前那一个 → 不预判、不 setModel；面板收起', async () => {
    seed({ active: SID, created: { [SID]: true } })
    await renderPicker()
    await openPanel()
    await clickEl(item(A))
    expect(mocks.previewChange).not.toHaveBeenCalled()
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.setActiveModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })
  })

  it('RU-16 kept → setModel({sessionId, provider, model})；预判落定之前界面不换', async () => {
    seed({ active: SID, created: { [SID]: true } })
    const pending = deferred<AgentChangePreview>()
    mocks.previewChange.mockReturnValue(pending.promise)
    await renderPicker()
    await openPanel()
    await clickEl(item(B))

    expect(mocks.previewChange).toHaveBeenCalledTimes(1)
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.setActiveModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })

    pending.resolve(preview())
    await flush()
    expect(mocks.setModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(host()).toEqual({ provider: P, model: B })
    expect(trigger().textContent).toContain(B)
    expect(confirmDialog()).toBeNull()
  })

  it('RU-17 lost → 确认框；取消 → 不 setModel、界面仍是 A', async () => {
    seed({ active: SID, created: { [SID]: true } })
    mocks.previewChange.mockResolvedValue(LOST)
    await renderPicker({ withConfirmHost: true })
    await openPanel()
    await clickEl(item(B))

    expect(confirmDialog()).not.toBeNull()
    expect(confirmDialog()!.textContent).toContain(i18n.t('cacheBreak.reasonModel'))
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })

    await cancelDialog()
    expect(confirmDialog()).toBeNull()
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.setActiveProvider).not.toHaveBeenCalled()
    expect(mocks.setActiveModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })
    expect(trigger().textContent).toContain(A)
  })

  it('RU-18 lost → 确认框；确认 → setModel、界面换成 B', async () => {
    seed({ active: SID, created: { [SID]: true } })
    mocks.previewChange.mockResolvedValue(LOST)
    await renderPicker({ withConfirmHost: true })
    await openPanel()
    await clickEl(item(B))
    expect(mocks.setModel).not.toHaveBeenCalled()

    await answerDialog(i18n.t('cacheBreak.confirm'))
    expect(confirmDialog()).toBeNull()
    expect(mocks.setModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(host()).toEqual({ provider: P, model: B })
  })

  it('RU-19 框开着时切到 S2，再确认 → 不 setModel、界面不换', async () => {
    seed({ active: SID, created: { [SID]: true } })
    mocks.previewChange.mockResolvedValue(LOST)
    await renderPicker({ withConfirmHost: true })
    await openPanel()
    await clickEl(item(B))
    expect(confirmDialog()).not.toBeNull()

    await act(async () => {
      store().setActiveSessionId(S2)
    })
    await answerDialog(i18n.t('cacheBreak.confirm'))
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.setActiveProvider).not.toHaveBeenCalled()
    expect(mocks.setActiveModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })
  })

  it('RU-20 改思考档位从不预判（有运行时也是）', async () => {
    seed({ active: SID, created: { [SID]: true } })
    mocks.previewChange.mockResolvedValue(LOST)
    await renderPicker({ withConfirmHost: true })
    await openPanel()
    await clickEl(thinkingButton('high'))
    expect(mocks.setThinkingLevel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      level: 'high'
    })
    expect(mocks.previewChange).not.toHaveBeenCalled()
    expect(confirmDialog()).toBeNull()
  })

  it('RU-21 欢迎页选模型 → 不预判，只改界面', async () => {
    seed({ active: null, created: { [SID]: true } })
    mocks.previewChange.mockResolvedValue(LOST)
    await renderPicker({ withConfirmHost: true })
    await openPanel()
    await clickEl(item(B))
    expect(mocks.previewChange).not.toHaveBeenCalled()
    expect(confirmDialog()).toBeNull()
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: B })
  })
})

describe('欢迎页（没有会话）：只改界面', () => {
  it('MP-6 别的会话有运行时也一样；选模型不调 setModel 只改 host；改档位不调 IPC 只改 store', async () => {
    seed({ active: null, created: { [SID]: true }, closing: { [S2]: true } })
    await renderPicker()

    await openPanel()
    expect(item(B).disabled).toBe(false)
    await clickEl(item(B))
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: B })

    await openPanel()
    await clickEl(thinkingButton('low'))
    expect(mocks.setThinkingLevel).not.toHaveBeenCalled()
    expect(store().thinkingLevel).toBe('low')
  })
})

describe('欢迎页：宿主种的默认档', () => {
  it.each(['low', 'medium'])(
    'MP-13 种了默认档 medium，点 %s（同一档也算）→ 不调 IPC；store 跟过去、不再是默认档',
    async (level) => {
      seed({ active: null })
      store().seedDefaultThinkingLevel('medium')
      expect(store().thinkingLevelIsDefault).toBe(true)
      await renderPicker()
      await openPanel()
      await clickEl(thinkingButton(level))

      expect(mocks.setThinkingLevel).not.toHaveBeenCalled()
      expect(store().thinkingLevel).toBe(level)
      expect(store().thinkingLevelIsDefault).toBe(false)
    }
  )

  it('MP-14 种了默认档 medium，选模型 B → host 显示 B；档位仍是 medium、仍是默认档', async () => {
    seed({ active: null })
    store().seedDefaultThinkingLevel('medium')
    await renderPicker()
    await openPanel()
    await clickEl(item(B))

    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: B })
    expect(store().thinkingLevel).toBe('medium')
    expect(store().thinkingLevelIsDefault).toBe(true)
  })
})

describe('后端拒绝：回拉真实状态', () => {
  it('MP-7 setModel → success:false → 回拉 init：host 回 A、能力点与勾选取 init、用量不重置；没有锁冒出来', async () => {
    seed({ active: SID })
    mocks.setModel.mockResolvedValue({ success: false })
    mocks.init.mockResolvedValue(initResult())
    await renderPicker()
    await openPanel()
    await clickEl(item(B))

    expect(mocks.setModel).toHaveBeenCalledTimes(1)
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.init).toHaveBeenCalledWith({ sessionId: SID })
    expect(host()).toEqual({ provider: P, model: A })
    expect(trigger().textContent).toContain(A)
    expect(store().modelSupportsReasoning).toBe(false)
    expect(store().modelSupportsVision).toBe(false)
    expect(store().maxContextTokens).toBe(100_000)
    expect(store().sessionAgentCreated[SID]).toBe(true)
    expect(toolsOf(SID)).toEqual(['mcp:real'])
    // 模型其实没换：上下文用量照旧
    expect(store().usedContextTokens).toBe(1234)
    // init 说有 agent 也不会冒出只读态（锁的画法已退役）
    expect(container0().hasAttribute('data-model-locked')).toBe(false)
    expect(trigger().querySelector('[data-model-lock]')).toBeNull()
  })

  it('MP-7 init 带回的能力点照实写（与选的 B 无关）', async () => {
    seed({ active: SID })
    mocks.setModel.mockResolvedValue({ success: false })
    mocks.init.mockResolvedValue(
      initResult({
        model: 'model-c',
        capabilities: { reasoning: true, vision: true, maxInputTokens: 64_000 }
      })
    )
    await renderPicker()
    await openPanel()
    await clickEl(item(B))
    expect(host()).toEqual({ provider: P, model: 'model-c' })
    expect(store().modelSupportsReasoning).toBe(true)
    expect(store().modelSupportsVision).toBe(true)
    expect(store().maxContextTokens).toBe(64_000)
  })

  it('MP-8 setModel 挂着时切到 S2，随后被拒 → 不回拉 init，S1 的只读态与勾选都不写', async () => {
    seed({ active: SID })
    const pending = deferred<{ success: boolean }>()
    mocks.setModel.mockReturnValue(pending.promise)
    await renderPicker()
    await openPanel()
    await clickEl(item(B))
    expect(mocks.setModel).toHaveBeenCalledTimes(1)

    await act(async () => {
      store().setActiveSessionId(S2)
    })
    const setterCalls = mocks.setActiveModel.mock.calls.length
    pending.resolve({ success: false })
    await flush()

    expect(mocks.init).not.toHaveBeenCalled()
    expect(mocks.setActiveModel.mock.calls.length).toBe(setterCalls)
    expect(store().sessionAgentCreated[SID]).toBeUndefined()
    expect(toolsOf(SID)).toEqual(['skill:old'])
  })

  it('MP-8 被拒后 init 返回之前切到 S2 → init 的结果不落：host、能力点、S1 的只读态与勾选都不动', async () => {
    seed({ active: SID })
    mocks.setModel.mockResolvedValue({ success: false })
    const init = deferred<AgentInitResult>()
    mocks.init.mockReturnValue(init.promise)
    await renderPicker()
    await openPanel()
    await clickEl(item(B))
    expect(mocks.init).toHaveBeenCalledTimes(1)

    await act(async () => {
      store().setActiveSessionId(S2)
    })
    const before = {
      host: host(),
      max: store().maxContextTokens,
      vision: store().modelSupportsVision
    }
    const setterCalls = mocks.setActiveModel.mock.calls.length
    init.resolve(initResult({ capabilities: { vision: true, maxInputTokens: 7 } }))
    await flush()

    expect(mocks.setActiveModel.mock.calls.length).toBe(setterCalls)
    expect(host()).toEqual(before.host)
    expect(store().maxContextTokens).toBe(before.max)
    expect(store().modelSupportsVision).toBe(before.vision)
    expect(store().sessionAgentCreated[SID]).toBeUndefined()
    expect(toolsOf(SID)).toEqual(['skill:old'])
  })

  it('MP-8 接受路径：setModel 挂着时切到 S2，随后答 true → 不写能力点、不清用量', async () => {
    seed({ active: SID })
    const pending = deferred<{ success: boolean }>()
    mocks.setModel.mockReturnValue(pending.promise)
    await renderPicker()
    await openPanel()
    await clickEl(item(B))

    await act(async () => {
      store().setActiveSessionId(S2)
    })
    pending.resolve({ success: true })
    await flush()

    expect(store().modelSupportsVision).toBe(false)
    expect(store().maxContextTokens).toBe(100_000)
    expect(store().usedContextTokens).toBe(1234)
  })

  it('MP-9 被拒且 init 也 success:false → host 回到选之前显示的 provider/model', async () => {
    seed({ active: SID, hostProvider: P, hostModel: A })
    mocks.setModel.mockResolvedValue({ success: false })
    mocks.init.mockResolvedValue(initResult({ success: false, provider: 'x', model: 'y' }))
    await renderPicker()
    await openPanel()
    await clickEl(item(B))

    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(host()).toEqual({ provider: P, model: A })
    expect(trigger().textContent).toContain(A)
    // 失败的回拉不写只读态与勾选
    expect(store().sessionAgentCreated[SID]).toBeUndefined()
    expect(toolsOf(SID)).toEqual(['skill:old'])
  })
})

describe('MP-12 思考档位一行：共享的档位清单与文案', () => {
  it('MP-12 面板里 [data-thinking-level] 依次为 SELECTABLE_THINKING_LEVELS，文案为 THINKING_LEVEL_LABEL_KEYS 的译文', async () => {
    seed({ active: SID })
    await renderPicker()
    await openPanel()
    const buttons = [...panel()!.querySelectorAll<HTMLButtonElement>('[data-thinking-level]')]
    expect(buttons.map((b) => b.dataset.thinkingLevel)).toEqual([...SELECTABLE_THINKING_LEVELS])
    const expected = SELECTABLE_THINKING_LEVELS.map((level) =>
      i18n.t(THINKING_LEVEL_LABEL_KEYS[level])
    )
    expect(buttons.map((b) => (b.textContent ?? '').trim())).toEqual(expected)
    // 译文真的取到了（不是 i18next 兜底露出的原始键名）
    for (const level of SELECTABLE_THINKING_LEVELS) {
      expect(i18n.t(THINKING_LEVEL_LABEL_KEYS[level])).not.toBe(THINKING_LEVEL_LABEL_KEYS[level])
    }
  })
})

// ─── 触屏密度（手机布局）：底部抽屉 ─────────────────────────────────────────────

describe('触屏密度：模型选择从底部抽屉打开', () => {
  const TOUCH = { density: 'touch' as const }
  const sheet = (): HTMLElement | null =>
    document.querySelector<HTMLElement>('[data-touch-sheet="model"]')
  const backdrop = (): HTMLElement => {
    const el = sheet()?.querySelector<HTMLElement>('[data-touch-sheet-backdrop]')
    if (!el) throw new Error('model sheet backdrop not rendered')
    return el
  }
  const search = (): HTMLInputElement => {
    const el = panel()?.querySelector<HTMLInputElement>('input[type="text"]')
    if (!el) throw new Error('search input not rendered')
    return el
  }
  const rows = (): string[] =>
    [...document.querySelectorAll('[data-model-item]')].map(
      (el) => el.getAttribute('data-model-item') ?? ''
    )
  async function typeSearch(value: string): Promise<void> {
    const el = search()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
  }
  async function mousedown(el: Element): Promise<void> {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    })
    await flush()
  }

  it('TC-MS-T1 触发钮 [data-model-trigger] 显示 A、没有悬浮全名；点一下 → body 上的抽屉，面板不是 fixed 定位，两行模型 + 档位，搜索框不抢焦点', async () => {
    seed({ active: SID })
    await renderPicker(TOUCH)
    const btn = trigger()
    expect(btn.hasAttribute('data-model-trigger')).toBe(true)
    expect(btn.textContent).toContain(A)
    expect(nameTooltip()).toBeNull()

    await openPanel()
    const el = sheet()
    expect(el).not.toBeNull()
    expect(el!.parentElement).toBe(document.body)
    expect(container.contains(el)).toBe(false)
    const p = el!.querySelector<HTMLElement>('[data-model-panel]')
    expect(p).not.toBeNull()
    expect(p).toBe(panel())
    expect(p!.style.position).toBe('')
    expect(rows()).toEqual([`${P}/${A}`, `${P}/${B}`])
    expect(p!.querySelectorAll('[data-thinking-level]').length).toBeGreaterThan(0)
    expect(p!.querySelector('[data-thinking-level="high"]')).not.toBeNull()
    expect(document.activeElement).not.toBe(search())
  })

  it('TC-MS-T1 只读：没有 [data-model-trigger]；点那段字什么都不开', async () => {
    seed({ active: SID })
    await renderPicker({ ...TOUCH, readonly: true })
    expect(container.querySelector('[data-model-trigger]')).toBeNull()
    const span = container0().querySelector('span')
    expect(span?.textContent).toContain(A)
    await clickEl(span as HTMLElement)
    expect(sheet()).toBeNull()
    expect(panel()).toBeNull()
  })

  it('TC-MS-T2 搜 b、点遮罩 → 抽屉关、什么都不写；再开 → 搜索清空、两行都在', async () => {
    seed({ active: SID })
    await renderPicker(TOUCH)
    await openPanel()
    await typeSearch('b')
    expect(rows()).toEqual([`${P}/${B}`])
    await clickEl(backdrop())
    expect(sheet()).toBeNull()
    expect(panel()).toBeNull()
    expect(mocks.previewChange).not.toHaveBeenCalled()
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.setActiveModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })

    await openPanel()
    expect(search().value).toBe('')
    expect(rows()).toEqual([`${P}/${A}`, `${P}/${B}`])
  })

  it('TC-MS-T3 点 B → 先预判、再 setModel 恰一次（同 MP-1）；host 显示 B、抽屉关', async () => {
    seed({ active: SID })
    await renderPicker(TOUCH)
    await openPanel()
    await clickEl(item(B))
    expect(mocks.previewChange).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(mocks.setModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(mocks.previewChange.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setModel.mock.invocationCallOrder[0]
    )
    expect(host()).toEqual({ provider: P, model: B })
    expect(trigger().textContent).toContain(B)
    expect(sheet()).toBeNull()
  })

  it('TC-MS-T4 没有「点外面就关」：mousedown 在 body、在 B 行上都不关；随后点 B 照常选中', async () => {
    seed({ active: SID })
    await renderPicker(TOUCH)
    await openPanel()
    await mousedown(document.body)
    expect(sheet()).not.toBeNull()
    await mousedown(item(B))
    expect(sheet()).not.toBeNull()
    await clickEl(item(B))
    expect(mocks.setModel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      provider: P,
      model: B
    })
    expect(host()).toEqual({ provider: P, model: B })
  })

  it('TC-MS-T5 点档位 high → setThinkingLevel({sessionId, level:"high"})，抽屉不关', async () => {
    seed({ active: SID })
    await renderPicker(TOUCH)
    await openPanel()
    await clickEl(thinkingButton('high'))
    expect(mocks.setThinkingLevel).toHaveBeenCalledExactlyOnceWith({
      sessionId: SID,
      level: 'high'
    })
    expect(sheet()).not.toBeNull()
    expect(mocks.setModel).not.toHaveBeenCalled()
  })
})

describe('boxed 变体在哪都是下拉框；compact 回归', () => {
  it.each<[string, boolean]>([
    ['直接给 density="touch"', false],
    ['再套一层 touch 宿主', true]
  ])(
    'TC-MS-B1 boxed（%s）：面板是 body 的直接子节点、fixed 定位、没有抽屉；搜索框聚焦；mousedown 在 body 上就关',
    async (_label, underProvider) => {
      const select = createElement(ModelSelect, {
        variant: 'boxed',
        density: 'touch',
        availableModels: [modelRow(A, CAPS_A), modelRow(B, CAPS_B)],
        provider: P,
        model: A,
        onChange: () => {}
      })
      await act(async () => {
        root.render(underProvider ? withDensity(select, 'touch') : select)
      })
      await flush()
      await act(async () => {
        container.querySelector<HTMLButtonElement>('button')!.click()
      })
      await flush()
      const p = panel()
      expect(p).not.toBeNull()
      expect(p!.parentElement).toBe(document.body)
      expect(p!.style.position).toBe('fixed')
      expect(document.querySelector('[data-touch-sheet]')).toBeNull()
      expect(document.activeElement).toBe(p!.querySelector('input[type="text"]'))
      await act(async () => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
      await flush()
      expect(panel()).toBeNull()
    }
  )

  it('TC-MS-C1 compact：触发钮带 data-model-trigger；打开是 portal 的 fixed 面板、没有抽屉、搜索框聚焦；mousedown 在面板里不关，在 body 上关且清掉搜索', async () => {
    seed({ active: SID })
    await renderPicker()
    expect(trigger().hasAttribute('data-model-trigger')).toBe(true)
    await openPanel()
    const p = panel()!
    expect(p.parentElement).toBe(document.body)
    expect(p.style.position).toBe('fixed')
    expect(document.querySelector('[data-touch-sheet]')).toBeNull()
    const input = p.querySelector<HTMLInputElement>('input[type="text"]')!
    expect(document.activeElement).toBe(input)

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'b')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(document.querySelectorAll('[data-model-item]')).toHaveLength(1)

    await act(async () => {
      item(B).dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flush()
    expect(panel()).not.toBeNull()

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await flush()
    expect(panel()).toBeNull()
    expect(mocks.setModel).not.toHaveBeenCalled()
    // 再开：搜索是空的、两行都在（收起与打开都会清掉搜索，这里只看结果）
    await openPanel()
    expect(panel()!.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe('')
    expect(document.querySelectorAll('[data-model-item]')).toHaveLength(2)
  })
})
