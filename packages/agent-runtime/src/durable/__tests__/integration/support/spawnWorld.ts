/**
 * P2-11 的「派生世界」（设计 §1.2–§1.8）：在 P1-12 的世界 W 之上接上整条派生链 —— 真
 * `createDispatchAgentTool` → 真路由（`createSubAgentManager`，每个进程一个）→ 真协调器 → 真 ToolHost（真文件
 * 套件、真 ask、真 `McpManager` 上的 SDK 服务器）→ 真安全 PEP；hook 一侧是真 `createHookRunner`，hook 与
 * agent 都是**内置** md（auto-title / auto-review、titler / permission-reviewer）。
 *
 *  - 模型：faux-1（40000，reasoning）/ faux-2（8000）/ tiny（3000 / 输出 1000）；provider 行 faux 上另有一条
 *    停用的模型行 `gone`（`fallback` 档案点它）。档案模型经 chat-protocol 的 `resolveModelRef` 对着已启用的
 *    模型行解析（桌面口径）。
 *  - 根档案 `int`：工具 `[...INT_TOOLS, 'agent']`，勾选 `[mcp:docs, mcp:ctx]`，人设带 `[lane:root]`。
 *    MCP：docs = [lookup, slow]（第三方，不可信），ctx = [whoami]（可信的 inproc 内置服务器，回显 `_meta`）。
 *  - 档案表从 **md 原文**解析（`parseAgentDefinitionFile`），正文带车道标记 `[lane:<x>]`；内置 titler /
 *    permission-reviewer 读内联的同一批 md（`createInlineMdReader`）。
 *  - 额外的内置工具（只按名单提供，PIN-05）：`hold`（按 callId 的闸门，观察 signal）、`probe`（记调用方身份，
 *    回显 `text`）、`session`（titler 的桩，PIN-04）。
 *  - 车道（PIN-01）：titler / reviewer 按 hook 围栏，`g`（嵌套里的孙子：nester 且第一条用户消息 `dig deeper`），
 *    其余按系统提示词里的车道标记。每个进程的脚本都重新登记。
 *  - 审查桥（PIN-02）：安全模块的审查接缝 → `runner.decide('permission.request', …, {signal, ownerTaskId})`，
 *    `review.enabled` 开关（缺省关）。
 */
