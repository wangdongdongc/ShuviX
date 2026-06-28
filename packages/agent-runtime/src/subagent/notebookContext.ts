import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { SubAgentManager } from './manager'
import type { SubAgentModelConfig } from './types'

/**
 * 笔记本会话：在用户 prompt 之前注入一条 user message，仅告知当前笔记本文件的路径，
 * 并提示「如需正文先用 read 工具读取」——不再把笔记正文直接塞进上下文。两端共用以保证措辞一致。
 * filePath 为该 markdown 文件路径（相对工作目录，供 read/write/edit 直接操作）。
 */
export function buildNotebookContextMessage(filePath: string): AgentMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `The user is currently viewing the notebook at \`${filePath}\` (a markdown file in the working directory). If the task needs the notebook's content, use the read tool to read that file first before acting; edit or write the same file when changes are required.`
      }
    ],
    timestamp: Date.now()
  } as AgentMessage
}

/**
 * 由用户 prompt 截取一段作为笔记本子智能体的展示名（面板节标题）。取首行、去空白、限长。
 * 两端共用。空 prompt 兜底 'Notebook'（实际上输入框已要求非空）。
 */
export function notebookTaskName(text: string): string {
  const first = text.trim().split('\n')[0].trim()
  return first.slice(0, 40) || 'Notebook'
}

/** 笔记本一次性子智能体的发送入参（数据来源端特定，组装与派发逻辑两端共用） */
export interface NotebookTaskInputs {
  sessionId: string
  /** 用户 prompt 原文（既作派发名来源，也作子代理 prompt） */
  text: string
  /** 子代理系统提示（端各自装配） */
  systemPrompt: string
  /** 模型配置（provider/model/capabilities） */
  modelConfig: SubAgentModelConfig
  /** 工具白名单：按名解析的内核（桌面）传内置+mcp/skill 名；按注册表解析的（扩展）传 [] */
  tools: string[]
  /** 绑定 md 的项目内相对路径，注入上下文告知子代理（正文由其用 read 读取） */
  notebookPath: string
}

/**
 * 笔记本会话发送：组装一次性 `notebook-task` 子智能体信封 + 注入「路径 + read 提示」上下文，
 * fire-and-forget 派发（不 await 整轮，进展走事件流）。桌面 gateway 与扩展 adapter 共用——
 * 差异仅在 manager 实例、inputs 的数据来源、onError 落点（广播 vs eventBus）。
 */
export function runNotebookTask(
  manager: SubAgentManager,
  inputs: NotebookTaskInputs,
  onError: (message: string) => void
): void {
  const taskName = notebookTaskName(inputs.text)
  void manager
    .runTask({
      parentSessionId: inputs.sessionId,
      agentType: {
        name: 'notebook-task',
        displayName: taskName,
        description: taskName,
        tools: inputs.tools,
        maxTurns: 0,
        systemPrompt: inputs.systemPrompt
      },
      prompt: inputs.text,
      description: taskName,
      modelConfig: inputs.modelConfig,
      contextMessages: [buildNotebookContextMessage(inputs.notebookPath)]
    })
    .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
}
