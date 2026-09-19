/**
 * 扩展派生 agent 框架（接入共享 @shuvix/agent-runtime 内核）。
 *
 * 执行/事件管线/abort/深度校验全在共享核心；agent 创建（工具解析/模型构建/内存会话树）
 * 经统一创建管线（runtime/agentHost 的 extensionAgentFactory）完成 —— 派生路径的
 * 工具解析策略（复用父会话工具池、preview 就地构建、派发工具注入）见 agentHost。
 * 这里保留：会话工具池登记（根会话建好工具后供派生复用）、具名定义注册表
 * （内置 visualization）、默认子代理（general-purpose，继承父 prompt/工具的克隆语义，
 * 与基座档案体系正交）、派发工具装配。
 */
import i18next from 'i18next'
import {
  createInlineMdReader,
  createInlineMdReaderFrom
} from '@shuvix/agent-runtime/builtinAgents/inlineSources'
import {
  createSubAgentManager,
  buildBuiltinProfile,
  buildBuiltinProfiles,
  createDispatchAgentTool,
  BASE_PROFILE_NAMES,
  CHAT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  WORK_PROFILE_NAME,
  type AgentProfile,
  type AgentProfileRegistry,
  type AnyAgentTool,
  type DispatchAgentTool,
  type InProcessAgentType,
  type SubAgentModelConfig
} from '@shuvix/agent-runtime'
import { BUILTIN_TOOL_PRESENTATIONS } from '@shuvix/chat-protocol/builtinToolPresentations'
import { eventBus } from './eventBus'
import { extensionAgentFactory } from './agentHost'

/** 每会话「工具名 → 工具实例」表 —— 供派生 agent 复用父会话已建好的工具（同一询问范围/工作目录） */
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

/** 派生工具解析的查表入口（agentHost.resolveSpawnedTools 消费） */
export function getSessionTools(rootSessionId: string): Map<string, AnyAgentTool> | undefined {
  return sessionTools.get(rootSessionId)
}

/**
 * 扩展子代理注册表 —— 具名专用子代理（内置 visualization；将来用户自定义可从 chrome.storage 并入）。
 * 默认子代理不在此：它由 createExtensionDispatchTool 以 defaultAgentType 注入，`agent` 省略即用。
 */
/**
 * 扩展支持的内置档案子集：三个基座档案 work（项目会话）/ chat（不归属项目的会话）/
 * notebook（笔记本会话根 Agent）+ visualization。explore 依赖 ls/grep/glob（ripgrep）扩展
 * 没有，coding 依赖 bash/ssh/database 更是无从谈起；widget 因缺根目录参数被构建器
 * 自动跳过。
 */
const EXTENSION_BUILTIN_NAMES = new Set([
  WORK_PROFILE_NAME,
  CHAT_PROFILE_NAME,
  NOTEBOOK_PROFILE_NAME,
  'visualization'
])

/**
 * 内置 md 的读取口 —— 扩展跑在浏览器里读不了文件，于是构建期把**桌面运行时读的那批同一个
 * 文件**内联进 bundle（inlineSources 的 glob）。桌面那边读的是随包发布的目录，两端的源
 * 仍然只有仓库里那一份。
 */
const SHARED_MD = createInlineMdReader()

/**
 * 扩展的 work / chat 浏览器变体 —— 共享的这两份档案点名了 bash/ssh/glob/grep/ls/skill/
 * 子会话等扩展没有的工具，会误导 Agent；这里按扩展真实能力（read/write/edit/ask/浏览器/
 * MCP）各提供整份档案副本，与共享档案同一套语言回退规则（同名文件覆盖同名内置）。
 *
 * 桌面上这两条路线差在「自己干 vs 交给 coding 子会话」，而扩展既没有 shell 也没有子会话，
 * 两份文案因此只差工作目录形态（项目文件夹 vs 隔离的临时目录）—— 保留两份档案是为了
 * 让「项目会话 work / 无项目会话 chat」这条形态推导在两端指同一件事。
 */
const EXTENSION_MD = createInlineMdReaderFrom(
  import.meta.glob('./builtinAgents/md/*.md', {
    query: '?raw',
    import: 'default',
    eager: true
  }) as Record<string, string>
)

const EXTENSION_OVERRIDE_NAMES = new Set([WORK_PROFILE_NAME, CHAT_PROFILE_NAME])

/** 内置档案现算（文案按当前语言解析；work / chat 换成扩展的浏览器变体） */
function builtinProfiles(): AgentProfile[] {
  const language = i18next.language
  return buildBuiltinProfiles({ language, readMd: SHARED_MD })
    .filter((a) => EXTENSION_BUILTIN_NAMES.has(a.name))
    .map((a) =>
      EXTENSION_OVERRIDE_NAMES.has(a.name)
        ? (buildBuiltinProfile({ name: a.name }, { language, readMd: EXTENSION_MD }) ?? a)
        : a
    )
}

export const extensionSubAgentRegistry: AgentProfileRegistry = {
  listAll: () => builtinProfiles(),
  // 扩展无用户档案,getProfile 即内置现算（'default' 恒存在）
  getProfile: (name) => builtinProfiles().find((a) => a.name === name)
}

/**
 * 构建「默认子代理」运行配置 —— 省略 `agent` 时派发用。
 * 直接继承父会话：systemPrompt 用父会话同一份；工具由派生解析复用父会话全部（排除 Agent）。
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
  // 统一创建管线（箭头包装：ESM 循环下惰性取 factory 绑定）
  createAgent: (params) => extensionAgentFactory.createAgent(params),
  broadcast: (event) => eventBus.emit(event),
  getAbortedNote: () => i18next.t('agent.toolAborted') || 'Aborted by user.'
})

/**
 * 创建扩展派发工具（根会话始终注入；派生 agent 在 agentHost 里换成绑定自身身份的同款）。
 * 传入父会话 systemPrompt：默认子代理(省略 `agent` 时)直接继承它 + 父会话全部工具。
 */
export function createExtensionDispatchTool(
  parentSessionId: string,
  modelConfig: SubAgentModelConfig | (() => SubAgentModelConfig),
  parentSystemPrompt: string
): DispatchAgentTool {
  return createDispatchAgentTool({
    // default 是主会话基座,不进未知名错误的可用名列表,也不可具名派发（比桌面更严:扩展无用户直发场景）
    registry: {
      list: () =>
        extensionSubAgentRegistry.listAll().filter((a) => !BASE_PROFILE_NAMES.has(a.name)),
      get: (name) =>
        BASE_PROFILE_NAMES.has(name) ? undefined : extensionSubAgentRegistry.getProfile(name)
    },
    manager: subAgentManager,
    label: i18next.t(BUILTIN_TOOL_PRESENTATIONS.agent.labelKey),
    modelConfig,
    parentSessionId,
    abortError: 'TOOL_ABORTED',
    defaultAgentType: buildDefaultAgentType(parentSystemPrompt)
  })
}
