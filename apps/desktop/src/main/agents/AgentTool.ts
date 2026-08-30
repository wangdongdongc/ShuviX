/**
 * 子代理派发工具（桌面装配）—— 复用 @shuvix/agent-runtime 的 createDispatchAgentTool。
 *
 * 工具逻辑/静态描述全在共享核心（纯 md 驱动：描述不罗列可用类型，具名派发由用户在
 * 系统提示词里自行引导）；桌面只注入注册表(agentService 扫 ~/.shuvix/agents)、
 * 子代理管理器(agentManager)、abort 文案、父级模型配置。
 * 另保留 registerBuiltinTool 的 presentation，供 ToolCallBlock 渲染 `<label> · <type>`。
 */
import {
  createDispatchAgentTool,
  buildDispatchDescription,
  AgentParamsSchema,
  BASE_PROFILE_NAMES,
  DISPATCH_TOOL_NAME,
  type DispatchAgentTool,
  type SubAgentModelConfig,
  type SubAgentRegistry
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { t } from '../i18n'
import { TOOL_ABORTED, resolveProjectConfig, type ToolContext } from '../services/toolContext'
import { agentService } from '../services/agentService'
import { agentManager } from './AgentManager'
import { registerBuiltinTool } from '../services/toolRegistry'

/**
 * 派发面注册表：两个基座档案（default 主会话 / notebook 笔记本）不进错误提示的可用名
 * 列表 —— 报出来会诱导 LLM 拿基座档案当一次性任务 agent 使（default 是主会话的人格、
 * notebook 是笔记本的人格，都不是为一次性任务写的；论工具清单 default 反而比 coding 窄）。
 * 显式按名 get 仍可解析：用户在自己的系统提示词里点名某个基座档案属显式意图，不在这里拦。
 */
const dispatchRegistry: SubAgentRegistry = {
  list: () => agentService.listAll().filter((a) => !BASE_PROFILE_NAMES.has(a.name)),
  get: (name) => agentService.getProfile(name)
}

/** 父级注入的构建上下文 */
export interface AgentToolContext {
  /** 派生 agent 的模型配置；getter 形态在派发时求值（跟随会话当前模型/思考档位） */
  modelConfig: SubAgentModelConfig | (() => SubAgentModelConfig)
  /** 所属根会话 id（路径 ref 的相对路径基准；缺省 ctx.sessionId —— 主 Agent 即根会话） */
  rootSessionId?: string
}

/** 创建桌面 agent 派发工具实例（root 与派生统一经 agentHost.resolveTools 注入） */
export function createAgentTool(ctx: ToolContext, agentCtx: AgentToolContext): DispatchAgentTool {
  const rootSessionId = agentCtx.rootSessionId ?? ctx.sessionId
  return createDispatchAgentTool({
    registry: dispatchRegistry,
    manager: agentManager,
    label: t(BUILTIN_TOOL_PRESENTATIONS.agent.labelKey),
    modelConfig: agentCtx.modelConfig,
    parentSessionId: ctx.sessionId,
    abortError: TOOL_ABORTED,
    // 路径 ref：相对路径以根会话工作目录为基准（惰性解析，跟随会话当前项目配置）
    resolveAgentFile: (path) =>
      agentService.loadAgentFromRef(path, resolveProjectConfig(rootSessionId).workingDirectory)
  })
}

// ─── 注册到 toolRegistry（仅 presentation/label，供 ToolCallBlock 渲染查找） ───
registerBuiltinTool({
  name: DISPATCH_TOOL_NAME,
  group: 'agent',
  hidden: true, // 单工具不在工具选择器里出现；它的"开关"语义即"全部子代理"
  getLabel: () => t(BUILTIN_TOOL_PRESENTATIONS.agent.labelKey),
  getHint: () => t('tool.agentHint'),
  presentation: BUILTIN_TOOL_PRESENTATIONS.agent.presentation,
  // 设置页定义：静态描述（不罗列 agent 类型；桌面支持路径 ref），参数 schema 与派发工具一致
  describe: () => ({
    description: buildDispatchDescription(false, true),
    parameters: AgentParamsSchema
  })
})
