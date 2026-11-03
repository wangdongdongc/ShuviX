/**
 * 自动脱敏的策略判定（services/redactionPolicy.ts）由 index.ts 注入到这里：它要安全模块，静态 import 会把 toolContext
 * 那一串（导入期就建的技能、知识库单例）拖进每个用到它的模块。用它的有两处：会话写入新内容时（sessionHost.ts），以及
 * 输入框的提示（DefaultChatGateway.inspectRedactions）。
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

/** 对一个模型的判定；没注入（测试）= 一律保持占位符 */
export function redactionDecision(
  request: RedactionPolicyRequest,
  agentOf: (sessionId: string, conversationId: number) => AgentIdentity | undefined = () =>
    undefined
): EgressDecision {
  return impl ? impl(request, agentOf) : { applies: true, disclose: () => 'redact' }
}
