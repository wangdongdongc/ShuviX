/**
 * 集成用例的「世界」（设计 §1）：一次调用搭好会话宿主 + 锁的配置 + 真工具 + 真 MCP + 脚本化模型；
 * `restart()` 模拟换一个进程。
 *
 * 世界级（熬过重启）：MemFs（「磁盘」）、MCP 调用日志、落盘记录、审查事件、时钟 / 日期、会话配置与
 * 人设变量表（「DB 里的东西」）、SQLite 目录。进程级（重启换新）：会话宿主、faux 套件与脚本、
 * McpManager（连接计数从 0 数）、真 ToolHost、提交记录器、广播 / 运行状态 / 锁镜像的记录。
 *
 * 缺省世界 W（设计 §1）：会话 s1；faux 模型 faux-1（窗口 40000）与 tiny（3000 / 输出 1000）；档案 `int`
 * 的工具 [read, write, edit, ask, dump, boom]，会话勾选 [mcp:docs]，人设 `You are {{shuvix:marker}}`；
 * 选择 faux/faux-1、思考 low；MCP docs = [lookup, slow]（另有一台 notes = [search]，只在被选中时连）；
 * `/ws/notes.txt` = `alpha\nbeta`。提供给模型的工具 E（K6 次序）见 `E_TOOLS`。
 * settings 覆盖是**整份替换**（P1-07 的缺省 —— 重试关、压缩关），每个场景按需整份给。日期通知开着
 * （`today` = 世界时钟的日期，缺省 2026-10-04；不拨日期就不会发）。合并窗口 20 ms。
 */
import type { FauxProviderHandle, FauxResponseStep, Models } from '@earendil-works/pi-ai'
import type { Conversation } from '@earendil-works/pi-durable'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { afterEach, expect } from 'vitest'
import { clearSessionDecisions } from '../../../../security/decisionLog'
import { clearReviewState } from '../../../../security/reviewState'
import type { PermissionRequestEvent } from '../../../../security/types'
import type { DurableSession } from '../../../durableSession'
import type { AgentConfig, ModelCatalog } from '../../../seams'
import type { ShuviXSettingsOverrides } from '../../../settings'
import { markerVars, testProfile, type MarkerVars } from '../../support/agentConfig'
import { fauxKit } from '../../support/faux'
import { makeHost, type TestHost, type TestHostOptions } from '../../support/host'
import { waitFor, withTimeout } from '../../support/wait'
import { worldClock, type WorldClock } from './clock'
import {
  mcpProcess,
  mcpWorldLog,
  type McpProcess,
  type McpWorldLog,
  type SdkToolName
} from './mcpSdk'
import { memFs, type MemFs } from './memFs'
import { realToolHost, type RealToolHost, type RealToolHostOptions } from './realTools'
import { recordCommits, type CommitRecorder } from './recorder'
import { scriptedModel, type ScriptedModel } from './scriptedModel'
import { spillLog, type SpillLog } from './spill'

/** 档案 `int` 的工具（MCP 由会话勾选给：重建时可以换成别的服务器） */
export const INT_TOOLS = ['read', 'write', 'edit', 'ask', 'dump', 'boom']

/** E：缺省世界里提供给模型的工具，按次序（K6） */
export const E_TOOLS = [
  'read',
  'write',
  'edit',
  'ask',
  'dump',
  'boom',
  'mcp__docs__lookup',
  'mcp__docs__slow'
]

export const NOTES_TXT = 'alpha\nbeta'

/** 缺省 settings 覆盖（整份替换）：重试关、压缩关 */
export const OFF: ShuviXSettingsOverrides = {
  retry: { enabled: false },
  compaction: { enabled: false }
}

