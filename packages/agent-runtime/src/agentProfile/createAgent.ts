/**
 * 统一 agent 创建管线 —— 全仓唯一的 HarnessSession 构造入口。
 *
 * `createAgentFactory(host)` 接收宿主一次性注入的端适配面（工具解析/变量表/模型构建/
 * 会话树/事件汇/hooks/指令解析…），返回 `createAgent(params)`：以 agent 档案（md 基座，
 * 内嵌 {{shuvix:*}} 占位符）+ 运行时选择（模型/思考档位/会话工具 overlay）派生出
 * HarnessSessionDeps 的全部参数。root（会话根 agent）与 spawned（派生 agent）的差异
 * 集中在下面一张决策表里，不散落 if-else：
 *
 * | Deps 项                  | root                        | spawned                        |
 * |--------------------------|-----------------------------|--------------------------------|
 * | 初始模型                  | params.model(会话树为准)     | 档案 shuvix-model 优先,否则继承 |
 * | 工具名单                  | 档案内置名 + 会话勾选overlay | 档案全量(含mcp/skill) + overlay |
 * | session                  | host.openSessionTree(落盘)  | InMemorySessionStorage(内存)   |
 * | env                      | host.createExecutionEnv?stub| stub(工具自带执行环境)          |
 * | eventSink                | host.eventSink              | 包一层 hasUserInputCapability=false |
 * | autoCompact              | true                        | false                          |
 * | broadcastUserMessages    | 缺省(true)                  | false(面板经 sub_session_* 展示)|
 * | shouldDeferToolDisplay   | host.shouldDeferToolDisplay | () => true                     |
 * | hooks/onPromptAccepted/transformToolResult | host 注入 | 不注入(现状)                   |
 * | onPayload 日志归属        | 自身 sessionId              | spawn.rootSessionId            |
 * | getCwd                   | () => cwd                   | 缺省('')                       |
 */
import { InMemorySessionStorage, Session } from '@earendil-works/pi-agent-core'
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { HookFirer } from '@shuvix/chat-protocol/types/hook'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { HarnessSession } from '../harness/harnessSession'
import { createModelsAdapter } from '../harness/modelsAdapter'
import { createStubExecutionEnv } from '../harness/stubEnv'
import type { RuntimeEventSink, RuntimeLogger, ToolResultTransform } from '../types'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type { AnyAgentTool, SpawnContext, SubAgentToolHelpers } from '../subagent/manager'
import {
  renderProfileSystemPrompt,
  type AgentKind,
  type PromptVars,
  type PromptVarsCtx
} from './promptVars'

/** 工具解析请求 —— 宿主 resolveTools 的唯一入参（合并旧 buildTools 与 buildSubAgentTools 两条路径） */
export interface ToolResolveRequest {
  kind: AgentKind
  /** 审批/项目配置/输出落盘的归属会话（root=自身；spawned=所属根会话） */
  rootSessionId: string
  /** 本运行时 id（派发工具的 parentSessionId；root=会话 id，spawned=agentId） */
  selfSessionId: string
  /** 本次创建的运行投影（宿主策略可读白名单来源等） */
  profile: InProcessAgentType
  /** 组装后的完整系统提示（基座 + sections）——扩展的默认子代理继承它 */
  systemPrompt: string
  /** 归一后的工具名单：dedupe([...profile.tools, ...overlay])，保序 */
  names: readonly string[]
  /**
   * 派发工具的模型配置（惰性）：跟随会话当前模型与思考档位 ——
   * 静态快照会在会话中途 setModel/setThinkingLevel 后陈旧。
   */
  getModelConfig: () => SubAgentModelConfig
  /** 本次派生身份（仅 spawned）；'Agent' 注入判定 = names 含 'Agent' && (root || spawn.canSpawn) */
  spawn?: SpawnContext
  /** 工具可达的用户输入通道（root=自身运行时；spawned=经 helpers 路由到根会话） */
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
}

