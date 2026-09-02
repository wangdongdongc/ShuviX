/**
 * Agent 档案共享类型（跨端）。
 *
 * AgentProfile：注册表里的 agent 档案（与 agent md frontmatter+body 同构），
 *   主会话（'default'）与派生 agent 统一用它描述"创建基座"。
 * InProcessAgentType：创建/派发执行时用的运行投影（工具白名单 + 系统提示 + sections 声明）。
 * SubAgentRegistry：档案来源的端适配接口（桌面=文件系统扫描；扩展=内嵌常量）。
 */
import type { ModelCapabilities } from '@shuvix/chat-protocol/types/provider'
import type { ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

/** agent 档案（注册表条目） */
export interface AgentProfile {
  /** 唯一标识 */
  name: string
  /** UI 显示名（缺失回退 name） */
  displayName: string
  /** 给主 Agent LLM 看的"何时使用"说明（一句话进派发工具描述） */
  description: string
  /** md 正文 = 系统提示基座 */
  systemPrompt: string
  /** 工具白名单：内置工具名 / 'agent'（嵌套派发）/ 'mcp:serverName' / 'skill:skillName' */
  tools: readonly string[]
  /**
   * `shuvix-model`：该档案指定的模型，`<modelId>` 或 `<provider>/<modelId>`
   * （解析规则见 agentProfile/definitionFile 的 resolveModelRef）。
   * 省略 = 不声明，跟随会话 / 继承派发方。
   */
  model?: string
  /**
   * `shuvix-instruction-files`：该档案认的项目指令文件清单（工作目录内的相对路径）。
   * 顺序即优先级，注入侧取第一个存在且非空的，至多一个；空数组 = 不注入。
   * 派生 agent 按根会话的工作目录解析。
   */
  instructionFiles: readonly string[]
  /**
   * `shuvix-project-awareness`：项目感知 —— 是否让该 agent 了解它所在的项目：
   * 项目提示词（项目设置的纯文本）与项目记忆索引一并注入（派生按根会话的项目解析）。
   */
  projectAwareness: boolean
  /**
   * `shuvix-session-awareness`：会话感知 —— 该档案懂得「自己是一场会话的人格」，
   * 因而可被用户选为会话的 agent（`/<agentName>` 切换 / 输入框档案选择器）。
   * 缺省 false = 只可被派发。只管切换、不管派发；与 BASE_PROFILE_NAMES 不同 ——
   * 那是「两边都不进」。
   */
  sessionAwareness: boolean
  /** 来源（决定 UI 能否编辑/删除） */
  source: 'builtin' | 'user'
  /** 配置所在路径（桌面=agent md 文件路径；扩展可为空） */
  basePath: string
}

/** 创建/派发执行时的运行投影（从 AgentProfile 投影而来） */
export interface InProcessAgentType {
  name: string
  displayName: string
  description: string
  tools: string[]
  /** md 正文（可含 {{shuvix:*}} 占位符，createAgent 时按宿主变量表替换） */
  systemPrompt: string
  /**
   * 档案声明的模型（`shuvix-model` 原样值）。**仅 spawned 生效**：派生 agent 没有会话树
   * 也没有模型选择器，档案是它唯一能表达模型意图的地方，声明了就优先于派发方继承。
   * root 会话不看这里 —— 它的模型以会话树为准（切档案时把档案模型作为种子写进树）。
   */
  model?: string
  /** 项目指令文件清单，顺序即优先级（缺省/空 = 不注入；派生按根会话的项目上下文解析） */
  instructionFiles?: readonly string[]
  /** 项目感知：是否注入项目提示词与项目记忆索引（缺省 false；派生按根会话的项目上下文解析） */
  projectAwareness?: boolean
}

/** 父级注入的模型配置（纯数据，不依赖 pi-ai 类型） */
export interface SubAgentModelConfig {
  provider: string
  model: string
  capabilities: ModelCapabilities
  /** 思考深度；省略时子代理默认 'off'（用户直发/笔记本会传入会话所选） */
  thinkingLevel?: ThinkingLevel
}

/**
 * agent 档案来源（端适配：桌面 fs / 扩展常量）。
 * 纯 md 驱动：文件存在即可派发，无启用开关。派发工具描述为静态文案（不罗列类型），
 * list 仅用于未知名错误里回报可用名。
 */
export interface SubAgentRegistry {
  /** 列出全部具名档案（未知 `agent` ref 的错误提示用） */
  list: () => AgentProfile[]
  /** 按名取档案（具名 `agent` ref 的执行时解析） */
  get: (name: string) => AgentProfile | undefined
}
