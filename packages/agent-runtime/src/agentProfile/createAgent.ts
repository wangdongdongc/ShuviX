/**
 * 统一 agent 创建管线 —— 全仓唯一的 HarnessSession 构造入口。
 *
 * `createAgentFactory(host)` 接收宿主一次性注入的端适配面（工具解析/变量表/模型构建/
 * 会话树/事件汇/指令解析…），返回 `createAgent(params)`：以 agent 档案（md 基座，
 * 内嵌 {{shuvix:*}} 占位符）+ 运行时选择（模型/思考档位/会话工具 overlay）派生出
 * HarnessSessionDeps 的全部参数。root（会话根 agent）与 spawned（派生 agent）的差异
 * 集中在下面一张决策表里，不散落 if-else：
 *
 * | Deps 项                  | root                        | spawned                        |
 * |--------------------------|-----------------------------|--------------------------------|
 * | 初始模型                  | params.model(会话树为准)     | 档案 shuvix-model 优先,否则继承 |
 * | 工具名单                  | 档案全量(含mcp/skill) + 会话勾选overlay | 档案全量(含mcp/skill) + overlay |
 * | session                  | host.openSessionTree(落盘)  | InMemorySessionStorage(内存)   |
 * | env                      | host.createExecutionEnv?stub| stub(工具自带执行环境)          |
 * | eventSink                | host.eventSink              | 包一层 hasUserInputCapability=false |
 * | autoCompact              | true                        | false                          |
 * | broadcastUserMessages    | 缺省(true)                  | false(面板经 sub_session_* 展示)|
 * | onPromptAccepted/transformToolResult | host 注入          | 不注入(现状)                   |
 * | onPayload 日志归属        | 自身 sessionId              | spawn.rootSessionId            |
 */
