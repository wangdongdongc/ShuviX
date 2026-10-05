/**
 * 统一 agent 创建管线 —— 宿主适配面 + 创建入口。
 *
 * `createAgentFactory(host)` 接收宿主一次性注入的端适配面（工具解析 / 事件汇 / 档案模型解析…），
 * 返回 `createAgent(params)`。「这个 agent 是什么」（初始模型、思考档位、工具名单）是纯派生，住在
 * `durable/agentSpec.ts`；本文件只剩宿主契约与创建入口。
 *
 * **现状（pi-durable 切换中）**：本工厂只剩**派生 agent** 一条路。会话的根 agent 由它的 durable 会话
 * 自己创建（锁：`DurableSession.createAgent()`，`durable/lock.ts`；桌面经 SessionHost 接线），这里收到
 * `kind: 'root'` 直接拒绝。派生：先派生规格（校验入参、解析档案模型），然后抛
 * `PhasePendingError` —— TODO(pi-durable p2) 派生 agent 落在 durable 子对话上。
 */
import type { ImageContent } from '@earendil-works/pi-ai'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'
import { PhasePendingError } from '../errors/phasePending'
import { deriveAgentSpec, type AgentSpecHost } from '../durable/agentSpec'
import type { InlineTokensSidecar } from '../legacy/harnessV3/projection'
import type { RuntimeEventSink } from '../types'
import type { InProcessAgentType, SubAgentModelConfig } from '../subagent/types'
import type {
  AnyAgentTool,
  SpawnContext,
  SpawnedRuntime,
  SubAgentToolHelpers
} from '../subagent/manager'
import type { AgentKind } from './promptVars'

