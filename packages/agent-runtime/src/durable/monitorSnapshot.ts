/**
 * 监控快照（P3-13，Monitor → Agents）—— 一条打开着的会话里每个 agent 的廉价快照，设置页每秒轮询。
 *
 * 列哪些（PIN-02）：锁着时的根 agent（锁所在的对话），以及**加载在这个 Harness 里**的派生 agent —— 它的
 * `shuvix.agent.<conv>` 扩展装着（派发 / 追问 / 打开时重建 / `ensureInstalled` 都会装，销毁会卸），或者它的
 * 对话上有活任务。hook agent 也算。durable 永远留着每一次起标题、每一次审查的对话，按记录全列会让重开过的
 * 会话越列越长；闲着、没装的历史 agent 不列（详情照样能按 agentId 读，见宿主）。
 *
 * 数从哪来（每行一个对话）：
 *  - 相位：会话自己维护的活任务表（`pi.generation` → turn、`pi.compaction` → compaction；调度器停着时留下的
 *    生成 → interrupted，PIN-05），在跑的工具名取 `pi.live` 里 running 的工具槽；
 *  - 模型 / 思考档位 / 工具数：`pi.agent`（模型按注册表现查窗口，查不到 → 0，从不抛）；
 *  - 缓存与花费：这个对话自己的 `pi.usage`（PIN-03：花费账本，重试 / 中止 / 零内容 / 压缩都算）；会话花费 =
 *    `harness.usage()`，按 `pi.usage` 的修订号缓存；
 *  - 上下文占用（PIN-04）：活上下文里最新一条带用量的 assistant 的 `calculateContextTokens`（durable 的
 *    `estimateContext` 同一判据：头标记之后、被排除的停止原因不算）；`last` 与 `lastActivityAt` 同一次
 *    由新到旧的条目扫描给出；
 *  - 队列：`pi.inbox` 里的 steer / followUp（被动写入与通知形状的插话不算，与 `view.queue` 同一分类）。
 *
 * 只读、廉价：不提交、不开启调度器、不挂投影、不留任何订阅，也不刷新 LRU 新近度（宿主轮询它，刷新会让
 * 每条打开着的会话都显得「刚用过」）。
 */
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  AssistantEntry,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type ConversationId,
  type Cursor,
  type EntryRecord,
  type Harness,
  type UsageState
} from '@earendil-works/pi-durable'
import type {
  AgentMonitorCacheUsage,
  AgentMonitorEntry,
  AgentMonitorPhase
} from '@shuvix/chat-protocol/types/agentMonitor'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import type { SpawnedAgentRecord } from './agentRecord'
import { backgroundContext as BG } from './context'
import type { LockRecord } from './lock'
import { tsOf, userText } from './projection/entryText'

/**
 * 运行时给出的一行：宿主补会话标题、根的显示名（根档案的 `shuvix-displayName`）之后就是
 * `AgentMonitorEntry`。`conversationId` 只给宿主（详情按它读 `agentInfo`），不上 IPC。
 */
export type AgentMonitorRow = Omit<AgentMonitorEntry, 'displayName' | 'rootSessionTitle'> & {
  /** 派生 agent 的显示名（记录里的）；根没有 —— 宿主按档案补 */
  displayName?: string
  conversationId: number
}

/** 快照要向会话要的那几样（全是同步读或原始 Harness 上的只读） */
export interface MonitorSnapshotHost {
  readonly sessionId: string
  /** 原始 Harness（不经开启调度器的观测；这里只读） */
  readonly harness: Harness
  readonly now: () => number
  readonly lock: LockRecord | undefined
  /** 解析得了的派生 agent 记录 */
  readonly spawnedRecords: readonly SpawnedAgentRecord[]
  /** 某对话的派生记录（父 agent 的 agentId 用） */
  record(conversationId: ConversationId): SpawnedAgentRecord | undefined
  /** 某对话的按 agent 扩展装着没有 */
  installed(conversationId: ConversationId): boolean
  /** 此刻活着的任务（对话 + 任务种类） */
  readonly liveTasks: readonly { readonly conversationId: ConversationId; readonly kind: string }[]
  /** 调度器开着没有（停着 = 留下的工作是被中断的） */
  readonly schedulerRunning: boolean
  /** 模型的上下文窗口（注册表现查；查不到 → 0） */
  contextWindowOf(ref: { provider: string; modelId: string } | undefined): number
  /** 会话花费（缓存过的 `harness.usage()` 合计） */
  sessionCost(): Promise<number>
}

const GENERATION = 'pi.generation'
const COMPACTION = 'pi.compaction'
/** durable 推导上下文时排除的 assistant 停止原因（`deriveContext` 的 EXCLUDED_STOP_REASONS） */
const EXCLUDED_STOP_REASONS = new Set(['aborted', 'error', 'deferred'])
const ENTRY_PAGE = 32