import { InMemorySessionStorage, Session } from '@earendil-works/pi-agent-core'
import type { AgentTool, ExecutionEnv } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { KNOWLEDGE_TOOL_NAME } from '../knowledge/knowledgeTool'
import { HarnessSession } from '../harness/harnessSession'
import { agentRuntimeRegistry } from '../runtimeRegistry'
import { createModelsAdapter } from '../harness/modelsAdapter'
import { createStubExecutionEnv } from '../harness/stubEnv'
import type { RuntimeEventSink, RuntimeLogger, RuntimeNetwork, ToolResultTransform } from '../types'
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
  /** 询问/项目配置/输出落盘的归属会话（root=自身；spawned=所属根会话） */
  rootSessionId: string
  /** 本运行时 id（派发工具的 parentSessionId；root=会话 id，spawned=agentId） */
  selfSessionId: string
  /** 本次创建的运行投影（宿主策略可读白名单来源等） */
  profile: InProcessAgentType
  /** 组装后的完整系统提示（基座 + sections）——扩展的默认子代理继承它 */
  systemPrompt: string
  /** 归一后的工具名单（保序去重）：档案全量 + overlay（root 的 overlay 只收 mcp:/skill:） */
  names: readonly string[]
  /**
   * 派发工具的模型配置（惰性）：跟随会话当前模型与思考档位 ——
   * 静态快照会在会话中途 setModel/setThinkingLevel 后陈旧。
   */
  getModelConfig: () => SubAgentModelConfig
  /** 本次派生身份（仅 spawned）；'agent' 注入判定 = names 含 'agent' && (root || spawn.canSpawn) */
  spawn?: SpawnContext
  /** 工具可达的用户输入通道（root=自身运行时；spawned=经 helpers 路由到根会话） */
  requestUserInput?: (req: InputRequest) => Promise<InputResponse>
  /**
   * 已实例化的附加工具（如派发结果契约的 `next`，见 subagent/nextTool.ts）。
   * 宿主在按名解析产物**之后**追加，并施加与内置工具相同的包装/门控（截断、L1 门）；
   * 与解析产物同名时以 extraTools 为准（先移除同名再追加）。
   */
  extraTools?: readonly AnyAgentTool[]
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
  /**
   * LLM 请求的网络侧钩子（可选）：换 dispatcher + 回贴 fetch 失败成因。
   * 浏览器宿主不实现 —— 那边既没有 undici 也拿不到 AsyncLocalStorage。
   */
  network?: RuntimeNetwork
  /** 仅 root：打开持久化会话树（桌面 JSONL / 扩展 OPFS）；spawned 由 factory 内建内存树 */
  openSessionTree: (sessionId: string, cwd: string) => Promise<Session>
  /** 仅 root（桌面 NodeExecutionEnv）；缺省与 spawned 恒为 stub（工具自带执行环境） */
  createExecutionEnv?: (cwd: string) => ExecutionEnv
  eventSink: RuntimeEventSink
  /** 仅 root 应用（派生 agent 维持默认 passthrough，现状） */
  transformToolResult?: ToolResultTransform
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
   * 指令文件解析（档案声明了非空清单时调用；桌面同步 / 扩展异步均可）。
   * sessionId 恒为根会话 id（派生 agent 按其根会话的项目上下文解析）；cwd 可为空串
   * （派生现状），宿主自行按 sessionId 兜底解析工作目录。
   *
   * `candidates` 是档案 `shuvix-instruction-files` 的清单（已归一的相对路径，
   * **顺序即优先级**）：宿主按序找第一个存在且非空的读出来，至多一个。
   * 「读哪些文件」的决定权全在档案，宿主不再有自己的候选名表 —— 会话设置里那个
   * 单选下拉正是被这条取代的。返回**原文**，不要自带前缀 —— 围栏由本模块的
   * fenceInstructionFile 统一加。
   */
  resolveInstruction?: (
    sessionId: string,
    cwd: string,
    candidates: readonly string[]
  ) =>
    | { filename: string; content: string }
    | null
    | Promise<{ filename: string; content: string } | null>
  /**
   * 项目提示词解析（profile.projectAwareness 时调用）：返回原文或 null，
   * 围栏由 fenceProjectPrompt 统一加。
   */
  resolveProjectPrompt?: (rootSessionId: string) => string | null | Promise<string | null>
  /**
   * 项目记忆索引解析（同样受 profile.projectAwareness 门控）：返回**渲染好的索引正文**或 null，
   * 围栏由本模块的 fenceProjectMemory 统一加。
   *
   * 与项目提示词共用一个开关、分成两个 seam：一个开关是因为它们表达同一个意图
   * （这个 agent 要不要知道自己在哪个项目里），两个 seam 是因为数据源与围栏都不同 ——
   * 一个来自项目设置的纯文本，一个是现扫记忆目录渲染出来的索引，且宿主可以只实现其中一个
   * （扩展端没有项目记忆，缺这个 seam 就只注入提示词）。
   *
   * 只收 rootSessionId、不收 cwd —— 记忆按项目绑定（无项目会话解析为 null），
   * 与 resolveProjectPrompt 同源，而非像指令文件那样按 cwd 扫盘。
   */
  resolveProjectMemory?: (rootSessionId: string) => string | null | Promise<string | null>
  /**
   * 知识库引导解析（档案带 `knowledge` 工具时调用）：返回围栏正文或 null，围栏由
   * fenceKnowledgeBases 统一加。
   *
   * **不跟项目感知走**：库是用户按会话选的，与「知不知道自己在哪个项目里」无关 —— 不属于任何
   * 项目的会话照样有用户自己的库。门只剩一道工具清单：这段文案通篇是 `knowledge` 工具的用法，
   * 档案不带这个工具时注入它就是在教一个够不着的东西。
   *
   * 只收 rootSessionId（派生按根会话解析）。**不含任何条目** —— 条目怎么进系统提示词是尚未
   * 决定的设计，这里只列出手头有哪几个库。
   */
  resolveKnowledgeBases?: (rootSessionId: string) => string | null | Promise<string | null>
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
  /**
   * 会话级工具 overlay（mcp:/skill: 勾选）；spawned 缺省 []。
   *
   * root 传的是会话设置里的扩展能力勾选，**只在创建这一刻读一次**：产物上没有换工具的入口，
   * 想换就等下一个运行时（宿主在运行时存在期间把勾选锁成只读）。运行期热换刻意不做 ——
   * pi 的 `setTools(tools)` 不带激活名单时沿用旧名单：新加的工具不会被激活，去掉的工具
   * 直接抛 `Unknown tool(s)`。
   */
  toolOverlay?: readonly string[]
  /** kind='spawned' 必传 */
  spawn?: SpawnContext
  spawnHelpers?: SubAgentToolHelpers
  /** 已实例化的附加工具（透传 ToolResolveRequest.extraTools） */
  extraTools?: readonly AnyAgentTool[]
  /**
   * 调用方追加到系统提示词末尾的上下文块（已围栏的文本，逐块以空行分隔，排在项目注入之后）。
   *
   * 与项目上下文同一机制、不同来源：项目注入按会话解析，这些块由**调用方**随本次创建给 ——
   * bot 会话把绑定的那份 bot md 的正文（`renderBotContext`）交给它的**根** Agent；派发路径
   * 经 `RunTaskParams.systemContext` 透传。manager 只透传，不解释内容。
   */
  systemContext?: readonly string[]
  /** 仅 root：UserPromptSubmit 通过后的首轮快速标题钩子 */
  onPromptAccepted?: (text: string) => void
}

