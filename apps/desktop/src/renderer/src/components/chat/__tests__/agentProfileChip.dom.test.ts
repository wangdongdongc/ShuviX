// @vitest-environment jsdom
/**
 * 会话横幅的 agent 胶囊（AgentProfileChip）。
 *
 * 胶囊跟着**运行时**走，不跟着会话走：monitor 列表里有本会话的 root 条目才渲染。它是两个并排的
 * 按钮 —— 主体（相位灯 + 档案显示名）点开右栏 agents tab 并按本会话筛选；X 销毁这个运行时
 * （`agent.destroy`），是换模型 / 换扩展能力的唯一入口。这里钉的是：
 *   - 显示名取档案 md 的 displayName（空串回落档案名），档案名在 `data-agent-chip` 与悬停提示里；
 *   - X 只发一次销毁，落定之后才重拉监控（重拉先等在途的那一轮轮询），两者都落定之前 X 一直禁用；
 *   - 销毁失败只告警、照样重拉、X 恢复，不留未处理的 rejection；
 *   - 重拉回来没有 root 条目了 → 胶囊消失。
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * `useBrowserStore` 用真的，只把它底下的 `@shuvix/app-shell`（共享面板 store）与布局持久化换成小替身；
 * `window.api` 只铺胶囊与面板开合会碰的几项。i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'

vi.mock('@shuvix/app-shell', async () => {
  const { create } = await import('zustand')
  return {
    SESSION_PANEL_MIN_W: 280,
    usePanelStore: create<{
      isOpen: boolean
      activeTab: string
      width: number
      setOpen: (open: boolean) => void
      setActiveTab: (tab: string) => void
      setWidth: (width: number) => void
    }>((set) => ({
      isOpen: false,
      activeTab: 'files',
      width: 320,
      setOpen: (isOpen) => set({ isOpen }),
      setActiveTab: (activeTab) => set({ activeTab }),
      setWidth: (width) => set({ width })
    }))
  }
})
vi.mock('../../../stores/panelLayout', () => ({ persistPanelLayout: vi.fn() }))

import { usePanelStore } from '@shuvix/app-shell'
import { AgentProfileChip } from '../AgentProfileChip'
import { subscribeAgentMonitor, useAgentMonitorStore } from '../../../stores/agentMonitorStore'
import { useBrowserStore } from '../../../stores/browserStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-chip'

const api = {
  destroy: vi.fn<(sessionId: string) => Promise<{ success: boolean }>>(),
  monitorList: vi.fn<() => Promise<AgentMonitorEntry[]>>()
}
/** destroy 与 monitorList 的到达顺序 */
let order: string[] = []

function entry(over: Partial<AgentMonitorEntry> = {}): AgentMonitorEntry {
  return {
    agentId: SID,
    kind: 'root',
    rootSessionId: SID,
    depth: 0,
    profileName: 'chat',
    displayName: 'Chat Persona',
    phase: 'idle',
    startedAt: 0,
    lastActivityAt: 0,
    queue: { steer: 0, followUp: 0, nextTurn: 0 },
    counters: { turns: 0, toolCalls: 0, providerRequests: 0, aborts: 0, compactions: 0 },
    model: { provider: 'p', id: 'm', contextWindow: 1000 },
    thinkingLevel: 'medium',
    toolCount: 0,
    activeToolCount: 0,
    contextTokens: 0,
    cache: { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, reported: false },
    rootSessionExists: true,
    ...over
  } as AgentMonitorEntry
}

/** 手动落定的 Promise */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let container: HTMLDivElement
let root: Root

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function seed(entries: AgentMonitorEntry[]): void {
  useAgentMonitorStore.setState({ entries, loading: false, sessionFilter: null })
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AgentProfileChip, { sessionId: SID }))
  })
}

const chip = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-agent-chip]')
const mainButton = (): HTMLButtonElement =>
  chip()!.querySelector<HTMLButtonElement>('button:not([data-agent-chip-destroy])')!
const destroyButton = (): HTMLButtonElement =>
  chip()!.querySelector<HTMLButtonElement>('[data-agent-chip-destroy]')!
const phaseDot = (): HTMLElement => chip()!.querySelector<HTMLElement>('[data-agent-chip-phase]')!

async function clickEl(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

const tr = (key: string, opts?: Record<string, unknown>): string => {
  const text = i18n.t(key, opts)
  expect(text, key).not.toBe(key)
  return text
}

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'zh',
    resources: { zh: { translation: zh } },
    showSupportNotice: false
  })
  ;(window as unknown as { api: unknown }).api = {
    agent: api,
    app: {
      platform: 'darwin',
      adjustWindowWidth: vi.fn(async () => {}),
      setBrowserOffset: vi.fn()
    }
  }
})

