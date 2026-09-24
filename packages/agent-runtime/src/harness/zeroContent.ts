import type { AgentMessage } from '@earendil-works/pi-agent-core'

/**
 * 「零内容 assistant 消息」—— provider 偶发返回的空回复（`text: ''`，output 只有 1 个 token）。
 *
 * 它有两重危害，这里只处理第二重：
 *  1. agent-loop 看它没有 toolCall，判定为终答并静默结束整轮（"continue 只跑一轮"）；
 *  2. 它带回来的 usage **不可信** —— 实测 `cacheRead` 归零、`prompt_tokens` 比真实少约 24k
 *     （系统提示词 + 工具 schema 没计进去）。而 pi 的 `estimateContextTokens` 锚定
 *     「最后一条有效 assistant 的 usage」，`stopReason` 又恰好是 'stop'（pi 只排除
 *     error/aborted），于是这条坏数据会把估算硬拽回阈值以下，压缩永不触发。
 *
 * 读 usage 的地方都要先用它剔掉这条：自动压缩的估算（`HarnessSession.maybeAutoCompact`，
 * 锚点自然回落到前一条真实调用上）与运行时注册中心（上下文占用不能跟着缩水，缓存命中率
 * 不能被一条假的「未命中」拉低）。它本身内容为空，不参与这些读数也不丢信息。
 */
export function isZeroContentAssistant(message: AgentMessage): boolean {
  if ((message as { role?: string }).role !== 'assistant') return false
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  return content.every((block) => {
    const b = block as { type?: string; text?: string; thinking?: string }
    if (b.type === 'text') return !b.text?.trim()
    if (b.type === 'thinking') return !b.thinking?.trim()
    // toolCall / image / 其它任何块都算「有内容」
    return false
  })
}
