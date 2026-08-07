/**
 * 扩展派生 agent 框架（接入共享 @shuvix/agent-runtime 内核）。
 *
 * 执行/事件管线/abort/深度校验全在共享核心（派生 agent 与会话根 agent 共用
 * HarnessSession 运行时，会话树为内存态 InMemorySessionStorage）；这里只注入浏览器端适配：
 *   - registry：具名定义来源 —— 内置 visualization（共享定义）；
 *     将来用户自定义可从 chrome.storage 读后并入。
 *   - resolveTools：默认子代理（定义 tools 为空）复用「根会话已建好的全部工具」
 *     （派生 agent 与根会话共享工作目录/审批范围；与桌面有意不同）；具名定义（tools 非空）
 *     按白名单从会话工具池按名筛选（扩展缺失的名字如 ls/grep/glob 自动跳过），
 *     preview 不在根工具池、白名单声明时就地构建注入。派发工具按 canSpawn 注入
 *     （具名定义须显式白名单 'Agent'，与桌面一致；层级由内核 MAX_AGENT_DEPTH 校验）。
 *   - buildModel：settingsStore 取 providerInfo + browserEnv → resolveModel。
 *   - getApiKey / broadcast / getAbortedNote。
 */
import i18next from 'i18next'
import {
  createSubAgentManager,
  createDispatchAgentTool,
  VISUALIZATION_AGENT,
  type AnyAgentTool,
  type DispatchAgentTool,
  type InProcessAgentType,
  type SubAgentModelConfig,
  type SubAgentRegistry
} from '@shuvix/agent-runtime'
import { settingsStore } from '../storage/settingsStore'
import { eventBus } from './eventBus'
import { createExtensionPreviewTool } from './previewTool'
import { resolveSessionModel } from './resolveSessionModel'

/** 每会话「工具名 → 工具实例」表 —— 供 resolveTools 复用父会话已建好的工具（同一审批范围/工作目录） */
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
 * 扩展子代理注册表 —— 具名专用子代理（内置 visualization；将来用户自定义可从 chrome.storage 并入）。
 * 默认子代理不在此：它由 createExtensionDispatchTool 以 defaultAgentType 注入，`agent` 省略即用。
 *
 * compact 子代理已移除：压缩改由 harness 内建的 compact() 完成。
 */
const BUILTIN_AGENTS = [VISUALIZATION_AGENT]

export const extensionSubAgentRegistry: SubAgentRegistry = {
  listEnabled: () => BUILTIN_AGENTS,
  getEnabled: (name) => BUILTIN_AGENTS.find((a) => a.name === name)
}

/**
 * 构建「默认子代理」运行配置 —— 省略 `agent` 时派发用。
 * 直接继承父会话：systemPrompt 用父会话同一份；工具由 resolveTools 复用父会话全部（排除 Agent）。
 * tools 留空 → 派发工具描述显示「inherits the caller's tools」。
 */
function buildDefaultAgentType(parentSystemPrompt: string): InProcessAgentType {
  return {
    name: 'general-purpose',
    displayName: 'General-purpose agent',
    description:
      'Default agent that inherits the current tools and system prompt to run a well-scoped subtask autonomously.',
    tools: [],
    systemPrompt: parentSystemPrompt
  }
}

export const subAgentManager = createSubAgentManager({
  resolveTools: (agentType, rootSessionId, _helpers, spawn) => {
    // 默认子代理（定义 tools 为空）：直接复用根会话的「全部工具」——降低复杂度、
    // 与根 Agent 保持一致（与桌面的白名单模型有意不同）。
    // 具名定义（tools 非空，如 visualization）：按白名单从会话工具池按名筛选，
    // 扩展没有的名字（ls/grep/glob，桌面 ripgrep 系）自动跳过；preview 不在根工具池，
    // 白名单声明时就地构建注入（mcp:/skill: 前缀条目扩展暂不支持，忽略）。
    // 两种情况都排除根会话身份的 Agent 派发工具，按需换成绑定本 agent 身份的同款：
    // 嵌套派生的子代挂在本 agent 名下，层级越界由内核统一拒绝。
    const map = sessionTools.get(rootSessionId)
    if (!map) return []
    const whitelist = agentType.tools.filter(
      (n) => !n.startsWith('mcp:') && !n.startsWith('skill:')
    )
    const named = whitelist.length > 0
    const tools = [...map.values()].filter((t) => {
      const name = (t as { name?: string }).name ?? ''
      if (name === 'Agent') return false
      return named ? whitelist.includes(name) : true
    })
    if (named && whitelist.includes('preview')) {
      tools.push(createExtensionPreviewTool(rootSessionId) as unknown as AnyAgentTool)
    }
    // 注：session 工具已删除 —— 压缩不再经子代理 + 工具，而是 harness.compact()。
    // 派发工具：默认子代理全员可派发；具名定义须显式白名单 'Agent'（与桌面一致）
    if (spawn.canSpawn && (!named || whitelist.includes('Agent'))) {
      tools.push(
        createExtensionDispatchTool(
          spawn.agentId,
          spawn.modelConfig,
          agentType.systemPrompt
        ) as unknown as AnyAgentTool
      )
    }
    return tools
  },
  buildModel: (cfg) => resolveSessionModel(cfg.provider, cfg.model, cfg.capabilities),
  getApiKey: (p) => settingsStore.getApiKey(p) || undefined,
  broadcast: (event) => eventBus.emit(event),
  getAbortedNote: () => i18next.t('agent.toolAborted') || 'Aborted by user.'
})

/**
 * 创建扩展派发工具（由 agentRuntime 始终注入主 Agent）。
 * 传入父会话 systemPrompt：默认子代理(省略 `agent` 时)直接继承它 + 父会话全部工具。
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