import type { Message } from '@earendil-works/pi-ai'
import {
  defineTool,
  type ConversationId,
  type TaskId,
  type TaskRecord,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import type { JsonValue } from '@earendil-works/chord'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { Type } from 'typebox'
import { parseAgentDefinitionFile } from '../../../../agentProfile/definitionFile'
import { buildBuiltinHooks } from '../../../../hook/builtinHooks'
import { createInlineHookMdReader } from '../../../../hook/builtinHooks/inlineSources'
import { parseHookDefinitionFile } from '../../../../hook/hookFile'
import {
  createHookRunner,
  type HookRegistryEntry,
  type HookRunEvent,
  type HookRunner
} from '../../../../hook/hookRunner'
import { resolveHookRunModel } from '../../../../hook/runModel'
import { builtinRow, fakePort, modelRow } from '../../../../models/__tests__/fakePort'
import { buildBuiltinProfile } from '../../../../subagent/builtinAgents'
import { createInlineMdReader } from '../../../../subagent/builtinAgents/inlineSources'
import { createDispatchAgentTool, toInProcessAgentType } from '../../../../subagent/dispatchTool'
import type { SubAgentManager } from '../../../../subagent/manager'
import type { AgentProfile } from '../../../../subagent/types'
import type { PermissionReviewAnswer, PermissionRequestEvent } from '../../../../security/types'
import {
  spawnedAgentRecordOf,
  type AgentIdentity,
  type SpawnedAgentRecord
} from '../../../agentRecord'
import { SPAWN_ANCHOR_TASK } from '../../../anchor'
import { backgroundContext as BG } from '../../../context'
import { AgentStateDoc } from '../../../docs'
import type { DurableSession } from '../../../durableSession'
import { fauxCatalog } from '../../support/agentConfig'
import { fauxKit } from '../../support/faux'
import { routerKit, type RouterKit, ABORTED_NOTE } from '../../support/router'
import { allEntries, messageText } from '../../support/transcript'
import { aborted, deferred, waitFor, type Deferred } from '../../support/wait'
import type { LaneMatch, ScriptedModel } from './scriptedModel'
import { INT_TOOLS, makeWorld, type World, type WorldOptions } from './world'

export { ABORTED_NOTE }

// ─────────────────────────── 档案（md 原文） ───────────────────────────

export const EXPLORE_MD = `---
shuvix: agent v1
name: explore
description: Looks things up
shuvix-displayName: Explorer
shuvix-tools: read, write, ask, hold, mcp:docs, mcp:ctx
---

You explore. [lane:explore]
`

export const NESTER_MD = `---
shuvix: agent v1
name: nester
description: Delegates deeper
shuvix-displayName: Nester
shuvix-tools: read, agent, mcp:ctx
---

You delegate. [lane:nester]
`

export const SMALLCTX_MD = `---
shuvix: agent v1
name: smallctx
description: Small window
shuvix-displayName: Small
shuvix-tools: probe
shuvix-model: faux/tiny
---

You probe a lot. [lane:smallctx]
`

export const TUNED_MD = `---
shuvix: agent v1
name: tuned
description: Own model and thinking
shuvix-displayName: Tuned
shuvix-tools: probe
shuvix-model: faux/faux-2
shuvix-thinking: high
---

You are tuned. [lane:tuned]
`

export const FALLBACK_MD = `---
shuvix: agent v1
name: fallback
description: Points at a disabled model
shuvix-displayName: Fallback
shuvix-tools: probe
shuvix-model: faux/gone
shuvix-thinking: off
---

You fall back. [lane:fallback]
`

const PROFILE_MDS: Record<string, string> = {
  explore: EXPLORE_MD,
  nester: NESTER_MD,
  smallctx: SMALLCTX_MD,
  tuned: TUNED_MD,
  fallback: FALLBACK_MD
}

/** md 原文 → 注册表里的档案（parseAgentDefinitionFile 的口径） */
export function profileFromMd(md: string, name: string): AgentProfile {
  const parsed = parseAgentDefinitionFile(md, name, (message) => {
    throw new Error(message)
  })
  if (parsed === null) throw new Error(`profile md ${name} did not parse`)
  return { ...parsed, source: 'user', basePath: '' }
}

function builtinProfile(name: string): AgentProfile {
  const profile = buildBuiltinProfile({ name }, { readMd: createInlineMdReader() })
  if (profile === null) throw new Error(`builtin profile ${name} did not build`)
  return profile
}

/** permission-reviewer 的用户覆盖（同一正文，另加 `shuvix-tools`；J7-05） */
export function reviewerOverrideMd(tools: string): string {
  const builtin = builtinProfile('permission-reviewer')
  return `---
shuvix: agent v1
name: permission-reviewer
description: ${builtin.description}
shuvix-displayName: ${builtin.displayName}
shuvix-thinking: low
shuvix-tools: ${tools}
---

${builtin.systemPrompt}
`
}

// ─────────────────────────── 车道 ───────────────────────────

export const TITLE_FENCE = '<hook_event trigger="session.prompt-accepted">'
export const REVIEW_FENCE = '<hook_event trigger="permission.request">'

function userTexts(messages: readonly Message[]): string[] {
  return messages.filter((message) => message.role === 'user').map((m) => messageText(m))
}

const anyUser =
  (needle: string): LaneMatch =>
  ({ messages }) =>
    userTexts(messages).some((text) => text.includes(needle))

const tagged =
  (lane: string): LaneMatch =>
  ({ systemPrompt }) =>
    systemPrompt.includes(`[lane:${lane}]`)

/** 每个进程的脚本都登记同一组车道（次序即优先级） */
export function registerLanes(model: ScriptedModel): void {
  model.lane('titler', anyUser(TITLE_FENCE))
  model.lane('reviewer', anyUser(REVIEW_FENCE))
  model.lane(
    'g',
    (request) =>
      tagged('nester')(request) && (userTexts(request.messages)[0] ?? '').startsWith('dig deeper')
  )
  for (const lane of ['nester', 'explore', 'smallctx', 'tuned', 'fallback', 'root']) {
    model.lane(lane, tagged(lane))
  }
}

// ─────────────────────────── 世界 ───────────────────────────

export interface SessionCall {
  action: string
  title: string | undefined
  conversationId: number
  identity: AgentIdentity | undefined
}

export interface ProbeCall {
  sessionId: string
  conversationId: number
  identity: AgentIdentity | undefined
}

export interface SpawnWorldOptions {
  /** settings 覆盖（整份替换；缺省世界的 OFF） */
  settings?: WorldOptions['settings']
  /** 额外 / 替换的档案 md（名 → 原文） */
  profiles?: Record<string, string>
  /** 用户 hook 覆盖（md 原文，同名覆盖内置） */
  hooks?: string[]
  /** 别的会话的配置（J1-03 的 s2 沿用缺省） */
  sessions?: WorldOptions['sessions']
  maxAgentDepth?: number
  host?: WorldOptions['host']
}

export interface SpawnWorld {
  readonly world: World
  /** 当前进程的路由 */
  readonly router: RouterKit
  /** 每个进程的路由（最旧在前） */
  readonly routers: readonly RouterKit[]
  /** 当前进程的 hook runner */
  readonly runner: HookRunner
  /** 档案表（名 → 档案；可变） */
  readonly profiles: Map<string, AgentProfile>
  /** hook runner 的 onRun 事件（跨进程累计） */
  readonly runs: HookRunEvent[]
  readonly hookLogs: string[]
  readonly sessionCalls: SessionCall[]
  readonly probeCalls: ProbeCall[]
  /** 审查桥的开关（缺省关） */
  readonly review: { enabled: boolean }
  /** `hold` 的闸门（按 callId） */
  gate(callId: string): Deferred
  /** `hold` 收到的调用（callId，按到达次序） */
  readonly holds: string[]
  /** 当前进程的脚本 */
  readonly model: ScriptedModel
  /** 打开会话（并建根 agent） */
  open(sessionId?: string): Promise<DurableSession>
  /** 换一个进程（新路由、新 runner、新脚本 + 车道）；之后要重新 open */
  restart(): Promise<void>
  /** 起标题：`fire('session.prompt-accepted', …)` */
  fireTitle(text: string, sessionId?: string): void
  /** hook 的 end 事件 */
  ends(hook?: string): Extract<HookRunEvent, { type: 'end' }>[]
}

const holdGates = new Map<string, Deferred>()

/** 关掉某个世界剩下的 hold 闸门（afterEach 卫生） */
export function releaseHolds(): void {
  for (const gate of holdGates.values()) gate.resolve()
  holdGates.clear()
}

export async function spawnWorld(options: SpawnWorldOptions = {}): Promise<SpawnWorld> {
  const profiles = new Map<string, AgentProfile>()
  for (const [name, md] of Object.entries({ ...PROFILE_MDS, ...options.profiles })) {
    profiles.set(name, profileFromMd(md, name))
  }
  for (const name of ['titler', 'permission-reviewer']) {
    if (!profiles.has(name)) profiles.set(name, builtinProfile(name))
  }
  const registry = {
    list: () => [...profiles.values()],
    get: (name: string) => profiles.get(name)
  }
  const port = fakePort(
    [builtinRow('faux')],
    [
      modelRow('faux', 'faux-1'),
      modelRow('faux', 'faux-2'),
      modelRow('faux', 'tiny'),
      modelRow('faux', 'gone', {}, false)
    ]
  )
  const enabledModels = (): { providerId: string; modelId: string }[] => {
    const enabled = new Set(port.rows.filter((row) => row.isEnabled).map((row) => row.id))
    return port.modelRows.filter((row) => row.isEnabled && enabled.has(row.providerId))
  }
  const runs: HookRunEvent[] = []
  const hookLogs: string[] = []
  const sessionCalls: SessionCall[] = []
  const probeCalls: ProbeCall[] = []
  const holds: string[] = []
  const review = { enabled: false }
  const routers: RouterKit[] = []
  const current: { router?: RouterKit; runner?: HookRunner } = {}

  const proxy: SubAgentManager = {
    runTask: (params) => current.router!.router.runTask(params),
    continueTask: (params) => current.router!.router.continueTask(params),
    interrupt: (agentId) => current.router!.router.interrupt(agentId),
    destroy: (agentId) => current.router!.router.destroy(agentId),
    has: (agentId) => current.router!.router.has(agentId),
    locate: (agentId) => current.router!.router.locate(agentId),
    getRuntimeInfo: (agentId) => current.router!.router.getRuntimeInfo(agentId)
  }

  // eslint-disable-next-line prefer-const -- 世界建好之后才赋值（工具闭包晚绑定）
  let world: World
  const sessionOf = (sessionId: string): DurableSession | undefined => world.t.host.get(sessionId)

  const gate = (callId: string): Deferred => {
    let found = holdGates.get(callId)
    if (found === undefined) {
      found = deferred()
      holdGates.set(callId, found)
    }
    return found
  }

  const extraBuiltins = (sessionId: string): ToolRegistration[] => [
    defineTool({
      name: 'hold',
      description: 'hold: waits until released',
      parameters: Type.Object({}),
      replay: 'unsafe',
      execute: async (_args, api, context) => {
        holds.push(api.callId)
        await Promise.race([gate(api.callId).promise, aborted(context.abortSignal!)])
        return { content: [{ type: 'text', text: 'held done' }] }
      }
    }),
    defineTool({
      name: 'probe',
      description: 'probe: records the calling agent and echoes text',
      parameters: Type.Object({ text: Type.Optional(Type.String()) }),
      replay: 'safe',
      execute: async (args, api) => {
        probeCalls.push({
          sessionId,
          conversationId: api.conversationId,
          identity: sessionOf(sessionId)?.agentIdentity(api.conversationId)
        })
        return { content: [{ type: 'text', text: args.text ?? 'probe done' }] }
      }
    }),
    defineTool({
      name: 'session',
      description: 'session: manage this session (stub)',
      parameters: Type.Object({
        action: Type.String(),
        title: Type.Optional(Type.String())
      }),
      replay: 'unsafe',
      execute: async (args, api) => {
        sessionCalls.push({
          action: args.action,
          title: args.title,
          conversationId: api.conversationId,
          identity: sessionOf(sessionId)?.agentIdentity(api.conversationId)
        })
        return { content: [{ type: 'text', text: 'title set' }] }
      }
    })
  ]

  const reviewSeam = async (
    event: PermissionRequestEvent,
    signal?: AbortSignal
  ): Promise<PermissionReviewAnswer | null> => {
    if (!review.enabled) return null
    const sessionId = event.request.subject.sessionId
    const identity =
      event.conversationId === undefined
        ? undefined
        : sessionOf(sessionId)?.agentIdentity(event.conversationId)
    const decision = await current.runner!.decide(
      'permission.request',
      {
        sessionId,
        agent: { profile: identity?.profileName ?? 'int', kind: identity?.kind ?? 'root' },
        operation: {
          tool: event.request.tool?.name ?? '',
          action: event.request.action,
          objectType: event.request.object.type,
          target: event.command,
          facts: {}
        },
        policy: { names: [], prompt: '' },
        userMessages: [],
        delegatedTasks: [],
        recentOperations: []
      },
      {
        ...(signal === undefined ? {} : { signal }),
        ...(event.taskId === undefined ? {} : { ownerTaskId: event.taskId })
      }
    )
    return decision === null ? null : { verdict: decision.result, source: decision.hook }
  }

  const userHooks = (options.hooks ?? []).map((md) => {
    const parsed = parseHookDefinitionFile(md, 'user-hook', (message) => {
      throw new Error(message)
    })
    if (parsed === null) throw new Error('user hook md did not parse')
    return parsed
  })

  world = await makeWorld({
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    tools: [...INT_TOOLS, 'agent'],
    overlay: ['mcp:docs', 'mcp:ctx'],
    persona: 'You are {{shuvix:marker}} [lane:root]',
    mcp: { docs: ['lookup', 'slow'], ctx: ['whoami'] },
    trustedMcp: ['ctx'],
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    makeKit: () =>
      fauxKit({
        models: [
          { id: 'faux-1', contextWindow: 40000 },
          { id: 'faux-2', contextWindow: 8000 },
          { id: 'tiny', contextWindow: 3000, maxTokens: 1000 }
        ]
      }),
    host: {
      port,
      resolveProfileModel: (spec) => {
        const hit = resolveModelRef(spec, enabledModels())
        return hit === undefined ? null : { provider: hit.providerId, modelId: hit.modelId }
      },
      ...(options.maxAgentDepth === undefined ? {} : { maxAgentDepth: options.maxAgentDepth }),
      ...options.host
    },
    toolHost: () => ({
      extraBuiltins,
      dispatch: (sessionId) =>
        createDispatchAgentTool({ registry, manager: proxy, sessionId, abortError: 'Aborted' }),
      mcpOptions: (sessionId) => ({
        callerIdOf: (conversationId) =>
          sessionOf(sessionId)?.agentIdentity(conversationId)?.callerId ?? sessionId
      }),
      review: reviewSeam
    })
  })

  const newProcess = (): void => {
    const router = routerKit(world.t.host)
    routers.push(router)
    current.router = router
    const catalog = fauxCatalog(world.t.kit, world.t.port)
    current.runner = createHookRunner({
      manager: proxy,
      listHooks: (): HookRegistryEntry[] => {
        const builtins = buildBuiltinHooks({ readMd: createInlineHookMdReader() })
        const names = new Set(userHooks.map((hook) => hook.name))
        return [
          ...builtins
            .filter((hook) => !names.has(hook.name))
            .map((file) => ({ file, source: 'builtin' as const })),
          ...userHooks.map((file) => ({ file, source: 'user' as const }))
        ]
      },
      resolveAgentProfile: (name) => {
        const profile = profiles.get(name)
        return profile === undefined ? null : toInProcessAgentType(profile)
      },
      resolveRunModel: ({ sessionId }) =>
        resolveHookRunModel({
          session: sessionOf(sessionId),
          selection: () => {
            const config = world.configs.get(sessionId) ?? world.config
            return {
              model: config.model ?? null,
              ...(config.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: config.thinkingLevel as ThinkingLevel })
            }
          },
          catalog
        }),
      isInterrupted: ({ sessionId }) => sessionOf(sessionId)?.isInterrupted() === true,
      env: { host: 'desktop', platform: 'darwin' },
      timeoutMs: 10000,
      decideTimeoutMs: 5000,
      onRun: (event) => runs.push(event),
      logger: {
        info: (message) => hookLogs.push(message),
        warn: (message) => hookLogs.push(message),
        error: (message) => hookLogs.push(message)
      }
    })
    registerLanes(world.model)
  }
  newProcess()

  const sw: SpawnWorld = {
    world,
    get router() {
      return current.router!
    },
    routers,
    get runner() {
      return current.runner!
    },
    profiles,
    runs,
    hookLogs,
    sessionCalls,
    probeCalls,
    review,
    gate,
    holds,
    get model() {
      return world.model
    },
    open: async (sessionId = 's1') => {
      const session = await world.open(sessionId)
      if (session.lock === undefined) await session.createAgent()
      return session
    },
    restart: async () => {
      await world.restart()
      newProcess()
    },
    fireTitle: (text, sessionId = 's1') =>
      current.runner!.fire('session.prompt-accepted', {
        sessionId,
        profileName: 'int',
        title: 'New Chat',
        isDefaultTitle: true,
        promptText: text
      }),
    ends: (hook) =>
      runs.filter(
        (event): event is Extract<HookRunEvent, { type: 'end' }> =>
          event.type === 'end' && (hook === undefined || event.run.hook === hook)
      )
  }
  return sw
}