/** 一条会话的监控行：根（锁着时）在前，派生的按对话 id 升序 */
export async function collectMonitorRows(host: MonitorSnapshotHost): Promise<AgentMonitorRow[]> {
  const live = new Set(host.liveTasks.map((task) => task.conversationId))
  const listed = host.spawnedRecords.filter(
    (record) => host.installed(record.conversationId) || live.has(record.conversationId)
  )
  if (host.lock === undefined && listed.length === 0) return []
  const sessionCost = await host.sessionCost()
  const rows: AgentMonitorRow[] = []
  const lock = host.lock
  if (lock !== undefined) {
    const shared = await conversationFigures(host, lock.conversationId, lock, lock.createdAt)
    rows.push({
      agentId: host.sessionId,
      kind: 'root',
      rootSessionId: host.sessionId,
      depth: 0,
      profileName: lock.profileName,
      conversationId: lock.conversationId,
      startedAt: lock.createdAt,
      ...shared,
      sessionCost
    })
  }
  for (const record of listed) {
    const shared = await conversationFigures(
      host,
      record.conversationId,
      record,
      record.createdAt
    )
    rows.push({
      agentId: record.agentId,
      kind: 'spawned',
      rootSessionId: host.sessionId,
      parentAgentId: host.record(record.parentConversationId)?.agentId ?? host.sessionId,
      depth: record.depth,
      profileName: record.profileName,
      displayName: record.displayName,
      dispatch: record.dispatch,
      conversationId: record.conversationId,
      startedAt: record.createdAt,
      ...shared,
      sessionCost
    })
  }
  return rows
}

/** 一个对话上与身份无关的那些数 */
type ConversationFigures = Pick<
  AgentMonitorRow,
  | 'phase'
  | 'lastActivityAt'
  | 'activeToolName'
  | 'queue'
  | 'model'
  | 'thinkingLevel'
  | 'toolCount'
  | 'contextTokens'
  | 'cache'
  | 'cost'
>

async function conversationFigures(
  host: MonitorSnapshotHost,
  conversationId: ConversationId,
  record: LockRecord,
  startedAt: number
): Promise<ConversationFigures> {
  const { harness } = host
  const agent = await harness.snapshot(AgentDoc, conversationId, BG)
  const usage = await harness.snapshot(UsageDoc, conversationId, BG)
  const inbox = await harness.snapshot(InboxDoc, conversationId, BG)
  const liveDoc = await harness.snapshot(LiveDoc, conversationId, BG)

  const phase = phaseOf(host, conversationId, (liveDoc?.compactions?.length ?? 0) > 0)
  const totals = usageTotals(usage)
  const scan = await scanEntries(harness, conversationId, totals.any)
  const ref = agent?.model ?? record.model
  const running = phase === 'turn' || phase === 'compaction'
  const activeToolName =
    phase === 'turn' ? liveDoc?.tools?.find((slot) => slot.status === 'running')?.name : undefined

  return {
    phase,
    lastActivityAt: running ? host.now() : (scan.lastTimestamp ?? startedAt),
    ...(activeToolName === undefined ? {} : { activeToolName }),
    queue: queueCounts(inbox?.items),
    model: {
      provider: ref?.provider ?? '',
      id: ref?.modelId ?? '',
      contextWindow: host.contextWindowOf(ref)
    },
    thinkingLevel: agent?.thinkingLevel ?? 'off',
    toolCount: Array.isArray(agent?.tools) ? agent.tools.length : record.toolNames.length,
    contextTokens: scan.contextTokens,
    cache: {
      ...totals.cache,
      ...(scan.last === undefined ? {} : { last: scan.last })
    },
    cost: { total: totals.cost }
  }
}

/** 相位（PIN-05）：调度器停着时留下的生成 = interrupted；开着时压缩优先于生成 */
function phaseOf(
  host: MonitorSnapshotHost,
  conversationId: ConversationId,
  compactionListed: boolean
): AgentMonitorPhase {
  let generation = false
  let compaction = compactionListed
  for (const task of host.liveTasks) {
    if (task.conversationId !== conversationId) continue
    if (task.kind === GENERATION) generation = true
    else if (task.kind === COMPACTION) compaction = true
  }
  if (!host.schedulerRunning) return generation ? 'interrupted' : 'idle'
  if (compaction) return 'compaction'
  return generation ? 'turn' : 'idle'
}

