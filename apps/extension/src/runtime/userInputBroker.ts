/**
 * 会话 → 询问通道的登记处（扩展）。
 *
 * 内置能力服务器（browser）按会话实例化，它的安全门要能挂询问卡片 —— 而询问通道长在那条会话的
 * 根运行时上。MCP 运行时（mcpRuntime）若直接去拿运行时，就是 agentRuntime → agentHost →
 * mcpRuntime → agentRuntime 的环。所以反过来：装配工具那一刻（agentHost）把通道登记进来，
 * 运行时销毁时注销，server 这边按会话 id 取。与桌面的 userInputBroker 同一个形状。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

type InputChannel = (req: InputRequest) => Promise<InputResponse>

const channels = new Map<string, InputChannel>()

export function setSessionInputChannel(sessionId: string, channel: InputChannel): void {
  channels.set(sessionId, channel)
}

export function clearSessionInputChannel(sessionId: string): void {
  channels.delete(sessionId)
}

/** 挂起一次询问；这条会话眼下没有运行时（没人能答）→ 拒绝，安全门按 fail-closed 处置 */
export function requestUserInputFor(sessionId: string, req: InputRequest): Promise<InputResponse> {
  const channel = channels.get(sessionId)
  return channel ? channel(req) : Promise.reject(new Error('NO_INTERACTIVE_INPUT'))
}
