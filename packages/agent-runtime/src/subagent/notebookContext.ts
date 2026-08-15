import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { inlineTokensToPlainText } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { SubAgentManager } from './manager'
import type { SubAgentModelConfig } from './types'

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
  /** 子代理系统提示（端各自装配：notebook 档案 body，{{shuvix:notebookPath}} 已在渲染时替换） */
  systemPrompt: string
  /** 模型配置（provider/model/capabilities）—— 会话所选，notebook 档案未声明模型时用它 */
  modelConfig: SubAgentModelConfig
  /** notebook 档案声明的模型（`shuvix-model` 原样值）；声明了就优先于 modelConfig */
  model?: string
  /** 工具白名单：按名解析的内核（桌面）传内置+mcp/skill 名；按注册表解析的（扩展）传 [] */
  tools: string[]
  /** notebook 档案的两个上下文注入开关（内置默认关；用户覆盖档案打开即经创建管线生效） */
  instructionFiles?: boolean
  projectPrompt?: boolean
}

/**
 * 笔记本会话发送：组装一次性 `notebook-task` 子智能体信封并 fire-and-forget 派发
 * （不 await 整轮，进展走事件流）。人格与笔记路径都来自端渲染好的 notebook 档案
 * systemPrompt —— 本函数不再拼任何提示词。桌面 gateway 与扩展 adapter 共用，
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
  return manager
    .runTask({
      parentSessionId: inputs.sessionId,
      agentType: {
        name: 'notebook-task',
        displayName: taskName,
        description: taskName,
        tools: inputs.tools,
        systemPrompt: inputs.systemPrompt,
        model: inputs.model,
        instructionFiles: inputs.instructionFiles,
        projectPrompt: inputs.projectPrompt
      },
      prompt: inputs.text,
      promptInlineTokens: inputs.inlineTokens,
      description: taskName,
      modelConfig: inputs.modelConfig
    })
    .then(() => undefined)
    .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
}
