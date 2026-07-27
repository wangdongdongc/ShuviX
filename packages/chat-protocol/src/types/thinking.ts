/** 思考深度级别（跨进程协议值，UI 与后端共享） */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** 新建会话的默认思考深度 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'
