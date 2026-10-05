/**
 * 子代理派发工具（桌面装配）—— 复用 @shuvix/agent-runtime 的 createDispatchAgentTool。
 *
 * 工具逻辑/静态描述全在共享核心（纯 md 驱动：描述不罗列可用类型，具名派发由用户在
 * 系统提示词里自行引导）；桌面只注入注册表(agentService 扫 ~/.shuvix/agents)、
 * 派生 agent 路由(agentManager)、会话 id、abort 文案。调用方是谁（对话、现取的模型与思考档位）
 * 由派发工具从这次调用的 `api` 读，不再注入（P2-05 PIN-16）。
 * 另保留 registerBuiltinTool 的 presentation，供 ToolCallBlock 渲染 `<label> · <type>`。
 */
import {
  createDispatchAgentTool,
  buildDispatchDescription,
  AgentParamsSchema,
  BASE_PROFILE_NAMES,
  DISPATCH_TOOL_NAME,
  HOST_ONLY_PROFILE_NAMES,
  type DispatchAgentTool,
  type SubAgentRegistry
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { t } from '../i18n'
import { TOOL_ABORTED, resolveProjectConfig, type ToolContext } from '../services/toolContext'
import { agentService } from '../services/agentService'
import { agentManager } from './AgentManager'
import { registerBuiltinTool } from '../services/toolRegistry'

/**
 * 派发面注册表：三个基座档案（work 项目会话 / chat 无项目会话 / notebook 笔记本）不进错误
 * 提示的可用名列表 —— 报出来会诱导 LLM 拿基座档案当一次性任务 agent 使（它们各是某种会话
 * 形态的人格，不是为一次性任务写的；论工具清单它们与 coding 逐字相同，分工全在正文）。
 * 显式按名 get 仍可解析：用户在自己的系统提示词里点名某个基座档案属显式意图，不在这里拦。
 *
 * 只由宿主派发的档案（HOST_ONLY_PROFILE_NAMES，今天是权限审查员）更严：按名也解析不到 —— 被审的
 * agent 能派发它，就能反复拿它试探「哪种写法能过审」。
 */
const dispatchRegistry: SubAgentRegistry = {
  list: () =>
    agentService
      .listAll()
      .filter((a) => !BASE_PROFILE_NAMES.has(a.name) && !HOST_ONLY_PROFILE_NAMES.has(a.name)),
  get: (name) => (HOST_ONLY_PROFILE_NAMES.has(name) ? undefined : agentService.getProfile(name))
}

/**
 * 创建桌面 agent 派发工具实例（root 与派生 agent 统一经 agentHost 的 ToolHost 注入）。`ctx` 是会话级的
 * ToolContext：`ctx.sessionId` 即会话 id —— 交给路由（派生 agent 的派发也落在这条会话里），也是路径 ref
 * 的相对路径基准。
 */
export function createAgentTool(ctx: ToolContext): DispatchAgentTool {
  const sessionId = ctx.sessionId
  return createDispatchAgentTool({
    registry: dispatchRegistry,
    manager: agentManager,
    label: t(BUILTIN_TOOL_PRESENTATIONS.agent.labelKey),
    sessionId,
    abortError: TOOL_ABORTED,
    // 路径 ref：相对路径以会话工作目录为基准（惰性解析，跟随会话当前项目配置）。
    // 只由宿主派发的档案按路径也不收 —— 否则把随包发布的那份 md（或它的副本）按路径一指，
    // 按名拦下的审查员就又能被派发出来当预言机
    resolveAgentFile: async (path) => {
      const def = await agentService.loadAgentFromRef(
        path,
        resolveProjectConfig(sessionId).workingDirectory
      )
      if (def && HOST_ONLY_PROFILE_NAMES.has(def.name)) {
        throw new Error(`"${def.name}" is run only by ShuviX and cannot be dispatched`)
      }
      return def
    }
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
    description: buildDispatchDescription(true),
    parameters: AgentParamsSchema
  })
})
