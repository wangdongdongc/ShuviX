/**
 * 自动脱敏出口的策略判定（services/redactionPolicy.ts）由 index.ts 注入到这里：它要安全模块，静态 import 会把 toolContext
 * 那一串（导入期就建的技能、知识库单例）拖进每个用到它的模块。用它的有两处：会话的出口（sessionHost.ts），以及界面问
 * 「这一处模型收到的是不是真值」（DefaultChatGateway.resolveRedactions）—— 两处同一份判定，界面显示的就是发出去的。
 */
import type { AgentIdentity, EgressDecision, RedactionPolicyRequest } from '@shuvix/agent-runtime'

type RedactionPolicyImpl = (
  request: RedactionPolicyRequest,
  agentOf: (sessionId: string, conversationId: number) => AgentIdentity | undefined
) => EgressDecision

let impl: RedactionPolicyImpl | undefined

export function setRedactionPolicy(next: RedactionPolicyImpl): void {
  impl = next
}

/** 一次请求的出口判定；没注入（测试）= 一律保持占位符 */
export function redactionDecision(
  request: RedactionPolicyRequest,
  agentOf: (sessionId: string, conversationId: number) => AgentIdentity | undefined = () =>
    undefined
): EgressDecision {
  return impl ? impl(request, agentOf) : { applies: true, disclose: () => 'redact' }
}
