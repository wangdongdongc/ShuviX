import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { inlineTokensToPlainText } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { SubAgentManager } from './manager'
import type { InProcessAgentType, SubAgentModelConfig } from './types'

/**
 * 用户直发派发（kind='agent' 的斜杠命令 `/<agentName> <prompt>`）：不经根 Agent 工具调用，
 * 宿主代码直接 spawn 一个具名子智能体。与笔记本会话同属「用户主动触发」——不传
 * parentToolCallId，前端据此把子会话归入右侧 Sub-agent 面板（而非对话流内联）。
 * 桌面 gateway 与扩展 adapter 共用——差异仅在 manager 实例、agentType/modelConfig 的
 * 数据来源、onError 落点（广播 vs eventBus）。
 */

/** 派发描述取用户 prompt 首行（先把内联 Token 标记还原为人读标签），限长；空兜底 agent 显示名 */
function dispatchDescription(text: string, fallback: string): string {
  const first = text.trim().split('\n')[0].trim()
  return first.slice(0, 40) || fallback
}

/** 用户直发派发入参（数据来源端特定，组装与派发逻辑两端共用） */
export interface UserDispatchInputs {
  sessionId: string
  /** 具名 agent 定义的运行配置投影（toInProcessAgentType）；systemPrompt/tools 随定义 */
  agentType: InProcessAgentType
  /** 用户 prompt 展示文本（可含 at/paste 内联 Token 标记时由内核解析真实文本） */
  text: string
  /** 前端展开的内联 Token（@ 引用 / 粘贴）；内核解析真实文本并随 register 广播供面板渲染 */
  inlineTokens?: Record<string, InlineToken>
  /** 模型配置（provider/model/capabilities/thinkingLevel，沿用会话所选） */
  modelConfig: SubAgentModelConfig
}

/**
 * fire-and-forget 派发（不 await 整轮，进展走事件流）。
 * 返回整轮完成的 promise（永不 reject，错误已经 onError 消化）供宿主观察运行生命周期；调用方可忽略。
 */
export function runUserDispatchTask(
  manager: SubAgentManager,
  inputs: UserDispatchInputs,
  onError: (message: string) => void
): Promise<void> {
  // 描述取人读文本：把 slash/粘贴标记还原为标签，避免面板出现 {{shuvixInlineToken:…}} 原始标记
  const description = dispatchDescription(
    inlineTokensToPlainText(inputs.text, inputs.inlineTokens),
    inputs.agentType.displayName
  )
  return manager
    .runTask({
      parentSessionId: inputs.sessionId,
      agentType: inputs.agentType,
      prompt: inputs.text,
      promptInlineTokens: inputs.inlineTokens,
      description,
      modelConfig: inputs.modelConfig
    })
    .then(() => undefined)
    .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
}