export interface WorldOptions {
  /** settings 覆盖（整份替换；缺省 OFF） */
  settings?: ShuviXSettingsOverrides
  /** 缺省会话配置的改写（档案工具 / 勾选 / 模型 / 思考） */
  tools?: readonly string[]
  overlay?: readonly string[]
  /** 模型选择的 provider 行 id（缺省内置行 `faux`） */
  provider?: string
  modelId?: string
  thinkingLevel?: AgentConfig['thinkingLevel'] | null
  /** 某些会话用别的配置（如 I1-06 的 s2） */
  sessions?: Record<string, SessionSpec>
  /** MCP 服务器 → 工具（缺省 docs = [lookup, slow]、notes = [search]） */
  mcp?: Record<string, SdkToolName[]>
  /** 可信的内置能力服务器（inproc + isBuiltin；P2-11 的 `ctx`） */
  trustedMcp?: readonly string[]
  /** 根档案的人设（缺省 `You are {{shuvix:marker}}`） */
  persona?: string
  /** 真 ToolHost 的 P2-11 选项（派发工具、额外内置工具、MCP 调用方、审查接缝）；每个进程现取 */
  toolHost?: (
    world: World
  ) => Pick<RealToolHostOptions, 'extraBuiltins' | 'dispatch' | 'mcpOptions' | 'review'>
  /** 自动续跑开关的初值（现读 `world.autoResume.value`） */
  autoResume?: unknown
  noticeCoalesceMs?: number
  /** 透传给测试宿主的其余选项（port …） */
  host?: Partial<TestHostOptions>
  /** 每个进程造自己的 faux 时用（缺省 faux-1 + tiny） */
  makeKit?: TestHostOptions['makeKit']
  /**
   * 每个进程整份替换生成用的 Models 与模型目录（场景 4：真 `createModelRegistry` + 自定义行 id 下的 faux，
   * PIN-3）；脚本装在它交回的 faux 上。缺省 = 测试宿主的 faux 套件。
   */
  makeModels?: () => ProcessModels
}

export type SessionSpec = Partial<Pick<WorldOptions, 'tools' | 'overlay' | 'provider' | 'modelId'>>

/** 一个进程的模型层（`makeModels` 的交回值） */
export interface ProcessModels {
  readonly models: Models
  readonly modelCatalog: ModelCatalog
  readonly faux: FauxProviderHandle
}

export interface World {
  /** 当前进程的测试宿主 */
  t: TestHost
  /** 当前进程的脚本化模型 */
  model: ScriptedModel
  /** 这个世界里每个进程的脚本（最旧在前） */
  readonly scripts: readonly ScriptedModel[]
  /** 当前进程的 MCP */
  mcp: McpProcess
  /** 当前进程的真 ToolHost（宿主每个进程造一个） */
  readonly toolHost: RealToolHost
  readonly fs: MemFs
  readonly mcpLog: McpWorldLog
  readonly spill: SpillLog
  readonly permissions: PermissionRequestEvent[]
  readonly clock: WorldClock
  readonly vars: MarkerVars
  /** 缺省会话配置（可变：下一次创建 agent 读到新值） */
  readonly config: AgentConfig
  /** 按会话的配置（覆盖缺省） */
  readonly configs: Map<string, AgentConfig>
  readonly autoResume: { value: unknown }
  /** 这个世界里打开过的会话 id（清安全模块的进程表用） */
  readonly sessionIds: Set<string>
  /** 当前进程里某会话的提交记录器（open 时挂上） */
  recorder(sessionId?: string): CommitRecorder
  /** 打开会话（挂上记录器） */
  open(sessionId?: string): Promise<DurableSession>
  /** 当前进程里已打开的会话 */
  session(sessionId?: string): DurableSession
  conversation(sessionId?: string): Promise<Conversation>
  /** 换一个进程（closeAll → 新宿主 / 新 faux / 新 McpManager / 新 ToolHost）；之后要重新 open */
  restart(options?: { mcp?: Record<string, SdkToolName[]> }): Promise<void>
  /** 给当前进程的脚本追加聊天步骤 */
  chat(...steps: FauxResponseStep[]): void
}

const worlds = new Set<World>()

