/**
 * Web UI 共享模式 —— 主程序与 renderer / frontend 共享的受控访问级别。
 *
 * - readonly：只读，渲染快照
 * - chat：只读 + 允许发言
 * - full：完整（含工具审批等）
 */
export type ShareMode = 'readonly' | 'chat' | 'full'