// ─────────────────────────── 查看 ───────────────────────────

type AnyTask = TaskRecord<JsonValue, JsonValue, JsonValue>

/** 某任务拥有的对话（`scanConversations({ownerTaskId})`） */
export async function ownedBy(session: DurableSession, taskId: number): Promise<ConversationId[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanConversations({ ownerTaskId: taskId as TaskId }, 256)
    return page.items.map((record) => record.id)
  }, BG)
}

/** 某对话里某种任务（含终态） */
export async function tasksIn(
  session: DurableSession,
  conversationId: number,
  kind?: string
): Promise<AnyTask[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanTasks(
      { conversationId: conversationId as ConversationId, ...(kind === undefined ? {} : { kind }) },
      256
    )
    return [...page.items]
  }, BG)
}

/** 某对话里某次工具调用（按 callId）的 `pi.tool` 任务 */
export async function toolTaskOf(
  session: DurableSession,
  conversationId: number,
  callId: string
): Promise<AnyTask> {
  const found = (await tasksIn(session, conversationId, 'pi.tool')).find(
    (task) => (task.input as { callId?: string }).callId === callId
  )
  if (found === undefined) throw new Error(`no pi.tool task for ${callId} in ${conversationId}`)
  return found
}

/** 等某次工具调用的任务建好它的子对话（缺省根对话） */
export async function childOfCall(
  session: DurableSession,
  callId: string,
  conversationId = 1,
  timeoutMs = 3000
): Promise<ConversationId> {
  let found: ConversationId | undefined
  await waitFor(
    async () => {
      const task = (await tasksIn(session, conversationId, 'pi.tool')).find(
        (candidate) => (candidate.input as { callId?: string }).callId === callId
      )
      if (task === undefined) return false
      found = (await ownedBy(session, task.id))[0]
      return found !== undefined
    },
    timeoutMs,
    `child of ${callId}`
  )
  return found!
}