beforeEach(() => {
  order = []
  api.destroy.mockReset().mockImplementation(async () => {
    order.push('destroy')
    return { success: true }
  })
  api.monitorList.mockReset().mockImplementation(async () => {
    order.push('monitorList')
    return []
  })
  usePanelStore.setState({ isOpen: false, activeTab: 'files' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('渲染：跟着本会话的 root 运行时走', () => {
  it.each<[string, AgentMonitorEntry[]]>([
    ['监控列表为空', []],
    [
      '只有本会话派生出来的 spawned',
      [entry({ agentId: 'sub-1', kind: 'spawned', depth: 1, parentAgentId: SID })]
    ],
    ['只有别的会话的 root', [entry({ agentId: 'other', rootSessionId: 'other' })]]
  ])('AC-D-1 %s → 不渲染', async (_label, entries) => {
    seed(entries)
    await mount()
    expect(chip()).toBeNull()
    expect(container.innerHTML).toBe('')
  })

  it('AC-D-2 data-agent-chip = 档案名，显示名 = displayName，主体按钮的 title / aria-label 点出两者', async () => {
    seed([entry()])
    await mount()
    expect(chip()!.getAttribute('data-agent-chip')).toBe('chat')
    expect(chip()!.querySelector('[data-agent-chip-name]')!.textContent).toBe('Chat Persona')
    const title = tr('panel.agentChipTitle', { name: 'Chat Persona', profile: 'chat' })
    expect(title).toContain('Chat Persona')
    expect(title).toContain('chat')
    expect(mainButton().title).toBe(title)
    expect(mainButton().getAttribute('aria-label')).toBe(title)
  })

  it("AC-D-2 displayName 为 '' → 回落档案名", async () => {
    seed([entry({ profileName: 'work', displayName: '' })])
    await mount()
    expect(chip()!.getAttribute('data-agent-chip')).toBe('work')
    expect(chip()!.querySelector('[data-agent-chip-name]')!.textContent).toBe('work')
    expect(mainButton().title).toBe(tr('panel.agentChipTitle', { name: 'work', profile: 'work' }))
  })

  it('AC-D-3 idle 相位灯不脉冲；turn 相位脉冲', async () => {
    seed([entry({ phase: 'idle' })])
    await mount()
    expect(phaseDot().className).not.toContain('animate-pulse')

    await act(async () => {
      seed([entry({ phase: 'turn' })])
    })
    expect(phaseDot().className).toContain('animate-pulse')
  })
})

describe('主体：打开 agents tab 并按本会话筛选', () => {
  it('AC-D-4 点主体 → 面板开、tab = agents、sessionFilter = 本会话；不销毁', async () => {
    seed([entry()])
    await mount()
    expect(useBrowserStore.getState().isOpen).toBe(false)
    await clickEl(mainButton())
    expect(useBrowserStore.getState().isOpen).toBe(true)
    expect(useBrowserStore.getState().activeTab).toBe('agents')
    expect(useAgentMonitorStore.getState().sessionFilter).toBe(SID)
    expect(api.destroy).not.toHaveBeenCalled()
    expect(api.monitorList).not.toHaveBeenCalled()
  })
})

describe('X：销毁运行时，落定后重拉监控', () => {
  it('AC-D-5 点 X → destroy(sid) 恰一次，落定之后才 monitorList；不开面板、不改筛选；X 的悬停说明', async () => {
    seed([entry()])
    await mount()
    const hint = tr('panel.agentChipDestroy')
    expect(destroyButton().title).toBe(hint)
    expect(destroyButton().getAttribute('aria-label')).toBe(hint)

    const destroyed = deferred<{ success: boolean }>()
    api.destroy.mockImplementation(() => {
      order.push('destroy')
      return destroyed.promise
    })
    await clickEl(destroyButton())
    await flush()
    expect(api.destroy).toHaveBeenCalledTimes(1)
    expect(api.destroy).toHaveBeenCalledWith(SID)
    // 关停还没落定：此刻重拉只会看到旧运行时
    expect(api.monitorList).not.toHaveBeenCalled()

    destroyed.resolve({ success: true })
    await flush()
    expect(order).toEqual(['destroy', 'monitorList'])
    expect(useBrowserStore.getState().isOpen).toBe(false)
    expect(useAgentMonitorStore.getState().sessionFilter).toBeNull()
  })

  it('AC-D-6 destroy 挂着时再点 X 只发一次；destroy 与随后的重拉都落定之前 X 一直禁用，之后恢复', async () => {
    seed([entry()])
    await mount()
    const destroyed = deferred<{ success: boolean }>()
    const listed = deferred<AgentMonitorEntry[]>()
    api.destroy.mockImplementation(() => {
      order.push('destroy')
      return destroyed.promise
    })
    api.monitorList.mockImplementation(() => {
      order.push('monitorList')
      return listed.promise
    })

    await clickEl(destroyButton())
    expect(destroyButton().disabled).toBe(true)
    // 硬点第二下（摘掉 disabled、点、再装回 —— React 只在 prop 变化时才碰 disabled）：组件自己挡住
    const btn = destroyButton()
    btn.disabled = false
    await clickEl(btn)
    btn.disabled = true
    await flush()
    expect(api.destroy).toHaveBeenCalledTimes(1)

    destroyed.resolve({ success: true })
    await flush()
    expect(api.monitorList).toHaveBeenCalledTimes(1)
    // 重拉还没回：仍禁用
    expect(destroyButton().disabled).toBe(true)

    // 重拉回来：还有 root 条目（比如下一条消息已经把它重建了）—— 胶囊在，X 恢复
    listed.resolve([entry()])
    await flush()
    expect(chip()).not.toBeNull()
    expect(destroyButton().disabled).toBe(false)
    expect(order).toEqual(['destroy', 'monitorList'])
  })

  it('AC-D-7 销毁后重拉回来没有本会话的 root 条目 → 胶囊卸载', async () => {
    seed([entry()])
    api.monitorList.mockImplementation(async () => {
      order.push('monitorList')
      return [entry({ agentId: 'other', rootSessionId: 'other' })]
    })
    await mount()
    await clickEl(destroyButton())
    await flush()
    expect(api.destroy).toHaveBeenCalledTimes(1)
    expect(api.monitorList).toHaveBeenCalledTimes(1)
    expect(chip()).toBeNull()
  })

  it('AC-D-8 destroy reject → 只告警、不留未处理的 rejection；照样重拉；X 恢复可点', async () => {
    seed([entry()])
    await mount()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      api.destroy.mockImplementation(async () => {
        order.push('destroy')
        throw new Error('ipc down')
      })
      api.monitorList.mockImplementation(async () => {
        order.push('monitorList')
        return [entry()]
      })
      await clickEl(destroyButton())
      await flush()
      await flush()

      expect(order).toEqual(['destroy', 'monitorList'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(unhandled).not.toHaveBeenCalled()
      expect(chip()).not.toBeNull()
      expect(destroyButton().disabled).toBe(false)

      // 恢复之后真能再点
      await clickEl(destroyButton())
      await flush()
      expect(api.destroy).toHaveBeenCalledTimes(2)
    } finally {
      process.off('unhandledRejection', unhandled)
      warn.mockRestore()
    }
  })

  it('AC-D-9 重拉时有一轮轮询在途 → 先等它落定，再发一次 monitorList（拿到的是销毁之后的快照）', async () => {
    // 只假掉轮询的 setInterval：订阅时立即发的那一轮由我们手动落定，其后不再有新的轮询插进来
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    seed([entry()])
    const firstPoll = deferred<AgentMonitorEntry[]>()
    api.monitorList.mockImplementationOnce(() => {
      order.push('monitorList')
      return firstPoll.promise
    })
    api.monitorList.mockImplementation(async () => {
      order.push('monitorList')
      return []
    })
    const unsubscribe = subscribeAgentMonitor()
    try {
      await mount()
      expect(api.monitorList).toHaveBeenCalledTimes(1)

      await clickEl(destroyButton())
      await flush()
      expect(api.destroy).toHaveBeenCalledTimes(1)
      // 在途那一轮发在销毁之前：重拉不能并进它，得等它落定
      expect(api.monitorList).toHaveBeenCalledTimes(1)
      expect(destroyButton().disabled).toBe(true)

      // 旧那一轮带回的是销毁前的快照（root 还在）
      firstPoll.resolve([entry()])
      await flush()
      await flush()
      expect(api.monitorList).toHaveBeenCalledTimes(2)
      expect(order).toEqual(['monitorList', 'destroy', 'monitorList'])
      // 销毁之后的快照里没有它了
      expect(chip()).toBeNull()
    } finally {
      unsubscribe()
    }
  })
})