/** 宿主一次性注入的端适配面 */
export interface AgentHostAdapter {
  resolveTools: (req: ToolResolveRequest) => AnyAgentTool[] | Promise<AnyAgentTool[]>
  /** 创建期变量表（md body 经 {{shuvix:name}} 占位符引用；每次 createAgent 现算） */
  promptVars: (ctx: PromptVarsCtx) => PromptVars | Promise<PromptVars>
  buildModel: (
    config: SubAgentModelConfig,
    extra?: { baseUrl?: string; apiProtocol?: string }
  ) => Model<Api>
  /**
   * 解析档案声明的模型（`shuvix-model` 原样值 → provider/model/能力点）。
   * 仅 spawned 调用（root 的模型以会话树为准）。宿主对着自己的模型目录解析
   * （规则见 `@shuvix/chat-protocol/agentModelRef`）；不可用（提供商停用 / 模型已删）
   * 返回 null —— 此时回落派发方传入的模型，不阻断派发。
   */
  resolveProfileModel?: (
    spec: string
  ) => SubAgentModelConfig | null | Promise<SubAgentModelConfig | null>
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>
  /** 仅 root：打开持久化会话树（桌面 JSONL / 扩展 OPFS）；spawned 由 factory 内建内存树 */
  openSessionTree: (sessionId: string, cwd: string) => Promise<Session>
  /** 仅 root（桌面 NodeExecutionEnv）；缺省与 spawned 恒为 stub（工具自带执行环境） */
  createExecutionEnv?: (cwd: string) => ExecutionEnv
  eventSink: RuntimeEventSink
  /** 仅 root（桌面按会话读 autoApprove；扩展 ask 判定）；缺省 () => false */
  shouldDeferToolDisplay?: (
    sessionId: string
  ) => (toolName: string, args: Record<string, unknown>) => boolean
  /** 仅 root 应用（派生 agent 维持默认 passthrough，现状） */
  transformToolResult?: ToolResultTransform
  /** 仅 root 注入（派生 agent 无 hooks，现状） */
  hooks?: HookFirer
  httpLog?: {
    logRequest: (params: {
      sessionId: string
      provider: string
      model: string
      payload: unknown
    }) => string
    updateUsage: (
      logId: string,
      input: number,
      output: number,
      total: number,
      responseJson?: string
    ) => void
  }
  logger?: RuntimeLogger
  /**
   * 指令文件解析（profile.instructionFiles 时调用；桌面同步 / 扩展异步均可）。
   * sessionId 恒为根会话 id（派生 agent 按其根会话的项目上下文解析）；cwd 可为空串
   * （派生现状），宿主自行按 sessionId 兜底解析工作目录。
   * 返回**原文**，不要自带前缀 —— 围栏由本模块的 fenceInstructionFile 统一加。
   */
  resolveInstruction?: (
    sessionId: string,
    cwd: string
  ) =>
    | { filename: string; content: string }
    | null
    | Promise<{ filename: string; content: string } | null>
  /** 项目提示词解析（profile.projectPrompt 时调用）：返回原文或 null，围栏由 fenceProjectPrompt 统一加 */
  resolveProjectPrompt?: (rootSessionId: string) => string | null | Promise<string | null>
}

export interface CreateAgentParams {
  kind: AgentKind
  /** root=会话 id；spawned=agentId（sub-<uuid>） */
  sessionId: string
  /** 运行投影（getAgentProfile(...) 经 toInProcessAgentType 投影，或宿主就地组装） */
  profile: InProcessAgentType
  /** 初始模型配置（会话解析值 / 派发方传入） */
  model: SubAgentModelConfig
  /** 已解析的思考档位（root=resolveInitialThinkingLevel；spawned=modelConfig.thinkingLevel ?? 'off'） */
  thinkingLevel?: ThinkingLevel
  /** 工作目录（root 必给；spawned 传 '' —— 工具自带执行环境） */
  cwd: string
  /** 会话级工具 overlay（用户勾选 mcp:/skill:）；spawned 缺省 [] */
  toolOverlay?: readonly string[]
  /** kind='spawned' 必传 */
  spawn?: SpawnContext
  spawnHelpers?: SubAgentToolHelpers
  /** 仅 root：UserPromptSubmit 通过后的首轮快速标题钩子 */
  onPromptAccepted?: (text: string) => void
}

/** createAgent 的产物：运行时 + 与创建口径配套的运行期操作 */
export interface CreatedAgent {
  readonly runtime: HarnessSession
  readonly profile: InProcessAgentType
  /** 创建时组装的完整系统提示（调试/信息面板用） */
  readonly systemPrompt: string
  /** 会话勾选变化：档案基座 + 新 overlay 重解析 → applyTools */
  applyToolOverlay(overlay: readonly string[]): Promise<void>
  /** 统一切模型：host.buildModel → runtime.applyModel（保留当前思考档位），并更新派发用配置 */
  applyModel(
    config: SubAgentModelConfig,
    extra?: { baseUrl?: string; apiProtocol?: string }
  ): Promise<void>
  /** 派发工具惰性读取：{...当前模型配置, thinkingLevel: 当前档位} */
  getModelConfig(): SubAgentModelConfig
}