/** 此刻活着的任务（全部对话） */
export async function liveTasks(session: DurableSession): Promise<AnyTask[]> {
  return (await session.harness.inspect(BG)).tasks.map((task) => task.record)
}

/** 锚任务（活着的与终结的） */
export async function anchorTasks(session: DurableSession): Promise<AnyTask[]> {
  return session.harness.commit(async (tx) => {
    const page = await tx.scanTasks({ kind: SPAWN_ANCHOR_TASK }, 256)
    return [...page.items]
  }, BG)
}

/** 一个任务此刻的记录 */
export async function taskById(session: DurableSession, id: number): Promise<AnyTask | undefined> {
  return session.harness.commit((tx) => tx.task(id as TaskId), BG)
}

/** 对话的拥有者 */
export async function ownerOf(
  session: DurableSession,
  conversationId: number
): Promise<{ conversationId: number; taskId: number } | undefined> {
  return session.harness.commit(async (tx) => {
    const record = await tx.conversation(conversationId as ConversationId)
    const owner = (record as { owner?: { conversationId: number; taskId: number } } | undefined)
      ?.owner
    return owner === undefined
      ? undefined
      : { conversationId: owner.conversationId, taskId: owner.taskId }
  }, BG)
}

/** 某对话的派生 agent 记录 */
export async function recordOf(
  session: DurableSession,
  conversationId: number
): Promise<SpawnedAgentRecord | undefined> {
  return spawnedAgentRecordOf(session.harness, conversationId as ConversationId, BG)
}

