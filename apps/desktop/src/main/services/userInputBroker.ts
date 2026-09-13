/**
 * 用户输入请求 broker —— 把 InputRequest 路由到该会话的输入面板，并把答复送回去。
 *
 * 存在的第一个理由是打破静态循环依赖：
 * AgentManager → sessionService → agentSession → agentToolBuilder → AgentTool → AgentManager。
 * 参与方在模块初始化时把自己注册进来，AgentManager（子代理工具装配）消费。
 *
 * 第二个理由是**请求与答复要落在同一处**。派生 agent 自身没有输入面板（`hasUserInputCapability`
 * 恒 false），它的询问一律带着**根会话 id** 走到这里，由认领该会话的参与方送达。今天只有
 * 一个参与方（sessionService：有根 agent 的会话）；注册表的形状留给将来别的会话形态。
 *
 * **两个方向都在这里**：请求按 sessionId 找归属，答复按 requestId 找归属。它们是同一件
 * 事的两半，此前一半在这里、另一半在 sessionService 里遍历 AgentSession —— 那让网关
 * 不得不知道「答复要去问 sessionService」，也让别的参与方无处插手。
 */
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { createLogger } from '../logger'

const log = createLogger('UserInput')

export interface UserInputParticipant {
  /** 只用于日志与排错 */
  readonly name: string
  /** 这个会话的询问归我路由吗 */
  claims(sessionId: string): boolean
  /** 把请求交给该会话的输入面板，等用户答复 */
  request(sessionId: string, request: InputRequest): Promise<InputResponse>
  /** 这个 requestId 是我发出的吗；是就送达并返回 true */
  respond(requestId: string, response: InputResponse): boolean
}

const participants: UserInputParticipant[] = []

/**
 * 注册一个参与方。
 *
 * 各参与方的 `claims` 应当**互斥**，先注册的
 * 先匹配只是一条兜底规则，不是可以依赖的优先级 —— 真要靠顺序来消歧，说明 claims 写错了。
 */
export function registerUserInputParticipant(p: UserInputParticipant): void {
  participants.push(p)
}

/** 未注册或没人认领时 reject（调用方工具收到 tool error） */
export function requestUserInputFor(
  sessionId: string,
  request: InputRequest
): Promise<InputResponse> {
  if (!participants.length) {
    return Promise.reject(new Error('User input channel is not available'))
  }
  const owner = participants.find((p) => p.claims(sessionId))
  if (!owner) {
    return Promise.reject(new Error(`Session ${sessionId} is not active`))
  }
  return owner.request(sessionId, request)
}

/**
 * 把答复送到发出该请求的那一方。
 *
 * 按 requestId 找归属而不是按 sessionId：requestId 全局唯一，而调用方（IPC）手上的
 * sessionId 只是它以为的那个 —— 用它来选参与方等于把前端的判断当成真相。
 */
export function respondToUserInput(requestId: string, response: InputResponse): boolean {
  for (const p of participants) {
    if (p.respond(requestId, response)) return true
  }
  // 无人认领：请求早已被取消（中止 / 会话拆了），而前端那张卡片还在。静默丢弃会让人
  // 对着一个「点了没反应」的按钮查半天，留一行日志把它变成一句话就能查清的事
  log.warn(`用户输入无处送达 requestId=${requestId}（请求可能已被取消）`)
  return false
}

/** 仅供测试：清空注册表（模块级单例，用例之间必须能互不影响） */
export function resetUserInputParticipantsForTests(): void {
  participants.length = 0
}
