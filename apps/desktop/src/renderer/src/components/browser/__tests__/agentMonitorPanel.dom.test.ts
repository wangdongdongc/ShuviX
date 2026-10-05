// @vitest-environment jsdom
/**
 * 智能体监控面板（AgentMonitorPanel，P3-13-20…23）—— 新的条目形状：没有孤儿徽章、没有累计计数器，多了花费
 * 格（PIN-09）、会话总花费、interrupted 相位（PIN-05），缓存格按 `pi.usage` 的派生（PIN-03）。
 *
 *  20 行：没有孤儿徽章；派生行有血缘箭头、根行没有；花费格 0 → 「—」（悬停：未定价）、< 0.01 → `<$0.01`、
 *     其余 `$x.xx`；花费格不收缩、单行排版（@xl）定宽 —— 320 px 的窄面板里不会把行撑出横向滚动
 *  21 详情：没有累计计数器；队列是两个数 `steer / followUp`；花费字段是这一行自己的；只有根的详情有会话总
 *     花费；手风琴与刷新（nonce）照旧
 *  22 缓存格：三项全 0 → 空占位、详情两格「尚无用量」；有用量但没上报 → 「—」+ 未上报说明；上报了 → `NN%`，
 *     详情的最近一次取 `last`，累计不再插调用次数
 *  23 相位灯：turn 绿色脉冲、compaction 琥珀色脉冲、interrupted 不脉冲且与 idle 配色不同；摘要里的「未在运行」
 *     把 interrupted 算进去
 *
 * 桌面 vitest 对渲染层只收 `*.test.ts`（本文件自己切 jsdom），不带 react 插件 —— 一律 createElement。
 * 面板以 `active: false` 挂载（不起轮询），条目直接灌进 store；`window.api.agent` 只铺 monitorList / monitorDetail。
 * i18n 走真 zh 资源。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import zh from '@shuvix/chat-protocol/i18n/locales/zh.json'
import type { AgentMonitorEntry } from '@shuvix/chat-protocol/types/agentMonitor'
import type { AgentRuntimeInfo } from '@shuvix/chat-protocol/chatApi'
import { AgentMonitorPanel } from '../AgentMonitorPanel'
import { useAgentMonitorStore } from '../../../stores/agentMonitorStore'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const SID = 'sess-mon'

const api = {
  monitorList: vi.fn<() => Promise<AgentMonitorEntry[]>>(),
  monitorDetail: vi.fn<(agentId: string) => Promise<AgentRuntimeInfo | null>>()
}

function entry(over: Partial<AgentMonitorEntry> = {}): AgentMonitorEntry {
  return {
    agentId: SID,
    kind: 'root',
    rootSessionId: SID,
    depth: 0,
    profileName: 'work',
    displayName: 'Work',
    phase: 'idle',
    startedAt: 0,
    lastActivityAt: Date.now(),
    queue: { steer: 0, followUp: 0 },
    model: { provider: 'faux', id: 'faux-1', contextWindow: 1000 },
    thinkingLevel: 'off',
    toolCount: 2,
    contextTokens: 0,
    cache: { input: 0, cacheRead: 0, cacheWrite: 0, reported: false },
    cost: { total: 0 },
    sessionCost: 0,
    rootSessionTitle: 'Session',
    ...over
  }
}

const ROOT = entry({ cost: { total: 1.234 }, sessionCost: 2.5, queue: { steer: 1, followUp: 2 } })
const SPAWNED = entry({
  agentId: 'sub-a',
  kind: 'spawned',
  parentAgentId: SID,
  depth: 1,
  profileName: 'explore',
  displayName: 'Explorer',
  dispatch: 'tool',
  cost: { total: 0.004 }
})
const HOOK = entry({
  agentId: 'sub-h',
  kind: 'spawned',
  parentAgentId: SID,
  depth: 1,
  profileName: 'titler',
  displayName: 'Titler',
  dispatch: 'hook',
  cost: { total: 0 }
})

const INFO: AgentRuntimeInfo = {
  systemPrompt: 'You are work',
  model: {
    provider: 'faux',
    id: 'faux-1',
    name: 'faux-1',
    api: 'faux',
    contextWindow: 1000,
    maxTokens: 100,
    reasoning: false,
    input: ['text']
  },
  thinkingLevel: 'off',
  tools: [],
  messageCount: 2,
  isStreaming: false
}

let container: HTMLDivElement
let root: Root
let seeded: AgentMonitorEntry[] = []

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(entries: AgentMonitorEntry[]): Promise<void> {
  seeded = entries
  useAgentMonitorStore.setState({ entries, loading: false, sessionFilter: null })
  await act(async () => {
    root.render(createElement(AgentMonitorPanel, { active: false }))
  })
  await flush()
}

const rows = (): HTMLButtonElement[] => [
  ...container.querySelectorAll<HTMLButtonElement>('.divide-y > div > button.w-full')
]
const rowBox = (i: number): HTMLElement => rows()[i]!.parentElement!
const detailOf = (i: number): HTMLElement | null =>
  (rowBox(i).children[1] as HTMLElement | undefined) ?? null
const costCell = (i: number): HTMLElement =>
  rows()[i]!.querySelector<HTMLElement>('[data-agent-cost]')!
const phaseDot = (i: number): HTMLElement =>
  rows()[i]!.querySelector<HTMLElement>('[data-agent-phase]')!

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
  await flush()
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
  ;(window as unknown as { api: unknown }).api = { agent: api }
})

beforeEach(() => {
  api.monitorList.mockReset().mockImplementation(async () => seeded)
  api.monitorDetail.mockReset().mockResolvedValue(INFO)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('P3-13-20 rows', () => {
  it('P3-13-20 no orphan badge; the spawned rows carry the lineage arrow, the root does not', async () => {
    await mount([ROOT, SPAWNED, HOOK])
    expect(rows()).toHaveLength(3)
    expect(container.querySelector('span[class*="bg-error/10"]')).toBeNull()
    expect(i18n.exists('settings.agentMonitorOrphan')).toBe(false)
    expect(container.textContent).not.toContain('孤儿')
    expect(rows()[0]!.querySelector('.lucide-corner-down-right')).toBeNull()
    expect(rows()[1]!.querySelector('.lucide-corner-down-right')).not.toBeNull()
    expect(rows()[2]!.querySelector('.lucide-corner-down-right')).not.toBeNull()
  })

  it('P3-13-20 the cost cell (PIN-09): 1.234 → $1.23, 0.004 → <$0.01, 0 → — with the unpriced title', async () => {
    await mount([ROOT, SPAWNED, HOOK])
    expect(costCell(0).textContent).toBe('$1.23')
    expect(costCell(0).title).toBe(tr('panel.agentCostTitle'))
    expect(costCell(1).textContent).toBe('<$0.01')
    expect(costCell(1).title).toBe(tr('panel.agentCostTitle'))
    expect(costCell(2).textContent).toBe('—')
    expect(costCell(2).title).toBe(tr('panel.agentCostUnpricedTitle'))
    expect(costCell(2).title).not.toBe(costCell(0).title)
  })

  it('P3-13-20 at a narrow (320 px) container the cost cell never grows the row: shrink-0, fixed width only at @xl', async () => {
    container.style.width = '320px'
    await mount([ROOT])
    const cell = costCell(0)
    const classes = cell.className.split(/\s+/)
    expect(classes).toContain('shrink-0')
    expect(classes).toContain('@xl:w-14')
    expect(classes.some((c) => /^w-/.test(c))).toBe(false)
    // 标题与模型可收缩（min-w-0 + truncate），是窄面板不溢出的另一半
    const shrinkable = rows()[0]!.querySelectorAll('.min-w-0.truncate')
    expect(shrinkable.length).toBeGreaterThanOrEqual(2)
  })
})

describe('P3-13-21 detail', () => {
  it('P3-13-21 no totals field; queue is two numbers; the own cost; the session total on the root only', async () => {
    await mount([ROOT, SPAWNED])
    await click(rows()[0]!)
    const rootDetail = detailOf(0)!
    expect(api.monitorDetail).toHaveBeenCalledWith(SID)
    expect(i18n.exists('settings.agentMonitorFieldCounters')).toBe(false)
    expect(rootDetail.textContent).not.toContain('累计')
    expect(rootDetail.querySelector('[data-agent-field="queue"]')!.textContent).toBe('1 / 2')
    expect(rootDetail.querySelector('[data-agent-field="cost"]')!.textContent).toContain('$1.23')
    expect(rootDetail.textContent).toContain(tr('settings.agentMonitorFieldCost'))
    expect(rootDetail.querySelector('[data-agent-field="session-cost"]')!.textContent).toBe('$2.50')
    expect(rootDetail.textContent).toContain(tr('settings.agentMonitorFieldSessionCost'))
    expect(rootDetail.textContent).toContain(tr('settings.agentMonitorFieldTools'))

    // 手风琴：展开另一条，前一条收起
    await click(rows()[1]!)
    expect(detailOf(0)).toBeNull()
    const spawnedDetail = detailOf(1)!
    expect(spawnedDetail.querySelector('[data-agent-field="session-cost"]')).toBeNull()
    expect(spawnedDetail.querySelector('[data-agent-field="cost"]')!.textContent).toContain(
      '<$0.01'
    )
    expect(spawnedDetail.querySelector('[data-agent-field="queue"]')!.textContent).toBe('0 / 0')
    // 点同一条 = 收起
    await click(rows()[1]!)
    expect(detailOf(1)).toBeNull()
  })

  it('P3-13-21 an unpriced row: the cost field reads — with the unpriced note; refresh (nonce) re-reads the detail', async () => {
    await mount([HOOK])
    await click(rows()[0]!)
    const field = detailOf(0)!.querySelector('[data-agent-field="cost"]')!
    expect(field.textContent).toContain('—')
    expect(field.textContent).toContain(tr('settings.agentMonitorCostUnpriced'))
    expect(api.monitorDetail).toHaveBeenCalledTimes(1)
    const refresh = container.querySelector<HTMLButtonElement>(
      `button[title="${tr('common.refresh')}"]`
    )!
    await click(refresh)
    expect(api.monitorDetail).toHaveBeenCalledTimes(2)
    expect(api.monitorList).toHaveBeenCalledTimes(1)
  })
})

describe('P3-13-22 cache cell and fields', () => {
  const cacheCell = (i: number): HTMLElement | null =>
    rows()[i]!.querySelector('svg.lucide-database-zap')?.parentElement ?? null
  const fields = (i: number): { total: string; last: string } => ({
    total: detailOf(i)!.querySelector('[data-cache-hit="total"]')!.textContent ?? '',
    last: detailOf(i)!.querySelector('[data-cache-hit="last"]')!.textContent ?? ''
  })

  it('P3-13-22 all totals 0 → empty placeholder; both detail fields read "no usage yet"', async () => {
    await mount([entry()])
    expect(cacheCell(0)).toBeNull()
    await click(rows()[0]!)
    const none = tr('settings.agentMonitorCacheNone')
    expect(fields(0)).toEqual({ total: none, last: none })
  })

  it('P3-13-22 totals > 0 but never reported → — with the unreported title', async () => {
    await mount([
      entry({
        cache: {
          input: 50,
          cacheRead: 0,
          cacheWrite: 0,
          reported: false,
          last: { input: 50, cacheRead: 0, cacheWrite: 0 }
        }
      })
    ])
    expect(cacheCell(0)!.textContent).toBe('—')
    expect(cacheCell(0)!.title).toBe(tr('panel.agentCacheUnreportedTitle'))
    await click(rows()[0]!)
    const unreported = tr('settings.agentMonitorCacheUnreported')
    expect(fields(0)).toEqual({ total: unreported, last: unreported })
  })

  it('P3-13-22 reported → NN% (token-weighted); the last field comes from last; no call count', async () => {
    await mount([
      entry({
        cache: {
          input: 100,
          cacheRead: 300,
          cacheWrite: 0,
          reported: true,
          last: { input: 1, cacheRead: 1, cacheWrite: 0 }
        }
      })
    ])
    expect(cacheCell(0)!.textContent).toBe('75%')
    expect(cacheCell(0)!.title).toBe(tr('panel.agentCacheHitTitle'))
    await click(rows()[0]!)
    expect(fields(0)).toEqual({ total: '75.0%', last: '50.0%' })
    expect(zh.settings.agentMonitorCacheHit).not.toContain('{{calls}}')
  })
})

describe('P3-13-23 phase dot', () => {
  it('P3-13-23 turn emerald + pulse; compaction amber + pulse; interrupted no pulse and unlike idle; the summary counts interrupted as not running', async () => {
    await mount([
      entry({ agentId: 'a', rootSessionId: 'a', phase: 'turn' }),
      entry({ agentId: 'b', rootSessionId: 'b', phase: 'compaction' }),
      entry({ agentId: 'c', rootSessionId: 'c', phase: 'interrupted' }),
      entry({ agentId: 'd', rootSessionId: 'd', phase: 'idle' })
    ])
    const [turn, compaction, interrupted, idle] = [0, 1, 2, 3].map((i) => phaseDot(i).className)
    expect(turn).toContain('bg-emerald-500')
    expect(turn).toContain('animate-pulse')
    expect(compaction).toContain('bg-amber-500')
    expect(compaction).toContain('animate-pulse')
    expect(interrupted).not.toContain('animate-pulse')
    expect(idle).not.toContain('animate-pulse')
    expect(interrupted).not.toBe(idle)
    expect(container.textContent).toContain(
      tr('settings.agentMonitorSummary', { total: 4, idle: 2 })
    )
    await click(rows()[2]!)
    expect(detailOf(2)!.textContent).toContain(tr('settings.agentMonitorPhase_interrupted'))
  })
})