/** 某对话的 AgentStateDoc 原值 */
export async function agentStateOf(
  session: DurableSession,
  conversationId: number
): Promise<unknown> {
  return session.harness.snapshot(AgentStateDoc, conversationId as ConversationId, BG)
}

/** 某对话的转写（`<kind>:<text>`，跳过 pi.system） */
export async function transcriptOf(
  session: DurableSession,
  conversationId: number
): Promise<string[]> {
  const conversation = await session.harness.conversation(conversationId as ConversationId, BG)
  if (conversation === undefined) throw new Error(`no conversation ${conversationId}`)
  return (await allEntries(conversation))
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => `${entry.kind}:${messageText(entry.model?.[0])}`)
}

/** 一个对话里某工具调用的结果文本 */
export async function resultTextOf(
  session: DurableSession,
  conversationId: number,
  callId: string
): Promise<string> {
  const conversation = await session.harness.conversation(conversationId as ConversationId, BG)
  const entry = (await allEntries(conversation!)).find((candidate) => {
    const message = candidate.model?.[0]
    return message?.role === 'toolResult' && message.toolCallId === callId
  })
  if (entry === undefined) throw new Error(`no tool result for ${callId} in ${conversationId}`)
  return messageText(entry.model?.[0])
}

/** 一个对话里某工具调用的结果消息 */
export async function resultOf(
  session: DurableSession,
  conversationId: number,
  callId: string
): Promise<{ text: string; isError: boolean; details: unknown }> {
  const conversation = await session.harness.conversation(conversationId as ConversationId, BG)
  const entry = (await allEntries(conversation!)).find((candidate) => {
    const message = candidate.model?.[0]
    return message?.role === 'toolResult' && message.toolCallId === callId
  })
  const message = entry?.model?.[0]
  if (message?.role !== 'toolResult') throw new Error(`no tool result for ${callId}`)
  return { text: messageText(message), isError: message.isError, details: message.details }
}

export const V_ALLOW = { decision: 'allow', risk: 'low', summary: 'Writes a file', reason: 'ok' }

export function V_DENY(reason: string): Record<string, string> {
  return { decision: 'deny', risk: 'high', summary: 'Writes a file', reason }
}