/** 在测试文件顶层调用（在 registerHostCleanup 之外再加）：卫生断言 + 关掉 MCP + 清安全模块的进程表 */
export function registerWorldCleanup(): void {
  afterEach(async () => {
    const list = [...worlds]
    worlds.clear()
    for (const world of list) {
      await withTimeout(world.t.host.closeAll(), 15000, 'closeAll in world cleanup').catch(
        (error: unknown) => console.error(error)
      )
      await world.mcp.close().catch(() => undefined)
      for (const sessionId of world.sessionIds) {
        clearSessionDecisions(sessionId)
        clearReviewState(sessionId)
      }
    }
    for (const world of list) {
      for (const script of world.scripts) {
        expect(
          script.exhausted,
          `the chat script ran out (${script.exhaustedBy.join(', ')})`
        ).toBe(false)
      }
      expect(world.mcpLog.errors, 'MCP handler errors').toEqual([])
    }
  })
}

const DEFAULT_MCP: Record<string, SdkToolName[]> = { docs: ['lookup', 'slow'], notes: ['search'] }

function defaultKit(): ReturnType<typeof fauxKit> {
  return fauxKit({
    models: [
      { id: 'faux-1', contextWindow: 40000 },
      { id: 'tiny', contextWindow: 3000, maxTokens: 1000 }
    ]
  })
}

export async function makeWorld(options: WorldOptions = {}): Promise<World> {
  const clock = worldClock()
  const fs = memFs({ '/ws/notes.txt': NOTES_TXT })
  const mcpLog = mcpWorldLog()
  const spill = spillLog()
  const permissions: PermissionRequestEvent[] = []
  const vars = markerVars('M1')
  const autoResume = { value: options.autoResume }
  const sessionIds = new Set<string>()
  const mcpServers = options.mcp ?? DEFAULT_MCP

  const configFor = (spec: SessionSpec): AgentConfig => {
    const thinking = options.thinkingLevel === undefined ? 'low' : options.thinkingLevel
    return {
      profile: testProfile({
        name: 'int',
        displayName: 'Int',
        tools: [...(spec.tools ?? options.tools ?? INT_TOOLS)],
        systemPrompt: options.persona ?? 'You are {{shuvix:marker}}'
      }),
      toolOverlay: [...(spec.overlay ?? options.overlay ?? ['mcp:docs'])],
      model: {
        provider: spec.provider ?? options.provider ?? 'faux',
        modelId: spec.modelId ?? options.modelId ?? 'faux-1'
      },
      ...(thinking === null ? {} : { thinkingLevel: thinking })
    }
  }
  const config = configFor({})
  const configs = new Map<string, AgentConfig>()
  for (const [sessionId, spec] of Object.entries(options.sessions ?? {})) {
    configs.set(sessionId, configFor(spec))
  }

  const recorders = new Map<string, CommitRecorder>()
  let toolHost!: RealToolHost

  const world = {} as World
  const makeToolHost = (): RealToolHost => {
    toolHost = realToolHost({
      fs,
      mcp: world.mcp,
      spill,
      permissionLog: permissions,
      requestUserInput: (sessionId) => (request: InputRequest) =>
        world.t.host.get(sessionId)?.requestUserInput(request) ??
        Promise.resolve<InputResponse>({ kind: 'cancel', reason: 'closed' }),
      ...options.toolHost?.(world)
    })
    return toolHost
  }

  Object.assign(world, {
    fs,
    mcpLog,
    spill,
    permissions,
    clock,
    vars,
    config,
    configs,
    autoResume,
    sessionIds,
    mcp: mcpProcess(mcpServers, mcpLog, { trusted: options.trustedMcp ?? [] })
  })
  Object.defineProperty(world, 'toolHost', { get: () => toolHost })

  /** 这个世界用过的全部脚本（每个进程一份；卫生断言逐个看） */
  const scripts: ScriptedModel[] = []
  let processModels = options.makeModels?.()
  const modelOptions = (): Partial<TestHostOptions> =>
    processModels === undefined
      ? {}
      : { models: processModels.models, modelCatalog: processModels.modelCatalog }
  const attachScript = (): void => {
    world.model = scriptedModel(processModels?.faux ?? world.t.kit.faux, clock.now)
    scripts.push(world.model)
  }

  const t = await makeHost({
    makeKit: options.makeKit ?? defaultKit,
    makeToolHost,
    agentConfig: (sessionId) => configs.get(sessionId) ?? config,
    promptVars: vars.promptVars,
    settingsOverrides: options.settings ?? OFF,
    autoResume: () => autoResume.value,
    noticeCoalesceMs: options.noticeCoalesceMs ?? 20,
    now: clock.now,
    today: clock.today,
    ...options.host,
    ...modelOptions()
  })
  world.t = t
  attachScript()
  Object.defineProperty(world, 'scripts', { get: () => scripts })

  world.recorder = (sessionId = 's1') => {
    const recorder = recorders.get(sessionId)
    if (recorder === undefined)
      throw new Error(`session ${sessionId} was not opened in this process`)
    return recorder
  }
  world.open = async (sessionId = 's1') => {
    sessionIds.add(sessionId)
    const session = await world.t.open(sessionId)
    if (!recorders.has(sessionId)) recorders.set(sessionId, recordCommits(session.harness))
    return session
  }
  world.session = (sessionId = 's1') => {
    const session = world.t.host.get(sessionId)
    if (session === undefined) throw new Error(`session ${sessionId} is not open`)
    return session
  }
  world.conversation = (sessionId = 's1') => world.session(sessionId).currentConversation()
  world.chat = (...steps) => world.model.chat(...steps)
  world.restart = async (restartOptions = {}) => {
    const previous = world.mcp
    for (const recorder of recorders.values()) recorder.stop()
    recorders.clear()
    world.mcp = mcpProcess(restartOptions.mcp ?? mcpServers, mcpLog, {
      trusted: options.trustedMcp ?? []
    })
    processModels = options.makeModels?.()
    world.t = await world.t.restart(modelOptions())
    await previous.close().catch(() => undefined)
    attachScript()
  }
  worlds.add(world)
  return world
}