/** 排着的用户输入（PIN-16 of P3-02：写入不算，通知形状的插话是系统写的，也不算） */
function queueCounts(items: readonly unknown[] | undefined): AgentMonitorEntry['queue'] {
  const queue = { steer: 0, followUp: 0 }
  for (const item of items ?? []) {
    if (typeof item !== 'object' || item === null) continue
    const { mode, content } = item as { mode?: unknown; content?: unknown }
    if (mode !== 'steer' && mode !== 'followUp') continue
    if (isSystemNoticeText(userText(content as Parameters<typeof userText>[0]))) continue
    queue[mode]++
  }
  return queue
}

interface UsageTotals {
  cache: Omit<AgentMonitorCacheUsage, 'last'>
  cost: number
  /** 账本里有没有任何 token 用量（按模型的桶） */
  any: boolean
}

/** 一个对话的 `pi.usage`：缓存三项只取按模型的桶，花费取两种桶的合计 */
function usageTotals(state: Readonly<UsageState> | undefined): UsageTotals {
  let input = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  let any = false
  for (const usage of Object.values(state?.models ?? {})) {
    if (contextTokensOf(usage) > 0) any = true
    input += finite(usage.input)
    cacheRead += finite(usage.cacheRead)
    cacheWrite += finite(usage.cacheWrite)
    cost += finite(usage.cost?.total)
  }
  for (const usage of Object.values(state?.tools ?? {})) cost += finite(usage.cost?.total)
  return {
    cache: { input, cacheRead, cacheWrite, reported: cacheRead > 0 || cacheWrite > 0 },
    cost,
    any
  }
}

/** 整条会话的花费：`harness.usage()` 两种桶的 `cost.total` 合计 */
export function totalCost(state: Readonly<UsageState>): number {
  let cost = 0
  for (const usage of Object.values(state.models)) cost += finite(usage.cost?.total)
  for (const usage of Object.values(state.tools)) cost += finite(usage.cost?.total)
  return cost
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

interface EntryScan {
  /** 最新一条带消息时间戳的条目的时间 */
  lastTimestamp: number | undefined
  /** 最新一条带用量的 assistant 条目的缓存三项 */
  last: AgentMonitorCacheUsage['last']
  /** PIN-04 */
  contextTokens: number
}

/** durable 的 `calculateContextTokens`（pi-ai `utils/estimate`） */
function contextTokensOf(usage: Partial<Usage> | undefined): number {
  if (usage === undefined) return 0
  return (
    finite(usage.totalTokens) ||
    finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite)
  )
}

/**
 * 由新到旧扫这个对话的条目（fork 感知），直到三样都有了：最新的消息时间、最新一条带用量的 assistant
 * （`last`）、活上下文里最新一条可计量的 assistant（上下文占用；碰到头标记就不再找它）。账本里一点用量都
 * 没有时（`withUsage = false`）后两样不可能有，只找时间 —— 一个从不报用量的 provider 不该让每次轮询扫完
 * 全部历史。
 */
async function scanEntries(
  harness: Harness,
  conversationId: ConversationId,
  withUsage: boolean
): Promise<EntryScan> {
  const scan: EntryScan = { lastTimestamp: undefined, last: undefined, contextTokens: 0 }
  const conversation = await harness.conversation(conversationId, BG)
  if (conversation === undefined) return scan
  let lastDone = !withUsage
  let contextDone = !withUsage
  let cursor: Cursor | undefined
  do {
    const page = await conversation.entries({}, ENTRY_PAGE, cursor, BG)
    for (const entry of page.items) {
      const message = entry.model?.[0]
      if (scan.lastTimestamp === undefined) {
        const ts = tsOf(message)
        if (ts > 0) scan.lastTimestamp = ts
      }
      const assistant = assistantOf(entry)
      if (assistant !== undefined) {
        const usage = assistant.usage as Partial<Usage> | undefined
        if (!lastDone && usage !== undefined) {
          const figures = {
            input: finite(usage.input),
            cacheRead: finite(usage.cacheRead),
            cacheWrite: finite(usage.cacheWrite)
          }
          if (figures.input + figures.cacheRead + figures.cacheWrite + finite(usage.output) > 0) {
            scan.last = figures
            lastDone = true
          }
        }
        if (!contextDone && !EXCLUDED_STOP_REASONS.has(assistant.stopReason)) {
          const tokens = contextTokensOf(usage)
          if (tokens > 0) {
            scan.contextTokens = tokens
            contextDone = true
          }
        }
      }
      // 头标记之前的条目不在活上下文里（`estimateContext` 只认标记之后追加的）
      if (entry.head !== undefined) contextDone = true
      if (scan.lastTimestamp !== undefined && lastDone && contextDone) return scan
    }
    cursor = page.next
  } while (cursor !== undefined)
  return scan
}

function assistantOf(entry: EntryRecord): AssistantMessage | undefined {
  if (entry.kind !== AssistantEntry.kind) return undefined
  const message = entry.model?.[0]
  return message?.role === 'assistant' ? (message as AssistantMessage) : undefined
}
