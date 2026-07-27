/**
 * 用户输入请求 broker —— 按 sessionId 把 InputRequest 转发到对应 AgentSession。
 *
 * 存在的唯一理由是打破静态循环依赖：
 * AgentManager → sessionService → agentSession → agentToolBuilder → AgentTool → AgentManager。
 * sessionService 初始化时注册 resolver，AgentManager（子代理工具装配）消费。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'

type UserInputResolver = (sessionId: string, request: InputRequest) => Promise<InputResponse>

let resolver: UserInputResolver | undefined

export function registerUserInputResolver(fn: UserInputResolver): void {
  resolver = fn
}

/** 未注册或目标会话不存在时 reject（调用方工具收到 tool error） */
export function requestUserInputFor(
  sessionId: string,
  request: InputRequest
): Promise<InputResponse> {
  if (!resolver) {
    return Promise.reject(new Error('User input channel is not available'))
  }
  return resolver(sessionId, request)
}
