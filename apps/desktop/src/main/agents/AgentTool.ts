/**
 * 子代理派发工具（桌面装配）—— 复用 @shuvix/agent-runtime 的 createDispatchAgentTool。
 *
 * 工具逻辑/动态描述全在共享核心；桌面只注入注册表(agentService 扫 ~/.shuvix/agents)、
 * 子代理管理器(agentManager)、MCP 连接判定(mcpService)、abort 文案、父级模型配置。
 * 另保留 registerBuiltinTool 的 presentation，供 ToolCallBlock 渲染 `Agent · <type>`。
 */
import {
  createDispatchAgentTool,
  buildDispatchDescription,
  AgentParamsSchema,
  type DispatchAgentTool,
  type SubAgentModelConfig
} from '@shuvix/agent-runtime'
import { TOOL_ABORTED, resolveProjectConfig, type ToolContext } from '../services/toolContext'
import { mcpService } from '../services/mcpService'
import { agentService } from '../services/agentService'
import { agentManager } from './AgentManager'
import { registerBuiltinTool } from '../services/toolRegistry'

/** 父级注入的构建上下文 */
export interface AgentToolContext {
  modelConfig: SubAgentModelConfig
  /** 所属根会话 id（路径 ref 的相对路径基准；缺省 ctx.sessionId —— 主 Agent 即根会话） */
  rootSessionId?: string
}

/** 创建桌面 Agent 派发工具实例（主 Agent 经 agentToolBuilder、派生 agent 经 AgentManager 注入） */
export function createAgentTool(ctx: ToolContext, agentCtx: AgentToolContext): DispatchAgentTool {
  const rootSessionId = agentCtx.rootSessionId ?? ctx.sessionId
  return createDispatchAgentTool({
    registry: agentService,
    manager: agentManager,
    modelConfig: agentCtx.modelConfig,
    parentSessionId: ctx.sessionId,
    isMcpConnected: (name) => mcpService.isConnectedByName(name),
    abortError: TOOL_ABORTED,
    // 路径 ref：相对路径以根会话工作目录为基准（惰性解析，跟随会话当前项目配置）
    resolveAgentFile: (path) =>
      agentService.loadAgentFromRef(path, resolveProjectConfig(rootSessionId).workingDirectory)
  })
}

// ─── 注册到 toolRegistry（仅 presentation/label，供 ToolCallBlock 渲染查找） ───
registerBuiltinTool({
  name: 'Agent',
  group: 'agent',
  defaultEnabled: true,
  hidden: true, // 单工具不在工具选择器里出现；它的"开关"语义即"全部子代理"
  getLabel: () => 'Agent',
  getHint: () => 'Launch a sub-agent to handle a complex task',
  presentation: {
    icon: 'Bot'
  },
  // 设置页定义：描述含当前可用 agent 列表（动态读注册表；桌面支持路径 ref），参数 schema 与派发工具一致
  describe: () => ({
    description: buildDispatchDescription(agentService, undefined, true),
    parameters: AgentParamsSchema
  })
})
