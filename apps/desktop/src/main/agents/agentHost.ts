/**
 * 桌面工具 / 提示词宿主 —— durable 会话核心（SessionHost，P1-07 / P1-09）的三块桌面 seam（P1-11）：
 *
 *  - `createDesktopToolHost({ sessionOf })` —— `ToolHost`：
 *    - `buildBuiltinTools`：平台内置工具（装进 `shuvix.builtin`）。**一个会话级 ToolContext**，每个工具
 *      包一次桌面输出包装器（落盘按每次调用的 agent 工具表定，`spill: 'auto'`；L1 门的主体按调用现取）。
 *      同一会话的每个 agent 共用这一份，所以身份要紧的地方经 `agentOf` + withCallAgent 按调用认人。
 *      命令沙箱的钉子按 `sandboxed`（锁里的那一个）定。
 *    - `resolveAgentTools`：创建 agent 那一刻按名单解析按 agent 的工具（装进 `shuvix.agent.<对话>`）——
 *      派发工具、技能工具、MCP（这一刻惰性连接，连不上的广播一条错误、照常创建）、附加工具（`next`）。
 *      root 与派生 agent（P2-04）同一条路：资源（询问、项目、MCP 实例、广播、落盘）一律按根会话找；
 *      技能只看派生名单里点了名的；派发工具按 `offersDispatchTool`（派生 agent 看 canSpawn）。
 *    - `rebuildAgentTools`：重开会话时按锁记录 / 派生 agent 记录重建同一组 —— 不读会话配置；MCP 按声明
 *      快照建，缺省不连服务器，只有完整初始化（`connect`，option A：新进程里打开一条有可续工作的锁着的
 *      会话）才与创建同一条路当场连上；`next` 只来自运行时给的重建上下文（宿主从不自己造）。
 *    - `reconfigureAgentTools`：锁住的 root agent 换勾选时（重配）只解析变了的那几样 —— 新勾的 MCP
 *      （与创建同一条惰性连接的路；预判时不连）；技能工具不在其中（货架在创建时定下），沿用哪些、怎么排由运行时定。
 *  - `desktopPromptHost` —— `PromptHost`：系统提示词四个活段落（指令文件 / 项目提示词 / 知识库 /
 *    bot 人设）的数据源，每次请求准备时现调。
 *  - `desktopPromptVars` —— 人设冻结时的变量表（`{{shuvix:*}}` 占位符的取值）。
 *
 * 工具的**次序**不在这里拼：运行时的锁（`composeAgentTools`，K6）按「名单序内置 → agent → skill →
 * MCP 逐台逐个 → 其它」拼，这里只交出各段。
 *
 * 另留 `resolveProfileModelSpec`：档案 `shuvix-model` 的解析（切档案种子；派生 agent 经
 * `SessionHostDeps.resolveProfileModel` 接到协调器）。
 */
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable'
import {
  formatLanguageDisplay,
  LAZY_CONNECT_TIMEOUT_MS,
  localDate,
  offersDispatchTool,
  renderBotContext,
  renderKnowledgeGuide,
  renderVisualCraft,
  renderVisualGuide,
  type AgentToolSet,
  type AgentToolsRebuildContext,
  type AgentToolsReconfigureRequest,
  type AgentToolsRequest,
  type AnyTool,
  type DurableSession,
  type LockRecord,
  type McpRegistrationOptions,
  type McpToolDeclaration,
  type PromptHost,
  type PromptVars,
  type PromptVarsCtx,
  type ReconfiguredAgentTools,
  type ResolvedAgentTools,
  type SpawnedAgentRecord,
  type SubAgentModelConfig,
  type ToolHost
} from '@shuvix/agent-runtime'
import type { ChatEvent } from '@shuvix/chat-protocol/events'
import { resolveModelRef } from '@shuvix/chat-protocol/agentModelRef'
import { isChromeTabSessionSettings } from '@shuvix/chat-protocol/chromeTabSession'
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import { existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { homedir, type as osType, release as osRelease, platform } from 'os'
import { app } from 'electron'
import i18next from 'i18next'
import { getPlatformBuiltinToolEntries } from '../services/toolRegistry'
import {
  getPowerShellConfig,
  platformShellKind,
  powerShellEditionLabel
} from '../utils/toolUtils/shell'
import { recordRead } from '../utils/toolUtils/fileTime'
import { SkillTool } from '../services/skillTool'
import { skillService } from '../services/skillService'
import { mcpService } from '../services/mcpService'
import { botService } from '../services/botService'
import { providerDao } from '../dao/providerDao'
import { sessionRecords } from '../services/sessionRecords'
import { projectDao } from '../dao/projectDao'
import { resolveInstructionContent } from '../services/instruction'
import { chatFrontendRegistry } from '../frontend/core'
import { wrapDurableTool, type ToolExecutionHooks } from '../services/wrapToolOutput'
import { prepareArtifactHistory, recordArtifactChange } from '../services/artifacts/history'
import { pinCallingReply } from '../services/artifacts/pins'
import { sandboxGloballyActive } from '../services/sandbox'
import { requestUserInputFor } from '../services/userInputBroker'
import {
  getDesktopSecurityContext,
  resolveProjectConfig,
  type ToolContext
} from '../services/toolContext'
import { withCallAgent, type ToolAgentIdentity } from '../services/toolAgent'
import type { Project } from '../types'
import { createLogger } from '../logger'
import { createAgentTool } from './AgentTool'
import { enabledBaseChoices } from '../services/knowledge'

const log = createLogger('AgentHost')

/** 会话所属项目（变量表/注入解析与 SkillTool 的同源查询；无项目会话返回 undefined） */
function sessionProject(
  sessionId: string
): Pick<Project, 'name' | 'path' | 'systemPrompt' | 'settings'> | undefined {
  const session = sessionRecords.pick(sessionId, ['projectId'])
  return session?.projectId
    ? projectDao.pick(session.projectId, ['name', 'path', 'systemPrompt', 'settings'])
    : undefined
}

// ─── 调用方身份（按对话认人） ──────────────────────────────

/**
 * ToolHost 的依赖：会话此刻打开着的 durable 会话（同步读，**从不打开**；没开 = undefined）。
 * 只用它的 `agentIdentity`。经注入拿（sessionHost.ts import 本模块，反过来 import 会成环）。
 */
export interface DesktopToolHostDeps {
  sessionOf: (
    sessionId: string
  ) =>
    | Pick<DurableSession, 'agentIdentity' | 'harness' | 'currentConversation' | 'redaction'>
    | undefined
}

/**
 * 发起调用的 agent 在工具眼里的身份：按对话问运行时（`DurableSession.agentIdentity`）——
 * 派生 agent（含 hook agent）的对话认成它自己（kind 'spawned'、callerId = agentId），锁的那条和
 * 其余对话认成锁住的根 agent。运行时给的对象原样交回，桌面不另推导（同一个来源）。
 * 每次现问、不缓存（锁 / 记录随时可能变、会话可能重开）；会话没开、没锁或问的过程抛错 → undefined，
 * 用的地方落回各自的兜底。
 */
function agentOfSession(
  deps: DesktopToolHostDeps,
  sessionId: string
): (conversationId: number) => ToolAgentIdentity | undefined {
  return (conversationId) => {
    try {
      return deps.sessionOf(sessionId)?.agentIdentity(conversationId)
    } catch (error) {
      log.warn(
        `agent identity lookup failed for session ${sessionId} conversation ${conversationId}: ${error instanceof Error ? error.message : String(error)}`
      )
      return undefined
    }
  }
}

/**
 * 会话级 ToolContext：询问 / 项目配置 / fileTime / 输出落盘都归这个会话；身份按调用现取（agentOf）；
 * 命令沙箱钉子随装配给（没给 = bash 按此刻的全局开关给一份占位）。
 */
function sessionToolContext(
  deps: DesktopToolHostDeps,
  sessionId: string,
  sandboxed?: boolean,
  rootSkills?: readonly string[]
): ToolContext {
  return {
    sessionId,
    // 询问经 broker 送到认领这个会话的那一方（会话宿主的待答询问表）
    requestUserInput: (request) => requestUserInputFor(sessionId, request),
    emitChatEvent: (event) => chatFrontendRegistry.broadcast({ ...event, sessionId } as ChatEvent),
    agentOf: agentOfSession(deps, sessionId),
    ...(sandboxed === undefined ? {} : { sandboxed }),
    ...(rootSkills === undefined ? {} : { rootSkills })
  }
}

/**
 * 这个会话的工具包装器：每个工具包一次（**不要**展开包好的工具 —— 元数据经原型链透出）。
 *  - 落盘 `'auto'`：按这次调用的 agent 工具表里有没有 `read` 定（没有 read 的 agent 取不回全文，
 *    就只在内存里截断），一份实例因此服务每个 agent；截断策略 / 上限读工具自己的声明；
 *  - L1 全工具门的主体按这次调用的对话现取（会话级装配的工具被不同 agent 共用）；
 *  - 每次执行之前先钉住发起它的那条回复里的产物引用（services/artifacts/pins —— 工具一跑文件就可能变），
 *    执行前后看一眼本会话的产物目录，变了就记一版（services/artifacts/history）。
 */
function sessionWrapper(
  deps: DesktopToolHostDeps,
  sessionId: string,
  ctx: ToolContext
): (tool: object) => ToolRegistration {
  const security = (api: ToolExecutionApi): ReturnType<typeof getDesktopSecurityContext> =>
    getDesktopSecurityContext(withCallAgent(ctx, api))
  const executionHooks: ToolExecutionHooks = {
    before: async (call) => {
      await pinCallingReply(deps.sessionOf(sessionId), sessionId, call)
      await prepareArtifactHistory(sessionId)
    },
    after: (call) => recordArtifactChange(sessionId, call)
  }
  return (tool) =>
    wrapDurableTool(tool as AnyTool, {
      sessionId,
      spill: 'auto',
      security,
      executionHooks,
      // 参数里的占位符在执行前换回真值（会话的对照表）
      redaction: () => deps.sessionOf(sessionId)?.redaction
    })
}

/**
 * MCP 调用方 id：按这次调用的对话认人（派生 agent = 它的 agentId）；身份不带调用方 id（根 agent）
 * 或认不出就报会话 id。创建与重建共用 —— 按调用现取，不在注册那一刻定死
 */
function mcpOptions(ctx: ToolContext): McpRegistrationOptions {
  return {
    callerIdOf: (conversationId) =>
      withCallAgent(ctx, { conversationId }).agent?.callerId ?? ctx.sessionId
  }
}

// ─── 按 agent 的工具 ─────────────────────────────────────────

/**
 * 派发工具（`offersDispatchTool` 说给时）。`ctx` 是根会话的 ToolContext（会话 id、询问归根会话）；调用方是谁
 * 由派发工具从调用的 `api` 读（P2-05 PIN-16），这里不再给身份与模型。
 */
function dispatchTool(ctx: ToolContext): object {
  return createAgentTool(ctx)
}

/** 派生 agent 记录的派生字段（锁记录没有；派生形的锁缺了它也照样尽力重建，PIN-04） */
function spawnedFieldsOf(
  record: LockRecord | SpawnedAgentRecord
): Partial<Pick<SpawnedAgentRecord, 'canSpawn'>> {
  if (record.kind !== 'spawned') return {}
  const { canSpawn } = record as Partial<SpawnedAgentRecord>
  return typeof canSpawn === 'boolean' ? { canSpawn } : {}
}

/** 技能工具在档案 `shuvix-tools` 里的写法（tools/skillTool 注册的名字） */
const SKILL_TOOL = 'skill'

/** 名单里点了名的 MCP 服务器（去掉 `mcp:` 前缀，名单序） */
function mcpServersOf(names: readonly string[]): string[] {
  return names.filter((name) => name.startsWith('mcp:')).map((name) => name.slice(4))
}

/** 等一个 promise，signal 一落就以它的 reason 失败（底下的连接照样连完，下次用到时直接复用） */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

type ResolvedMcp = NonNullable<ResolvedAgentTools['mcp']>[number]

/**
 * 把一台 MCP 服务器连上（创建与打开时的完整初始化共用这一条路，option A）：连接期间把状态推给会话（占位
 * 卡上写明「正在连接 MCP」；已连上的不报 —— 它瞬间落定，报了只会闪一下），等待按
 * `LAZY_CONNECT_TIMEOUT_MS` 封顶。连不上就往会话里落一条错误提示（失败要让人看见），交回 false —— 调用方
 * 照常往下走。`signal` 落下时当场放弃等待、原样上抛（不是连接失败，不报错）。
 */
async function ensureMcpConnected(
  server: string,
  sessionId: string,
  signal: AbortSignal
): Promise<boolean> {
  const notify = (connecting: boolean): void =>
    chatFrontendRegistry.broadcast({ type: 'mcp_connecting', sessionId, server, connecting })
  const announce = mcpService.statusByName(server, sessionId) !== 'connected'
  if (announce) notify(true)
  let result: Awaited<ReturnType<typeof mcpService.ensureServerByName>>
  try {
    result = await untilAborted(
      mcpService.ensureServerByName(server, { timeoutMs: LAZY_CONNECT_TIMEOUT_MS, sessionId }),
      signal
    )
  } catch (error) {
    // 被中止：原样上抛（不是连接失败，不报错）；连接本身抛了按连不上处理
    if (signal.aborted) throw error
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (announce) notify(false)
  }
  if (result.ok) return true
  // 没 error = 这台已不在启用列表里（勾选早被 filterAvailableTools 滤掉，属边角情况），静默跳过
  if (result.error) {
    chatFrontendRegistry.broadcast({
      type: 'error',
      sessionId,
      error: i18next.t('chat.mcpConnectFailed', { name: server, error: result.error })
    })
  }
  return false
}

/**
 * MCP 惰性启动：勾选的服务器到创建 agent 这一刻才连（上次失败的在这里自动再试一次）。连不上就少这台的
 * 工具、agent 照常创建（错误提示由 `ensureMcpConnected` 落）。创建被中止（signal）时当场放弃等待，不报错。
 *
 * 连上了交回声明快照与按它建的注册项：工具与记进锁的声明是同一份，重开时按快照重建出来的也就
 * 一模一样（不会多出一次工具增量）。实例按根会话取（派生 agent 与根 agent 共用一份）。
 */
async function connectMcpServer(
  server: string,
  ctx: ToolContext,
  wrap: (tool: object) => ToolRegistration,
  signal: AbortSignal
): Promise<ResolvedMcp | undefined> {
  const sessionId = ctx.sessionId
  if (!(await ensureMcpConnected(server, sessionId, signal))) return undefined
  const declarations: McpToolDeclaration[] = mcpService.declarationsOf(server, sessionId)
  const tools = mcpService
    .registrationsFromDeclarations(server, sessionId, declarations, mcpOptions(ctx))
    .map(wrap)
  return { server, declarations, tools }
}

/**
 * 桌面 ToolHost。`sessionOf` 给会话此刻打开着的 durable 会话：调用方身份（agentOf）按对话问它。
 */
export function createDesktopToolHost(deps: DesktopToolHostDeps): ToolHost {
  return {
    buildBuiltinTools({ sessionId, sandboxed, skills }) {
      // 命令沙箱的钉子：有锁（重开）或刚解析出来（创建）就按它定；还没有 agent 时（undefined）
      // bash 按此刻的开关给一份占位（这份内置工具在创建 agent 时会按解析结果重装）。纯本地：
      // 不读锁、不连服务器（打开会话时就调它）
      // 根 agent 的技能货架：`widget` 工具据此决定讲不讲造组件的动作
      const ctx = sessionToolContext(deps, sessionId, sandboxed, skills)
      const wrap = sessionWrapper(deps, sessionId, ctx)
      // 只收当前平台上存在的工具：档案里另一个平台的版本（Windows 上的 bash、macOS 上的
      // powershell）在这里自然缺位 —— 锁按名单拼次序时只收装了的
      const tools: ToolRegistration[] = []
      for (const entry of getPlatformBuiltinToolEntries()) {
        if (!entry.factory) continue
        try {
          tools.push(wrap(entry.factory(ctx)))
        } catch (error) {
          // 一个工具造不出来不该拖垮整个会话（打开 / 重建都靠这一份）：缺它的名字在锁里自然落空
          log.warn(
            `builtin tool "${entry.name}" failed to build for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
      return tools
    },

    async resolveAgentTools(req: AgentToolsRequest, { signal }): Promise<ResolvedAgentTools> {
      if (signal.aborted) throw signal.reason
      // 询问 / 项目配置 / MCP 实例 / 广播 / 输出落盘的归属：root = 自身，派生 = 根会话（从不按 agentId）
      const ctx = sessionToolContext(deps, req.rootSessionId)
      const wrap = sessionWrapper(deps, req.rootSessionId, ctx)

      // 派发工具：名单 opt-in；派生 agent 还要 canSpawn（缺省按 false）
      const agent = offersDispatchTool(req) ? wrap(dispatchTool(ctx)) : undefined

      // SkillTool：档案写了 `skill` 就挂，货架是此刻侧栏里启用着、模型可调用的全部技能（内置的与用户的
      // 一视同仁；与 Claude Code / Codex 同一用法，2026-10-28）；带根会话项目的 projectPath（项目级
      // skills 可见）。只有这一次真有 skill 可给时才挂：空手的工具只是噪音。记进锁 / 记录的是真上架的
      // 那几个（重开时按它重建同一个货架，侧栏之后的开关不影响这个 agent）
      const skillTool = req.names.includes(SKILL_TOOL)
        ? new SkillTool('enabled', sessionProject(req.rootSessionId)?.path)
        : undefined
      const skills = skillTool?.hasSkills ? skillTool.skillNames : []

      // MCP：并发连（实例按根会话：派生 agent 与根 agent 共用一份）；连上的按名单序排
      const attempts = await Promise.all(
        mcpServersOf(req.names).map((server) => connectMcpServer(server, ctx, wrap, signal))
      )
      const mcp = attempts.filter((entry): entry is ResolvedMcp => entry !== undefined)

      return {
        ...(agent === undefined ? {} : { agent }),
        ...(skillTool !== undefined && skills.length > 0 ? { skill: wrap(skillTool) } : {}),
        skills,
        mcp,
        // 命令沙箱钉子（记进锁）：每次创建按此刻的开关重新决定（与旧运行时「销毁即解钉、下次创建
        // 重定」同一结果）；与名单里有没有 bash 无关。派生 agent 同样照此刻的开关答（宿主看不到根锁的
        // 钉子 —— 协调器记的是根锁那一个，不用这个值，PIN-02）
        sandboxed: sandboxGloballyActive(),
        // 附加工具（派生 agent 的 next 等）：与其余工具同样包装（L1 门照过；details / control 原样
        // 透出）、原样交回；root 的锁拒收
        ...(req.extraTools?.length ? { extraTools: req.extraTools.map(wrap) } : {})
      }
    },

    async reconfigureAgentTools(
      { sessionId, servers }: AgentToolsReconfigureRequest,
      { signal, connect }
    ): Promise<ReconfiguredAgentTools> {
      if (signal.aborted) throw signal.reason
      const ctx = sessionToolContext(deps, sessionId)
      const wrap = sessionWrapper(deps, sessionId, ctx)
      // 新勾的服务器：真重配与创建同一条惰性连接的路；预判不连，只交回此刻已连上的那几台
      const mcp: ResolvedMcp[] = []
      const pending: string[] = []
      if (connect) {
        const attempts = await Promise.all(
          servers.map((server) => connectMcpServer(server, ctx, wrap, signal))
        )
        mcp.push(...attempts.filter((entry): entry is ResolvedMcp => entry !== undefined))
      } else {
        for (const server of servers) {
          if (mcpService.statusByName(server, sessionId) !== 'connected') {
            pending.push(server)
            continue
          }
          const declarations: McpToolDeclaration[] = mcpService.declarationsOf(server, sessionId)
          const tools = mcpService
            .registrationsFromDeclarations(server, sessionId, declarations, mcpOptions(ctx))
            .map(wrap)
          mcp.push({ server, declarations, tools })
        }
      }
      return { mcp, ...(pending.length > 0 ? { pending } : {}) }
    },

    async rebuildAgentTools(
      lock: LockRecord | SpawnedAgentRecord,
      { sessionId, extraTools, connect }: AgentToolsRebuildContext
    ): Promise<AgentToolSet> {
      // 完整初始化（option A：新进程里打开一条有可续工作的锁着的会话）：锁记着的服务器当场并发连上，与创建
      // 同一个超时、同一条错误提示；连不上照样往下走 —— 工具一律按声明快照建（锁住期间工具不变）
      if (connect !== undefined) {
        await Promise.all(
          Object.keys(lock.mcp).map((server) =>
            ensureMcpConnected(server, sessionId, connect.signal)
          )
        )
      }
      const ctx = sessionToolContext(deps, sessionId)
      const wrap = sessionWrapper(deps, sessionId, ctx)
      const options = mcpOptions(ctx)
      const spawned = spawnedFieldsOf(lock)
      const offersAgent = offersDispatchTool({
        kind: lock.kind,
        names: lock.toolNames,
        canSpawn: spawned.canSpawn
      })
      return {
        ...(offersAgent ? { agent: wrap(dispatchTool(ctx)) } : {}),
        // 锁赢（与 MCP 同一条规则）：锁记着的技能停用了也照样在架（要生效就销毁 agent），磁盘上没了的
        // 才掉出索引；锁里有技能工具就一直挂着（货架空了照实说「没有」）—— 重开不改工具表
        ...(lock.skills.length > 0
          ? {
              skill: wrap(new SkillTool({ known: lock.skills }, sessionProject(sessionId)?.path))
            }
          : {}),
        // 按声明快照建，不连服务器：第一次调用时经同一条「用到才连」的路原地连上
        mcp: Object.entries(lock.mcp).map(([server, declarations]) => ({
          server,
          tools: mcpService
            .registrationsFromDeclarations(server, sessionId, declarations, options)
            .map(wrap)
        })),
        // 附加工具（派生 agent 的 next）：运行时按记录的结果契约造好交来（PIN-03 R），宿主只包装
        ...(extraTools?.length ? { extraTools: extraTools.map(wrap) } : {})
      }
    }
  }
}

// ─── 创建期变量表（{{shuvix:*}} 占位符取值；原 environment/workspace 段拆解而来） ───

/** 内置作图技能的全局名 */
const DRAWING_SKILL = 'builtin:drawing'
/**
 * artifact 工具的名字（tools/artifact.ts）。这里只拿它比对名单，不为一个字符串去引入工具模块 ——
 * 工具模块加载即自注册。工具名本身就是档案 md 里写的契约，不会悄悄改
 */
const ARTIFACT_TOOL_NAME = 'artifact'

/**
 * 这个 agent 的货架上真有作图技能：名单里有技能工具，且它没在侧栏停用。与 SkillTool 上架是同一个
 * 判断（findModelInvocable）—— 提示里的「先加载 builtin:drawing」因此只出现在加载得到的地方。人设在
 * 创建时冻结，与货架同一刻读侧栏，之后的开关两边都不跟（2026-10-28）。
 *
 * 差一处，写明而不穿线：这里不带项目路径（派生 agent 的变量表 ctx.sessionId 是 agentId，解析不出根会话
 * 的项目），SkillTool 带（按根会话的项目，PIN-09）。两边只在「某个项目级 skill 的 frontmatter 自称 `builtin:drawing`、在那个
 * 项目里顶替了内置那份」时才可能分岔 —— 那是有人故意撞内置命名空间，不值得为它改变量表的入参。
 *
 * 名单里没有技能工具时不去扫技能目录：titler、explore 这些 agent 走的是这条短路。
 */
function hasDrawingSkill(names: readonly string[]): boolean {
  if (!names.includes(SKILL_TOOL)) return false
  return skillService.findModelInvocable().some((s) => s.name === DRAWING_SKILL)
}

/**
 * 根会话的工作目录；会话行已不在（派发途中根会话被删）时为 ''。先查行：resolveProjectConfig 对查不到的
 * 会话会回落到临时工作区并把目录建出来 —— 删除路径刚删掉的文件夹不该被一次派发重新建回来
 */
function rootWorkingDirectory(rootSessionId: string): string {
  if (!sessionRecords.pick(rootSessionId, ['id'])) return ''
  try {
    return resolveProjectConfig(rootSessionId).workingDirectory
  } catch {
    return ''
  }
}

/** 比较路径用的形式：真实路径（家目录可能经符号链接到达），macOS / Windows 上再折叠大小写 */
const FOLD_PATH_CASE = process.platform === 'darwin' || process.platform === 'win32'
function pathKey(p: string): string {
  let real: string
  try {
    real = realpathSync.native(p)
  } catch {
    real = resolve(p)
  }
  return FOLD_PATH_CASE ? real.toLowerCase() : real
}

/**
 * 「Git repository」一行：从工作目录往上找第一个 `.git`（目录，或工作树 / 子模块里的 `.git` 文件）。
 * 工作目录在家目录之下时不查家目录本身及以上 —— 家目录里的 dotfiles 仓库会让每个项目都读成「是」；
 * 工作目录就是家目录时只查它自己。根在工作目录之上时写出根（项目开在仓库里的某个包上，git 命令
 * 照样作用于整个仓库，仓库根的指令文件也在那里）
 */
export function gitRepoLine(workingDirectory: string, home: string = homedir()): string {
  if (!workingDirectory) return 'No'
  const start = resolve(workingDirectory)
  // 「是不是家目录」按 pathKey 比：同一个家目录可能拼写不同（盘符大小写、符号链接）；
  // 往上走、显示根仍用原样的路径
  const homeKey = pathKey(home)
  const rel = relative(homeKey, pathKey(start))
  const insideHome = rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  for (let dir = start; ; ) {
    if (existsSync(join(dir, '.git'))) return dir === start ? 'Yes' : `Yes (root: ${dir})`
    if (pathKey(dir) === homeKey) return 'No'
    const parent = dirname(dir)
    if (parent === dir || (insideHome && pathKey(parent) === homeKey)) return 'No'
    dir = parent
  }
}

/**
 * 桌面变量表：environment 类标量（git/平台/shell/os/日期/语言/版本，取值逻辑自原
 * environment 段平移）+ 工作目录 + 项目名。文本本身（标题/标签/句式）已内化进
 * agent md body；项目提示词不是变量 —— 走活段落（见 desktopPromptHost.resolveProjectPrompt）。
 */
export function desktopPromptVars(ctx: PromptVarsCtx): PromptVars | Promise<PromptVars> {
  // 派生 agent 的 sessionId 是 agentId、cwd 是 ''：工作目录与项目都按根会话查（与 resolveInstruction 同口径）
  const rootSessionId = ctx.rootSessionId ?? ctx.sessionId
  const workingDirectory = ctx.cwd || rootWorkingDirectory(rootSessionId)
  const shellTool = platformShellKind()
  const appVersion = (() => {
    try {
      return app.getVersion()
    } catch {
      return 'unknown'
    }
  })()
  const project = sessionProject(rootSessionId)
  // 作图说明的两个开关按**这一个 agent** 的名单判，与工具解析读的是同一份（ctx.toolNames）：
  // 技能在架才有这份说明（契约与手艺都在技能里，常驻的只有「先加载」），否则整份不出；
  // 手里有 artifact 才教 adopt。
  // 这样说明里提到的每样东西都真在它手里 —— 派发出来的、覆盖了档案的、在侧栏停用了技能的都一样
  const visual = {
    drawingSkill: hasDrawingSkill(ctx.toolNames),
    artifact: ctx.toolNames.includes(ARTIFACT_TOOL_NAME),
    // 交互块不看名单，看回复落在哪儿：只有根 agent 的回复会显示成一条对话（派生 agent 的回复是
    // 交回父 agent 的工具结果），而 Chrome 标签页会话显示在扩展侧栏里 —— 那里的 CSP 跑不了它
    interactive:
      ctx.kind === 'root' &&
      !isChromeTabSessionSettings(sessionRecords.pickSettings(ctx.sessionId, ['chromeTab']))
  }
  return {
    workingDirectory,
    isGitRepo: gitRepoLine(workingDirectory),
    platform: platform(),
    // Shell 一行说的是**命令工具**跑在哪个 shell 里，不是用户的登录 shell：模型据此选语法。
    // 过去取 $SHELL —— 从开始菜单启动的 Windows 应用没有它，模型看到的是 `Shell: unknown`，
    // 于是按 Windows 的直觉写 PowerShell，再被 bash 吞掉 `$`
    shell:
      shellTool === 'powershell'
        ? powerShellEditionLabel(getPowerShellConfig().edition)
        : (shellTool ?? 'unknown'),
    // 本平台命令工具的名字 —— 档案正文用它指代「那个 shell 工具」，而不必写死 bash
    shellTool: shellTool ?? '',
    os: `${osType()} ${osRelease()}`,
    // 本地日历日：与日期通知（dateNotice）同一口径 —— toISOString 是 UTC，东八区 0–8 点会说成前一天
    date: localDate(),
    language: formatLanguageDisplay(i18next.language),
    appVersion,
    // 内联作图：```svg 围栏是什么 + 「本会话第一张图前先加载作图技能」（契约与手艺都在技能里），
    // 技能不在架时为空串、占位符整块消失。与 body 同语言：界面语言是宿主的权威，档案构建期挑 body
    // 用的也是这一个。
    visualGuide: renderVisualGuide(i18next.language, visual),
    visualCraft: renderVisualCraft(i18next.language, visual),
    projectName: project?.name ?? '',
    // 根会话供给 {{shuvix:notebookPath}}（笔记本会话的根 Agent 走 notebook 基座档案）：
    // 非笔记本会话为空串 → 占位块收敛消失。派生 ctx.sessionId 是 agentId，无从解析 —— 不供给，
    // 占位符原样保留并 warn（派生档案本就不该引用它）
    ...(ctx.kind === 'root'
      ? {
          notebookPath:
            sessionRecords.pickSettings(ctx.sessionId, ['notebookPath'])?.notebookPath ?? ''
        }
      : {})
  }
}

// ─── 系统提示词的活段落 ───────────────────────────────────────

/**
 * 桌面 PromptHost：五个活段落的数据源，全部按根会话解析、交回原文（围栏由段落统一加）。
 * 每次请求准备时现调 —— 内容不变 durable 就不重发，变了作为 `pi.system` 增量进下一次请求。
 */
export const desktopPromptHost: PromptHost = {
  // 候选清单来自 agent 档案；cwd 空串（未配置）时按会话项目配置兜底
  resolveInstruction: (sessionId, cwd, candidates) =>
    resolveInstructionContent(cwd || resolveProjectConfig(sessionId).workingDirectory, candidates),
  resolveProjectPrompt: (sessionId) => sessionProject(sessionId)?.systemPrompt?.trim() || null,
  // 知识库引导：只列这条会话启用了哪几个库（不扫库、不数条目、不给路径 —— 路径只由 knowledge
  // 工具发放）；项目会话恒含项目库，一个都没启用就回 null、整段不注入。档案带不带 knowledge
  // 工具那道门在段落选择里
  resolveKnowledgeBases: (sessionId) => renderKnowledgeGuide(enabledBaseChoices(sessionId)),
  /**
   * bot 会话根 agent 的 `<bot_profile>`：绑定的那份 bot md 的正文（只选给 bot 基座上的根 agent ——
   * 子会话、派生 agent 按自己的档案说话）。绑定的 md 不在了 → null，会话照常跑在基座 `bot` 上。
   *
   * 正文就在系统提示词里 = 视同「已读」：bot 用 `edit` 改自己这份文件时不必先 `read`（读后被改的
   * 检测仍然有效 —— 段落每次请求现解析，别处改过之后下一次请求看到的就是新正文，也重新记一次已读）。
   * fileTime 归根会话，所以按 sessionId 记。
   */
  resolveBotContext: (sessionId) => {
    const bot = botService.forSession(sessionId)
    if (!bot) return null
    recordRead(sessionId, bot.basePath)
    return renderBotContext({
      name: bot.file.name,
      displayName: bot.file.displayName,
      file: bot.basePath,
      body: bot.file.body
    })
  }
}

// ─── 档案模型（切档案种子 / 派生 agent） ─────────────────────────

/**
 * 档案 `shuvix-model` 的值 → 可用模型表里的一条（含能力点）。不可用返回 null。
 *
 * 目录只取「已启用提供商的已启用模型」：档案指向一个被停用的模型时视为不可用，
 * 由调用方回落（spawned 回落派发方模型 / 切档案时不写种子），而不是在这里硬拉起
 * 一个用户已经关掉的模型。派生创建（协调器的 resolveProfileModel）与切档案种子共用此函数。
 */
export function resolveProfileModelSpec(spec: string): SubAgentModelConfig | null {
  const hit = resolveModelRef(spec, providerDao.findAllEnabledModels())
  if (!hit) return null
  let capabilities: ModelCapabilities = {}
  try {
    capabilities = hit.capabilities ? JSON.parse(hit.capabilities) : {}
  } catch {
    /* 能力点解析失败按空能力处理，与 resolveSessionAgentContext 同口径 */
  }
  return { provider: hit.providerId, model: hit.modelId, capabilities }
}