export interface AgentFactory {
  createAgent(params: CreateAgentParams): Promise<CreatedAgent>
}

/**
 * 上下文注入的围栏标签。
 *
 * 注入内容直接 append 在档案正文之后，而指令文件动辄是档案正文的十几倍（一份大仓的
 * CLAUDE.md 就有几十 KB），且自带 `##` 标题层级 —— 与档案正文的标题同级。没有边界标记时，
 * 模型无从判断「agent 策略」在哪结束、「项目文档」从哪开始。围栏把这条边界显式化：
 * 标签名声明这段文本是什么，闭合标签给出它到哪为止。
 *
 * 不在围栏里写优先级规则 —— 指令文件本就是用户用来覆盖默认行为的入口，断言谁压谁
 * 会改变现有行为，而这里只负责划边界。
 */
const fenceInstructionFile = (filename: string, content: string): string =>
  `<project_instructions file="${filename}">\n${content}\n</project_instructions>`

const fenceProjectPrompt = (text: string): string => `<project_prompt>\n${text}\n</project_prompt>`

/** 会话级工具（用户能在工具选择器里勾选的那两类）；其余为内置工具名 + 'Agent' */
const isSessionScopedTool = (name: string): boolean =>
  name.startsWith('mcp:') || name.startsWith('skill:')

/**
 * 名单归一：档案白名单 + 会话勾选 overlay，去重保序。
 *
 * 档案的 `shuvix-tools` 对内置 / mcp / skill 三类是**一并声明**的，但两类的生效路径不同：
 *  - 内置工具名恒由档案决定（选择器里本就看不到它们）；
 *  - mcp: / skill: 在 **root** 会话是「切档案时写进会话勾选的种子」，最终以勾选为准 ——
 *    否则用户在工具选择器里取消勾选会被档案白名单并集加回来，「可再调整」就是假的。
 *  - spawned 没有选择器也没有会话树，档案即全部（overlay 恒为空）。
 */
function normalizeToolNames(
  kind: AgentKind,
  profileTools: readonly string[],
  overlay: readonly string[] | undefined
): string[] {
  const base = kind === 'root' ? profileTools.filter((n) => !isSessionScopedTool(n)) : profileTools
  return [...new Set([...base, ...(overlay ?? [])])]
}

