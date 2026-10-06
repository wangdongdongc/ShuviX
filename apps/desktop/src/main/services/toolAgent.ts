/**
 * 调用方 agent 的身份 —— ToolContext 上与「谁在调这个工具」有关的那一截，和用它的两个纯函数。
 *
 * 单独成文件、不带任何服务依赖：工具模块（knowledge / 文件工具）与它们的单测直接引这里，
 * 替身掉 toolContext（它连着 dao / sessionService）时这两个函数照样是真的。
 */
import type { SubAgentModelConfig } from '@shuvix/agent-runtime'

/**
 * 一个 agent 在工具眼里的身份：档案名、root / spawned、惰性模型配置（溯源章的 `<model>` 取它的
 * model）。知识库的溯源章（`generated.by`）、安全主体（agentKind / profileName）读它；缺省 = 未知
 * （各处有各自的兜底，见 agentActorOf / getDesktopSecurityContext）。
 */
export interface ToolAgentIdentity {
  profileName: string
  kind: 'root' | 'spawned'
  getModelConfig?: () => SubAgentModelConfig
  /**
   * 调用方 id（派生 = agent id）—— 一份内置 MCP 实例由根 agent 与它派出的 agent 共用，实例里按调用方
   * 分开的状态（浏览器的快照基线之类）靠它（见 McpCallMeta.callerId）。派生 agent 的身份带它
   * （运行时 `agentIdentity` 给）；缺省 = 根 agent（会话 id）。
   */
  callerId?: string
}

/** 带调用方身份的东西（ToolContext 的那两个成员） */
export interface ToolAgentCarrier {
  /** 固定属于的 agent（按 agent 装配的工具才有） */
  agent?: ToolAgentIdentity
  /** 按 durable 对话认出发起调用的 agent（会话级装配时由宿主给） */
  agentOf?: (conversationId: number) => ToolAgentIdentity | undefined
}

/**
 * 换上**发起这次调用的** agent：`call.conversationId` 经 `ctx.agentOf` 认人，认出来就顶替 `agent`
 * （浅拷贝，其余成员原样同一引用，入参不改）；认不出（没有锁、agentOf 抛错）留着原来的 `agent`。
 * 没有 agentOf 或这次调用没带对话（单测直接调钩子）原样交回。纯函数。
 *
 * 用在身份要紧的地方：知识库溯源章（agentActorOf）、安全主体（getDesktopSecurityContext 每次 enforce
 * 现取）、MCP 调用方 id。
 */
export function withCallAgent<T extends ToolAgentCarrier>(
  ctx: T,
  call: { readonly conversationId?: number } | undefined
): T {
  const conversationId = call?.conversationId
  if (!ctx.agentOf || conversationId === undefined) return ctx
  let agent: ToolAgentIdentity | undefined
  try {
    agent = ctx.agentOf(conversationId)
  } catch {
    agent = undefined
  }
  return agent === undefined ? { ...ctx } : { ...ctx, agent }
}

function actorToken(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').trim().replace(/\s+/g, '-')
  return cleaned || fallback
}

/**
 * 本工具实例所属 agent 的 actor 字符串（OKF §5.2 约定 `<producer>/<version>`）：
 * `shuvix-<profile>/<model>`。模型惰性取；元数据缺失时回落 `shuvix-agent/unknown`：章要盖，
 * 但不能编。知识库的 `generated.by` 与提交 trailer 用它。会话级装配的工具先经 withCallAgent
 * 换上这次调用的 agent 再交进来。
 */
export function agentActorOf(ctx: Pick<ToolAgentCarrier, 'agent'>): string {
  const profile = actorToken(ctx.agent?.profileName, 'agent')
  let model: string | undefined
  try {
    model = ctx.agent?.getModelConfig?.().model
  } catch {
    model = undefined
  }
  return `shuvix-${profile}/${actorToken(model, 'unknown')}`
}
