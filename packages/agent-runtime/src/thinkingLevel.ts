/**
 * 思考深度编排（宿主无关）—— 桌面 / 扩展共享，避免各端各写一份导致行为漂移。
 */
import { DEFAULT_THINKING_LEVEL, type ThinkingLevel } from '@shuvix/chat-protocol/types/thinking'

/**
 * 会话初始思考深度：思考与模型能力点解绑——优先采用会话持久化的值（含显式 'off'），
 * 仅当无持久化值时才按模型是否声明 reasoning 给默认（medium / off）。
 */
export function resolveInitialThinkingLevel(opts: {
  persisted?: string | null
  reasoning?: boolean
}): ThinkingLevel {
  return (opts.persisted as ThinkingLevel) || (opts.reasoning ? DEFAULT_THINKING_LEVEL : 'off')
}
