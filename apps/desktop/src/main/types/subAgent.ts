/**
 * Sub-Agent 设置页编辑/新建 GUI 的 IPC 参数类型。
 * 载荷与 services/agentDefinitionFile 的 ParsedAgentFile 同构
 * （types 层不得反向依赖 services，故此处结构重复声明）。
 */
export interface SubAgentPayload {
  name: string
  displayName: string
  description: string
  systemPrompt: string
  tools: string[]
  /** `shuvix-model`：指定模型 `<providerId>/<modelId>`；省略 = 不声明（跟随会话） */
  model?: string
  /** `shuvix-instruction-files`：项目指令文件清单，顺序即优先级；空 = 不注入 */
  instructionFiles: string[]
  /** `shuvix-project-prompt`：是否注入项目提示词 */
  projectPrompt: boolean
  projectMemory: boolean
  /** `shuvix-dispatch-only`：只可派发、不可切换为会话档案（GUI 无开关，原样透传） */
  dispatchOnly: boolean
}

export interface SubAgentSaveParams {
  /** 现有 agent 名（定位文件；改名时与 agent.name 不同） */
  originalName: string
  agent: SubAgentPayload
}

export interface SubAgentCreateParams {
  agent: SubAgentPayload
}
