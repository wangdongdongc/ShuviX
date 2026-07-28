/** 思考深度级别（跨进程协议值，UI 与后端共享） */
// 'max' 由 pi-agent-core 0.80.10 起可能回传，协议层需要能承载（UI 暂不主动提供该档）
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 新建会话的默认思考深度 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'