/** 工具解析请求 —— 宿主 resolveTools 的唯一入参（合并旧 buildTools 与 buildSubAgentTools 两条路径） */
export interface ToolResolveRequest {
  kind: AgentKind
  /** 询问/项目配置/输出落盘的归属会话（root=自身；spawned=所属根会话） */
  rootSessionId: string
  /** 本运行时 id（派发工具的 parentSessionId；root=会话 id，spawned=agentId） */
  selfSessionId: string
  /** 本次创建的运行投影（宿主策略可读白名单来源等） */
  profile: InProcessAgentType
  /** 归一后的工具名单（保序去重）：档案全量 + overlay（root 的 overlay 只收 mcp:/skill:） */
  names: readonly string[]
  /**
   * 派发工具的模型配置（惰性）：跟随会话当前模型与思考档位 ——
   * 静态快照会在会话中途 setThinkingLevel 后陈旧。
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

/**
 * 宿主一次性注入的端适配面。
 *
 * 规格派生要用的 seam（档案模型 / 日志）见 `AgentSpecHost`。旧运行时专属的 seam（buildModel /
 * getApiKey / network / openSessionTree / createExecutionEnv / httpLog / transformToolResult）随
 * pi 0.80 的 agent 包一起删掉了：模型层由 P1-02/P1-03 重建，会话存储由 P1-07/P1-10 重建。
 * 系统提示词的变量表与各注入解析也不在这里：durable 的人设冻结与段落扩展各有自己的 seam
 * （`PromptHost` / promptVars，见 `durable/seams.ts`）。
 */
export interface AgentHostAdapter extends AgentSpecHost {
  resolveTools: (req: ToolResolveRequest) => AnyAgentTool[] | Promise<AnyAgentTool[]>
  eventSink: RuntimeEventSink
}

export interface CreateAgentParams {
  kind: AgentKind
  /** root=会话 id；spawned=agentId（sub-<uuid>） */
  sessionId: string
  /** 运行投影（getAgentProfile(...) 经 toInProcessAgentType 投影，或宿主就地组装） */
  profile: InProcessAgentType
  /** 初始模型配置（会话解析值 / 派发方传入） */
  model: SubAgentModelConfig
  /**
   * 已解析的思考档位（root=会话设置；spawned=modelConfig.thinkingLevel ?? 'off'）。
   * spawned 时档案声明的 `shuvix-thinking` 压过它（见 agentSpec 决策表的思考一行）。
   */
  thinkingLevel?: ThinkingLevel
  /** 工作目录（root 必给；spawned 传 '' —— 工具自带执行环境） */
  cwd: string
  /**
   * 会话级工具 overlay（mcp:/skill: 勾选）；spawned 缺省 []。
   *
   * root 传的是会话设置里的扩展能力勾选，**只在创建这一刻读一次**：产物上没有换工具的入口，
   * 想换就等下一个运行时（宿主在运行时存在期间把勾选锁成只读）。
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
}

/**
 * agent 运行时句柄（过渡形状）—— 旧 HarnessSession 的公共面去掉 pi 专有的部分。
 *
 * 派生协调器只用 `SpawnedRuntime` 那一截（会话的根 agent 已是 DurableSession，不经这里）。
 * TODO(pi-durable p2): 派生 agent 落在 durable 子对话上时换掉这个形状。
 */
export interface AgentRuntime extends SpawnedRuntime {
  /** 发送一轮 prompt；`display` 是内联 Token 显示侧车（TODO(pi-durable p3)：DisplayDoc） */
  prompt(
    text: string,
    images?: ImageContent[],
    display?: InlineTokensSidecar
  ): Promise<{ error?: string }>
  /** 运行中注入引导消息 */
  steer(text: string): Promise<void>
  /** 本轮结束前追加消息，继续同一次运行 */
  followUp(text: string): Promise<void>
  /** 排队到下一轮 prompt 之前 */
  nextTurn(text: string): Promise<void>
  /** 送达系统侧通知：运行中即刻插话，空闲就排到下一轮 */
  notify(text: string): Promise<void>
  /** 空闲时替会话起一轮（自动续跑）；起不成返回 false */
  resume(text: string): Promise<boolean>
  getThinkingLevel(): ThinkingLevel
  setThinkingLevel(level: ThinkingLevel): Promise<void>
  /** 会话当前上下文对应的 UI 消息列表 */
  listChatMessages(): Promise<ChatMessage[]>
  /** 当前是否有 run 在跑 */
  readonly isStreaming: boolean
  /** 挂起中的用户询问数 */
  readonly pendingInputCount: number
  /** 待答询问的人读摘要 */
  readonly pendingInputSummaries: string[]
  requestUserInput(request: InputRequest): Promise<InputResponse>
  respondToInput(requestId: string, response: InputResponse): boolean
}

/** createAgent 的产物：运行时 + 与创建口径配套的运行期操作 */
export interface CreatedAgent {
  readonly runtime: AgentRuntime
  readonly profile: InProcessAgentType
  /** 创建时组装的完整系统提示（调试/信息面板用） */
  readonly systemPrompt: string
  /**
   * 派发工具惰性读取：{...模型配置, thinkingLevel: 当前档位}。模型在创建时定死 —— 运行期没有
   * 换模型的入口（宿主要换就销毁运行时、按新模型重建），档位可调故现读。
   */
  getModelConfig(): SubAgentModelConfig
  /** 弃用本运行时时调用（会话失效/销毁、派生 agent 销毁）：释放与创建配套的登记 */
  dispose(): void
}

export interface AgentFactory {
  createAgent(params: CreateAgentParams): Promise<CreatedAgent>
}

export function createAgentFactory(host: AgentHostAdapter): AgentFactory {
  async function createAgent(params: CreateAgentParams): Promise<CreatedAgent> {
    // 会话的根 agent 由它的 durable 会话创建（锁），不经本工厂
    if (params.kind === 'root') {
      throw new Error(
        'createAgent builds spawned agents only; a session root agent is created by its durable session (DurableSession.createAgent)'
      )
    }
    // 先派生规格：入参校验（缺 spawn 上下文即抛）、档案模型照常解析一遍
    await deriveAgentSpec(host, params)
    // TODO(pi-durable p2): 派生 agent 落在 durable 子对话上（phase 2）
    throw new PhasePendingError('spawned agents', 2)
  }

  return { createAgent }
}