// ─────────────────────────── 询问 ───────────────────────────

/** 等一条 `input_request` 广播（按询问 id；当前进程） */
export async function nextInput(
  world: World,
  id: string,
  sessionId = 's1',
  timeoutMs = 3000
): Promise<InputRequest> {
  let found: InputRequest | undefined
  await waitFor(
    () => {
      for (const event of world.t.broadcasts) {
        if (
          event.type === 'input_request' &&
          event.sessionId === sessionId &&
          event.request.id === id
        ) {
          found = event.request
          return true
        }
      }
      return false
    },
    timeoutMs,
    `input_request ${id}`
  )
  return found!
}

/** 某询问 id 的 `input_request_resolved` 广播数（当前进程） */
export function resolvedCount(world: World, id: string, sessionId = 's1'): number {
  return world.t.broadcasts.filter(
    (event) =>
      event.type === 'input_request_resolved' &&
      event.sessionId === sessionId &&
      event.requestId === id
  ).length
}

function respond(world: World, id: string, response: InputResponse, sessionId: string): void {
  expect(world.session(sessionId).respondToInput(id, response), `respond to ${id}`).toBe(true)
}

export function allow(world: World, id: string, sessionId = 's1'): void {
  respond(world, id, { kind: 'ask', allowed: true }, sessionId)
}

export function deny(world: World, id: string, reason?: string, sessionId = 's1'): void {
  respond(
    world,
    id,
    { kind: 'ask', allowed: false, ...(reason === undefined ? {} : { reason }) },
    sessionId
  )
}

export function choose(world: World, id: string, labels: string[], sessionId = 's1'): void {
  respond(world, id, { kind: 'choice', selections: labels }, sessionId)
}