export function createAgentFactory(host: AgentHostAdapter): AgentFactory {
  async function createAgent(params: CreateAgentParams): Promise<CreatedAgent> {
    const { kind, sessionId, profile, cwd, spawn, spawnHelpers } = params
    if (kind === 'spawned' && !spawn) {
      throw new Error('createAgent: kind="spawned" requires spawn context')
    }
    const rootSessionId = kind === 'root' ? sessionId : spawn!.rootSessionId

    // 运行时前向引用：resolveTools/requestUserInput 的闭包在 agent 执行期才被调用
    // eslint-disable-next-line prefer-const -- 闭包先于赋值定义,声明与构造必须分离
    let runtime: HarnessSession | undefined

    // ── 初始模型（决策表的模型一行）──
    // root：以传入值为准（会话树是唯一事实源；档案模型在「切档案」时作为种子写进树，
    //       否则每次重建都会把用户手选的模型默默还原）。
    // spawned：档案声明优先于派发方继承 —— 派生 agent 既无会话树也无模型选择器。
    //       思考档位不跟着走，仍随派发方（档案只表达「用哪个模型」）。
    // 宿主没注入解析器（resolveProfileModel 可选）时同样回落，但不告警 ——
    // 那是「本端不支持档案模型」，不是「这个模型不可用」，混为一谈会误导排障。
    const canResolveDeclared = kind === 'spawned' && !!profile.model && !!host.resolveProfileModel
    const declaredModel = canResolveDeclared
      ? await host.resolveProfileModel!(profile.model!)
      : null
    if (canResolveDeclared && !declaredModel) {
      host.logger?.warn(
        `agent "${profile.name}" 声明的模型 "${profile.model}" 当前不可用，回落派发方模型`
      )
    }
    const initialModel: SubAgentModelConfig = declaredModel
      ? { ...declaredModel, thinkingLevel: params.model.thinkingLevel }
      : params.model

    // 派发用当前模型配置（applyModel 时更新；thinkingLevel 惰性读运行时当前档位）
    let currentModelConfig: SubAgentModelConfig = initialModel
    const getModelConfig = (): SubAgentModelConfig => ({
      ...currentModelConfig,
      thinkingLevel: runtime
        ? runtime.getThinkingLevel()
        : (params.thinkingLevel ?? currentModelConfig.thinkingLevel)
    })

    const requestUserInput =
      kind === 'root'
        ? (req: InputRequest) => runtime!.requestUserInput(req)
        : spawnHelpers?.requestUserInput

    let systemPrompt = renderProfileSystemPrompt(
      profile,
      await host.promptVars({ sessionId, kind, cwd }),
      host.logger
    )
    // 上下文注入：直接 append 到系统提示词（先指令文件、后项目提示词），不落独立消息。
    // 系统提示词不参与滚动压缩，天然免重注入；root/spawned 同管线，派生按根会话解析。
    if (profile.instructionFiles && host.resolveInstruction) {
      const resolved = await host.resolveInstruction(rootSessionId, cwd)
      if (resolved?.content) {
        systemPrompt += `\n\n${fenceInstructionFile(resolved.filename, resolved.content)}`
      }
    }
    if (profile.projectPrompt && host.resolveProjectPrompt) {
      const text = (await host.resolveProjectPrompt(rootSessionId))?.trim()
      if (text) systemPrompt += `\n\n${fenceProjectPrompt(text)}`
    }

    const buildResolveRequest = (overlay: readonly string[] | undefined): ToolResolveRequest => ({
      kind,
      rootSessionId,
      selfSessionId: sessionId,
      profile,
      systemPrompt,
      names: normalizeToolNames(kind, profile.tools, overlay),
      getModelConfig,
      spawn,
      requestUserInput
    })

    const tools = await host.resolveTools(buildResolveRequest(params.toolOverlay))
    const model = host.buildModel(initialModel)
    const session =
      kind === 'root'
        ? await host.openSessionTree(sessionId, cwd)
        : new Session(
            new InMemorySessionStorage({
              metadata: { id: sessionId, createdAt: new Date().toISOString() }
            })
          )

    const httpLog = host.httpLog
    // 决策表落点：root/spawned 的全部差异集中于此
    runtime = new HarnessSession({
      sessionId,
      session,
      env:
        kind === 'root'
          ? (host.createExecutionEnv?.(cwd) ?? createStubExecutionEnv(cwd))
          : createStubExecutionEnv(),
      models: createModelsAdapter({ getApiKey: (p) => host.getApiKey(p) }),
      model,
      thinkingLevel: params.thinkingLevel,
      systemPrompt,
      tools: tools as AgentTool[],
      eventSink:
        kind === 'root'
          ? host.eventSink
          : {
              broadcast: (event) => host.eventSink.broadcast(event),
              // 派生 agent 自身无输入面板；审批/询问经 requestUserInput 走根会话
              hasUserInputCapability: () => false
            },
      autoCompact: kind === 'root',
      broadcastUserMessages: kind === 'root' ? undefined : false,
      shouldDeferToolDisplay:
        kind === 'root' ? (host.shouldDeferToolDisplay?.(sessionId) ?? (() => false)) : () => true,
      transformToolResult: kind === 'root' ? host.transformToolResult : undefined,
      hooks: kind === 'root' ? host.hooks : undefined,
      httpLog,
      onPayload: httpLog
        ? (payload, requestModel) =>
            httpLog.logRequest({
              // LLM 日志归属：root 记自身；spawned 归到根会话（在日志页可见）
              sessionId: kind === 'root' ? sessionId : spawn!.rootSessionId,
              provider: requestModel.provider,
              model: requestModel.id,
              payload
            })
        : undefined,
      logger: host.logger,
      getCwd: kind === 'root' ? () => cwd : undefined,
      onPromptAccepted: kind === 'root' ? params.onPromptAccepted : undefined
    })
    const rt = runtime

    return {
      runtime: rt,
      profile,
      systemPrompt,

      async applyToolOverlay(overlay: readonly string[]): Promise<void> {
        const next = await host.resolveTools(buildResolveRequest(overlay))
        await rt.applyTools(next as AgentTool[])
      },

      async applyModel(config, extra): Promise<void> {
        const resolved = host.buildModel(config, extra)
        // 保留当前思考档位（省略第二参 → harness 内保持不变）
        await rt.applyModel(resolved)
        currentModelConfig = config
      },

      getModelConfig
    }
  }

  return { createAgent }
}
