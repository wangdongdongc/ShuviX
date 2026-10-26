import {
  piProviderIdOf,
  type AgentIdentity,
  type EgressDecision,
  type ProviderRow,
  type RedactionPolicyRequest
} from '@shuvix/agent-runtime'
import { providerCredentialPort } from './models/providerCredentialPort'
import { egressDecisionOf } from './redactionJudge'
import { getDesktopSecurityContext } from './toolContext'

/**
 * 自动脱敏出口的策略判定（docs/auto-redaction-design.md §3.2）：发起请求的 agent 是主体，两层怎么判见
 * redactionJudge.ts。不弹窗、不送审查、不记决策日志（judgeGate：出口每一步都判，记下来会把真正的工具操作挤出
 * 审查员看到的那几条）。
 *
 * `provider` 是设置里显示的服务商名字：内置服务商是它的 slug，自定义服务商是用户起的名字（不是内部 id）。
 */
export function desktopRedactionPolicy(
  request: RedactionPolicyRequest,
  agentOf: (sessionId: string, conversationId: number) => AgentIdentity | undefined
): EgressDecision {
  const agent =
    request.conversationId === undefined
      ? undefined
      : agentOf(request.sessionId, request.conversationId)
  const security = getDesktopSecurityContext({
    sessionId: request.sessionId,
    ...(agent === undefined ? {} : { agent })
  })
  return egressDecisionOf(security, providerNameOf(request.provider), request.model)
}

/** 服务商在策略里的名字：内置 = slug，自定义 = 用户起的名字 */
export function policyProviderName(row: Pick<ProviderRow, 'id' | 'name' | 'isBuiltin'>): string {
  return row.isBuiltin ? (piProviderIdOf(row) ?? row.name) : row.name
}

/** pi 的 provider id → 设置里显示的名字；找不到原样交回 */
function providerNameOf(piProviderId: string): string {
  for (const row of providerCredentialPort.listProviders()) {
    if (piProviderIdOf(row) === piProviderId) return policyProviderName(row)
  }
  return piProviderId
}