/** createAgent 的产物：运行时 + 与创建口径配套的运行期操作 */
export interface CreatedAgent {
  readonly runtime: HarnessSession
  readonly profile: InProcessAgentType
  /** 创建时组装的完整系统提示（调试/信息面板用） */
  readonly systemPrompt: string
  /** 统一切模型：host.buildModel → runtime.applyModel（保留当前思考档位），并更新派发用配置 */
  applyModel(
    config: SubAgentModelConfig,
    extra?: { baseUrl?: string; apiProtocol?: string }
  ): Promise<void>
  /** 派发工具惰性读取：{...当前模型配置, thinkingLevel: 当前档位} */
  getModelConfig(): SubAgentModelConfig
  /**
   * 从运行时注册中心注销。
   *
   * 调用方**必须**在弃用本运行时时调它（会话失效/销毁、派生 agent 销毁），否则注册中心
   * 会留下一个指向已弃 harness 的死条目 —— 监控页会把它显示成"还活着"，而它恰恰是
   * 用来发现这类滞留的。只注销登记，不动 harness 本身（中止/清理各调用方自理）。
   */
  dispose(): void
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

const fenceProjectMemory = (text: string): string => `<project_memory>\n${text}\n</project_memory>`

const fenceKnowledgeBases = (text: string): string =>
  `<knowledge_bases>\n${text}\n</knowledge_bases>`

/** 会话级工具（用户能在工具选择器里勾选的那两类）；其余为内置工具名 + 'agent' */
const isSessionScopedTool = (name: string): boolean =>
  name.startsWith('mcp:') || name.startsWith('skill:')

/**
 * 名单归一：档案白名单 + 会话勾选 overlay，去重保序。
 *
 * 档案的 `shuvix-tools` 对内置 / mcp / skill 三类是**一并声明**的，而且三类都**恒生效** ——
 * root 与 spawned 同一条规则：档案写了什么，这个 agent 就带什么。会话勾选只能往上**加**：
 *  - 内置工具名恒由档案决定（选择器里本就看不到它们）；
 *  - mcp: / skill: 档案声明的那截恒在，会话勾选在其上叠加。选择器与会话设置把档案声明的项
 *    画成「已勾、锁住」（`tools.list` 的 `declaredBy`）—— 界面上取消不了，也就不存在
 *    「取消了却被档案并集加回来」的假勾选。要去掉一项，路径是覆盖这份档案 md。
 *  - root 的 overlay **只收** mcp: / skill:：勾选里混进一个内置名（手改的设置、被新会话继承的
 *    项目配置）不能借 overlay 越过档案 —— bot 基座的窄名单因此是结构保证。
 *  - spawned 没有选择器也没有会话设置，档案即全部（overlay 恒为空）。
 *
 * 于是 `shuvix-tools` 加上会话勾选就是 agent 工具表的完整列举：宿主不在这份名单之外另挂工具
 * （内置技能也要档案点名 `skill:builtin:<name>` 才上架）。
 */
function normalizeToolNames(
  kind: AgentKind,
  profileTools: readonly string[],
  overlay: readonly string[] | undefined
): string[] {
  const added = kind === 'root' ? (overlay ?? []).filter(isSessionScopedTool) : (overlay ?? [])
  return [...new Set([...profileTools, ...added])]
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

    // 名单先于提示词算好：变量表与工具解析读的是**同一份**。提示词里提到某项能力（去加载哪个
    // 技能、用哪个工具改图）只能以它真在这份名单上为前提 —— 两边各算各的，迟早一边指向另一边没有的东西
    const names = normalizeToolNames(kind, profile.tools, params.toolOverlay)
    let systemPrompt = renderProfileSystemPrompt(
      profile,
      await host.promptVars({ sessionId, kind, cwd, toolNames: names }),
      host.logger
    )
    // 上下文注入：直接 append 到系统提示词（指令文件 → 项目提示词 → 项目知识库 → 项目记忆），
    // 不落独立消息。
    // 顺序不声明优先级（同 fence 注释）—— 只是固定的拼接次序。
    // 系统提示词不参与滚动压缩，天然免重注入；root/spawned 同管线，派生按根会话解析。
    if (profile.instructionFiles?.length && host.resolveInstruction) {
      const resolved = await host.resolveInstruction(rootSessionId, cwd, profile.instructionFiles)
      if (resolved?.content) {
        systemPrompt += `\n\n${fenceInstructionFile(resolved.filename, resolved.content)}`
      }
    }
    // 项目感知一个开关带两段注入（项目提示词、只读的旧项目记忆）：数据源与围栏各自独立，但
    // 「要不要知道自己在哪个项目里」只是一个决定；宿主未实现某个 seam 时那一段自然缺席。
    if (profile.projectAwareness && host.resolveProjectPrompt) {
      const text = (await host.resolveProjectPrompt(rootSessionId))?.trim()
      if (text) systemPrompt += `\n\n${fenceProjectPrompt(text)}`
    }
    // 知识库在前、项目记忆在后：前者是在用的库，后者是只读的旧档 —— 旧档的表头指回前者。
    // 这一段**不跟项目感知走**：库是按会话选的，无项目的会话照样有用户自己的库
    if (host.resolveKnowledgeBases && profile.tools?.includes(KNOWLEDGE_TOOL_NAME)) {
      const text = (await host.resolveKnowledgeBases(rootSessionId))?.trim()
      if (text) systemPrompt += `\n\n${fenceKnowledgeBases(text)}`
    }
    if (profile.projectAwareness && host.resolveProjectMemory) {
      const text = (await host.resolveProjectMemory(rootSessionId))?.trim()
      if (text) systemPrompt += `\n\n${fenceProjectMemory(text)}`
    }
    // 调用方给的上下文块（已围栏）：排在项目注入之后，同样住在系统提示词里、免重注入
    for (const block of params.systemContext ?? []) {
      const text = block.trim()
      if (text) systemPrompt += `\n\n${text}`
    }

    const tools = await host.resolveTools({
      kind,
      rootSessionId,
      selfSessionId: sessionId,
      profile,
      systemPrompt,
      names,
      getModelConfig,
      spawn,
      requestUserInput,
      extraTools: params.extraTools
    })
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
      models: createModelsAdapter({ getApiKey: (p) => host.getApiKey(p), network: host.network }),
      model,
      thinkingLevel: params.thinkingLevel,
      systemPrompt,
      tools: tools as AgentTool[],
      eventSink:
        kind === 'root'
          ? host.eventSink
          : {
              broadcast: (event) => host.eventSink.broadcast(event),
              // 派生 agent 自身无输入面板；询问/询问经 requestUserInput 走根会话
              hasUserInputCapability: () => false
            },
      autoCompact: kind === 'root',
      broadcastUserMessages: kind === 'root' ? undefined : false,
      transformToolResult: kind === 'root' ? host.transformToolResult : undefined,
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
      onPromptAccepted: kind === 'root' ? params.onPromptAccepted : undefined
    })
    const rt = runtime

    // 全仓唯一的 HarnessSession 构造点 —— 运行时注册中心在此单点接管 root/spawned 全量，
    // 无需各宿主散点埋点。身份标签只是给监控看的字符串，注册中心不解释其语义。
    const unregister = agentRuntimeRegistry.register(
      {
        agentId: sessionId,
        kind,
        rootSessionId,
        parentAgentId: spawn?.parentAgentId,
        depth: spawn?.depth ?? 0,
        profileName: profile.name,
        displayName: profile.displayName || profile.name
      },
      rt.piHarness,
      session
    )

    return {
      runtime: rt,
      profile,
      systemPrompt,
      dispose: unregister,

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
