/**
 * 扩展子代理框架（接入共享 @shuvix/agent-runtime 子代理内核）。
 *
 * 执行/事件转发/abort 全在共享核心；这里只注入浏览器端适配：
 *   - registry：子代理定义来源。预置一个内置 **default** 子代理（继承父会话全部工具）；
 *     具名定义是可选附加，不是启用派发工具的前提（agentRuntime 始终注入 Agent 派发工具）。
 *     将来用户自定义可从 chrome.storage 读后并入。
 *   - resolveTools：直接复用「该会话已建好的全部工具」（子代理与父会话共享工作目录/沙箱，排除 Agent 防递归），
 *     不按定义白名单筛选（与桌面有意不同）。
 *   - buildModel：settingsStore 取 providerInfo + browserEnv → resolveModel。
 *   - getApiKey / broadcast / getAbortedNote。
 */
import i18next from 'i18next'
import {
  createSubAgentManager,
  createDispatchAgentTool,
  type AnyAgentTool,
  type DispatchAgentTool,
  type InProcessAgentType,
  type SubAgentModelConfig,
  type SubAgentRegistry
} from '@shuvix/agent-runtime'
import { settingsStore } from '../storage/settingsStore'
import { eventBus } from './eventBus'
import { resolveSessionModel } from './resolveSessionModel'

/** 每会话「工具名 → 工具实例」表 —— 供 resolveTools 复用父会话已建好的工具（同一沙箱/工作目录） */
const sessionTools = new Map<string, Map<string, AnyAgentTool>>()

export function registerSessionTools(sessionId: string, tools: AnyAgentTool[]): void {
  const map = new Map<string, AnyAgentTool>()
  for (const tool of tools) {
    const name = (tool as { name?: string }).name
    if (name) map.set(name, tool)
  }
  sessionTools.set(sessionId, map)
}

export function clearSessionTools(sessionId: string): void {
  sessionTools.delete(sessionId)
}

/**
 * 扩展子代理注册表 —— 仅放具名专用子代理（当前无；将来用户自定义可从 chrome.storage 并入）。
 * 默认子代理不在此：它由 createExtensionDispatchTool 以 defaultAgentType 注入，subagent_type 省略即用。
 */
export const extensionSubAgentRegistry: SubAgentRegistry = {
  listEnabled: () => [],
  getEnabled: () => undefined
}

/**
 * 构建「默认子代理」运行配置 —— 省略 subagent_type 时派发用。
 * 直接继承父会话：systemPrompt 用父会话同一份；工具由 resolveTools 复用父会话全部（排除 Agent）。
 * tools 留空 → 派发工具描述显示「inherits the caller's tools」；maxTurns 当前不强制（占位）。
 */
function buildDefaultAgentType(parentSystemPrompt: string): InProcessAgentType {
  return {
    name: 'general-purpose',
    displayName: 'General-purpose agent',
    description:
      'Default agent that inherits the current tools and system prompt to run a well-scoped subtask autonomously.',
    tools: [],
    maxTurns: 0,
    systemPrompt: parentSystemPrompt
  }
}

export const subAgentManager = createSubAgentManager({
  resolveTools: (_agentType, parentSessionId) => {
    // 扩展子代理直接复用父会话的「全部工具」（不按定义白名单筛选）——降低复杂度、与父 Agent
    // 保持一致（与桌面的白名单模型有意不同）。Agent 派发工具本身排除以防递归
    // （它在 registerSessionTools 之后才 push，故表里本就没有；这里再做一道防御性过滤）。
    const map = sessionTools.get(parentSessionId)
    if (!map) return []
    return [...map.values()].filter((t) => (t as { name?: string }).name !== 'Agent')
  },
  buildModel: (cfg) => resolveSessionModel(cfg.provider, cfg.model, cfg.capabilities),
  getApiKey: (p) => settingsStore.getApiKey(p) || undefined,
  broadcast: (event) => eventBus.emit(event),
  getAbortedNote: () => i18next.t('agent.toolAborted') || 'Aborted by user.'
})

/**
 * 创建扩展派发工具（由 agentRuntime 始终注入主 Agent）。
 * 传入父会话 systemPrompt：默认子代理(省略 subagent_type 时)直接继承它 + 父会话全部工具。
 */
export function createExtensionDispatchTool(
  parentSessionId: string,
  modelConfig: SubAgentModelConfig,
  parentSystemPrompt: string
): DispatchAgentTool {
  return createDispatchAgentTool({
    registry: extensionSubAgentRegistry,
    manager: subAgentManager,
    modelConfig,
    parentSessionId,
    abortError: 'TOOL_ABORTED',
    defaultAgentType: buildDefaultAgentType(parentSystemPrompt)
  })
}
