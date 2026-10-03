// @vitest-environment jsdom
/**
 * ModelPicker（输入框的模型选择器）DOM 测试（jsdom）—— 会话模型与扩展能力勾选同一条规矩：只在创建
 * Agent 那一刻读一次，所以**会话已有运行时（或正在关停）时锁住**：
 *
 *   - 锁住时触发钮挂 `data-model-lock`、悬停说原因（input.modelLocked），全名 tooltip 让位；面板照常
 *     能展开（思考档位仍可调），模型行 `disabled` + `aria-disabled` + 同一句原因，选中行不压暗；
 *   - 锁由组件自己挡（绕过 disabled 硬点也不写）；锁态随 store 实时翻转、组件不重挂；
 *   - 没锁时选模型 → `agent.setModel({sessionId, provider, model})`（不再带 baseUrl / apiProtocol），
 *     按新模型能力更新 store；
 *   - 后端拒绝（运行时抢先建起来了）→ 回拉 `agent.init`：显示真实模型、能力点与只读态；init 也失败 →
 *     回到选之前显示的那一个；await 期间当前会话换了 → 既不回拉也不写能力点；
 *   - 欢迎页（没有会话）：不锁，选模型 / 改档位都只改界面，由输入框在新建会话时写进去。
 *
 * 包入口 `@shuvix/chat-ui` 整个顶掉（同 toolPicker.dom.test.tsx）：`getHostApi` 给 agent.setModel /
 * setThinkingLevel / app.openSettings，`getSessionChannelApi` 给 agent.init，`useChatHost().models` 是
 * 一个可变替身（setter 有记录、改了会触发重渲染，触发钮上显示的就是它）。目录走真的
 * modelCatalogStore，渲染真的 ModelSelect；文案用同一个 i18n 实例现算。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AvailableModel, ProviderInfo } from '@shuvix/chat-protocol/types/provider'
import type { AgentInitResult } from '@shuvix/chat-protocol/chatApi'

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

import { useChatStore, type Session } from '../../../stores/chatStore'
import { useModelCatalogStore } from '../../../stores/modelCatalogStore'
import { ModelPicker } from '../ModelPicker'
import { ModelSelect } from '../ModelSelect'

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
    thinkingLevel: 'medium',
    modelSupportsReasoning: false,
    modelSupportsVision: false,
    maxContextTokens: 100_000,
    usedContextTokens: 1234
  })
  useChatStore.getState().setActiveSessionId(opts.active)
  mocks.models.activeProvider = opts.hostProvider ?? P
  mocks.models.activeModel = opts.hostModel ?? A
  mocks.notify()
}

async function renderPicker(): Promise<void> {
  await act(async () => {
    root.render(createElement(ModelPicker))
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

/** 绕过禁用态硬点（与 toolPicker.dom.test 同一个办法） */
async function forceClick(el: HTMLButtonElement): Promise<void> {
  const wasDisabled = el.disabled
  el.disabled = false
  await act(async () => {
    el.click()
  })
  el.disabled = wasDisabled
  await flush()
}

const lockedHint = (): string => {
  const text = i18n.t('input.modelLocked')
  expect(text).not.toBe('input.modelLocked')
  return text
}
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
})

