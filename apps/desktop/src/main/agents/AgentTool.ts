/**
 * 子代理派发工具（桌面装配）—— 复用 @shuvix/agent-runtime 的 createDispatchAgentTool。
 *
 * 工具逻辑/动态描述全在共享核心；桌面只注入注册表(agentService 扫 ~/.shuvix/agents)、
 * 子代理管理器(agentManager)、MCP 连接判定(mcpService)、abort 文案、父级模型配置。
 * 另保留 registerBuiltinTool 的 presentation，供 ToolCallBlock 渲染 `Agent · <type>`。
 */
import {
  createDispatchAgentTool,
  type DispatchAgentTool,
  type SubAgentModelConfig
} from '@shuvix/agent-runtime'
import { TOOL_ABORTED, type ToolContext } from '../services/toolContext'
import { mcpService } from '../services/mcpService'
import { agentService } from '../services/agentService'
import { agentManager } from './AgentManager'
import { registerBuiltinTool } from '../services/toolRegistry'

/** 父级注入的构建上下文 */
export interface AgentToolContext {
  modelConfig: SubAgentModelConfig
}

/** 创建桌面子代理派发工具实例（agentToolBuilder 直接调用，需父级注入 modelConfig） */
export function createAgentTool(ctx: ToolContext, agentCtx: AgentToolContext): DispatchAgentTool {
  return createDispatchAgentTool({
    registry: agentService,
    manager: agentManager,
    modelConfig: agentCtx.modelConfig,
    parentSessionId: ctx.sessionId,
    isMcpConnected: (name) => mcpService.isConnectedByName(name),
    abortError: TOOL_ABORTED
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
    icon: 'Bot',
    summaryField: 'description'
  }
})
