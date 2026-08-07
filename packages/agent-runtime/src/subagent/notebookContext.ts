import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { inlineTokensToPlainText } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { SubAgentManager } from './manager'
import type { SubAgentModelConfig } from './types'

/**
 * 笔记本会话：当前笔记本文件路径 + 「如需正文先用 read 工具读取」的说明文本。
 * 并入子代理 system prompt（而非单独一条 user 上下文消息）——它属于平台操作上下文、应作系统指令而非
 * 对话里的用户消息出现。两端共用以保证措辞一致。filePath 为该 md 文件相对工作目录的路径。
 */
export function buildNotebookContextText(filePath: string): string {
  return `The user is currently viewing the notebook at \`${filePath}\` (a markdown file in the working directory). If the task needs the notebook's content, use the read tool to read that file first before acting; edit or write the same file when changes are required.`
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
  /** 用户 prompt 展示文本（既作派发名来源，也作子代理 prompt；含内联 Token 标记时由内核解析） */
  text: string
  /** 前端展开的内联 Token（slash 命令 / skill）；内核解析为发给子代理的真实指令并随 register 广播 */
  inlineTokens?: Record<string, InlineToken>
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
 * 返回整轮完成的 promise（永不 reject，错误已经 onError 消化）供宿主观察运行生命周期
 * （如扩展端标签页租约）；调用方可忽略。
 */
export function runNotebookTask(
  manager: SubAgentManager,
  inputs: NotebookTaskInputs,
  onError: (message: string) => void
): Promise<void> {
  // 展示名取人读文本：把 slash 命令标记还原为 "/cmd" 标签，避免标题出现 {{shuvixInlineToken:…}} 原始标记
  const taskName = notebookTaskName(inlineTokensToPlainText(inputs.text, inputs.inlineTokens))
  // 笔记本上下文（路径 + read 提示）并入 system prompt，而非单独 user 上下文消息
  const systemPrompt = [inputs.systemPrompt, buildNotebookContextText(inputs.notebookPath)]
    .filter(Boolean)
    .join('\n\n')
  return manager
    .runTask({
      parentSessionId: inputs.sessionId,
      agentType: {
        name: 'notebook-task',
        displayName: taskName,
        description: taskName,
        tools: inputs.tools,
        systemPrompt
      },
      prompt: inputs.text,
      promptInlineTokens: inputs.inlineTokens,
      description: taskName,
      modelConfig: inputs.modelConfig
    })
    .then(() => undefined)
    .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
}