describe('没有运行时：照常换模型', () => {
  it('MP-1 无锁；选 B → setModel 恰一次 {sessionId, provider, model}；host 变 B、面板收起、能力点取 B', async () => {
    seed({ active: SID })
    await renderPicker()
    expect(container0().hasAttribute('data-model-locked')).toBe(false)
    expect(container.querySelector('[data-model-lock]')).toBeNull()
    expect(trigger().title).toBe('')

    await openPanel()
    expect(item(B).disabled).toBe(false)
    await clickEl(item(B))

    expect(mocks.setModel).toHaveBeenCalledTimes(1)
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

describe('运行时已建：模型只读，思考档位照常', () => {
  it('MP-2 触发钮挂锁、悬停说原因、全名 tooltip 不渲染；面板可展开，模型行禁用 + 原因，选中行不压暗', async () => {
    seed({ active: SID, created: { [SID]: true } })
    await renderPicker()
    const hint = lockedHint()
    expect(container0().hasAttribute('data-model-locked')).toBe(true)
    expect(trigger().querySelector('[data-model-lock]')).not.toBeNull()
    expect(trigger().title).toBe(hint)
    expect(nameTooltip()).toBeNull()

    await openPanel()
    for (const id of [A, B]) {
      const row = item(id)
      expect(row.disabled, id).toBe(true)
      expect(row.getAttribute('aria-disabled'), id).toBe('true')
      expect(row.title, id).toBe(hint)
      expect(row.className, id).toContain('cursor-not-allowed')
    }
    // 选中的那一行（A）就是这条会话正在用的：不压暗；其余压暗
    expect(item(A).className).not.toContain('opacity-40')
    expect(item(B).className).toContain('opacity-40')
    // 思考档位按钮不受锁影响
    expect(thinkingButton('high').disabled).toBe(false)
  })

  it('MP-2 对照：没锁时全名 tooltip 在、触发钮没有原因', async () => {
    seed({ active: SID })
    await renderPicker()
    expect(nameTooltip()).not.toBeNull()
    expect(nameTooltip()!.textContent).toBe(A)
  })

  it('MP-3 锁定下硬点未选中行 → setModel 零调用、host 不变、面板不关', async () => {
    seed({ active: SID, created: { [SID]: true } })
    await renderPicker()
    await openPanel()
    await forceClick(item(B))
    expect(mocks.setModel).not.toHaveBeenCalled()
    expect(mocks.setActiveProvider).not.toHaveBeenCalled()
    expect(mocks.setActiveModel).not.toHaveBeenCalled()
    expect(host()).toEqual({ provider: P, model: A })
    expect(panel()).not.toBeNull()
  })

  it('MP-4 锁定下点档位 → setThinkingLevel({sessionId, level})，store 的 thinkingLevel 跟着变', async () => {
    seed({ active: SID, created: { [SID]: true } })
    await renderPicker()
    await openPanel()
    await clickEl(thinkingButton('high'))
    expect(mocks.setThinkingLevel).toHaveBeenCalledTimes(1)
    expect(mocks.setThinkingLevel).toHaveBeenCalledWith({ sessionId: SID, level: 'high' })
    expect(store().thinkingLevel).toBe('high')
    expect(mocks.setModel).not.toHaveBeenCalled()
  })

  it('MP-5 只有 sessionClosing[sid] 为真（关停中）也锁', async () => {
    seed({ active: SID, closing: { [SID]: true } })
    await renderPicker()
    expect(container0().hasAttribute('data-model-locked')).toBe(true)
    expect(trigger().querySelector('[data-model-lock]')).not.toBeNull()
    await openPanel()
    expect(item(B).disabled).toBe(true)
    await forceClick(item(B))
    expect(mocks.setModel).not.toHaveBeenCalled()
  })

  it('MP-10 锁态随 store 实时翻转，组件不重挂（触发钮是同一个节点）', async () => {
    seed({ active: SID })
    await renderPicker()
    const btn = trigger()
    const box = container0()
    expect(box.hasAttribute('data-model-locked')).toBe(false)

    await act(async () => {
      store().setAgentCreated(SID, true)
    })
    expect(trigger()).toBe(btn)
    expect(container0()).toBe(box)
    expect(box.hasAttribute('data-model-locked')).toBe(true)
    expect(btn.querySelector('[data-model-lock]')).not.toBeNull()

    await act(async () => {
      store().setAgentCreated(SID, false)
    })
    expect(trigger()).toBe(btn)
    expect(box.hasAttribute('data-model-locked')).toBe(false)
    expect(btn.querySelector('[data-model-lock]')).toBeNull()
    expect(btn.title).toBe('')
  })
})

describe('欢迎页（没有会话）：不锁，只改界面', () => {
  it('MP-6 别的会话有运行时也不锁；选模型不调 setModel 只改 host；改档位不调 IPC 只改 store', async () => {
    seed({ active: null, created: { [SID]: true }, closing: { [S2]: true } })
    await renderPicker()
    expect(container0().hasAttribute('data-model-locked')).toBe(false)
    expect(container.querySelector('[data-model-lock]')).toBeNull()

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

describe('后端拒绝：回拉真实状态', () => {
  it('MP-7 setModel → success:false → 回拉 init：host 回 A、能力点取 init、只读态出现、勾选按 init 写入、用量不重置', async () => {
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
    // 锁出现
    expect(container0().hasAttribute('data-model-locked')).toBe(true)
    expect(trigger().querySelector('[data-model-lock]')).not.toBeNull()
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

describe('MP-11 回归：ModelSelect 不传 modelLocked 时一切照旧', () => {
  const baseProps = {
    availableModels: [modelRow(A, CAPS_A), modelRow(B, CAPS_B)],
    provider: P,
    model: A,
    onChange: vi.fn()
  }

  it('MP-11 boxed 不传 modelLocked → 没有 data-model-locked、没有锁', async () => {
    await act(async () => {
      root.render(createElement(ModelSelect, { ...baseProps, variant: 'boxed' }))
    })
    expect(container.querySelector('[data-model-locked]')).toBeNull()
    expect(container.querySelector('[data-model-lock]')).toBeNull()
  })

  it.each<[string, boolean]>([
    ['不传 modelLocked', false],
    ['modelLocked 为真', true]
  ])('MP-11 inline readonly（%s）→ 只渲染 span，没有按钮、没有锁', async (_label, locked) => {
    await act(async () => {
      root.render(
        createElement(ModelSelect, {
          ...baseProps,
          variant: 'inline',
          readonly: true,
          modelLocked: locked,
          modelLockedHint: 'locked'
        })
      )
    })
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[data-model-lock]')).toBeNull()
    expect(container.textContent).toContain(A)
  })
})
