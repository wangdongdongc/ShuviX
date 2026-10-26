/**
 * 自动脱敏出口的两层判定（docs/auto-redaction-design.md §3.2）—— 只此一份：会话的出口（redactionPolicy.ts）与
 * `shuvix policy check --redaction`（policyCheck.ts）都用它，查出来的就是真跑起来的。纯逻辑：安全上下文由调用方给。
 *
 *  - 第一层 `send` × `{type: modelRequest, provider, model}`：放行带 `detect` = 脱敏（redact）；放行不带 = 信任的
 *    目的地，发真值（send）；拒绝（含降级的询问 —— 出口没人可问）= 整个请求不发（block）；
 *  - 第二层 `disclose` × `{type: sensitive, category, rule, provider, model, value}`：放行带 `redact` = 保持占位符；
 *    放行不带 = 发真值；拒绝 = 整个请求不发。`value` 是不可枚举的惰性属性，决策记录序列化不到它。
 */
import type {
  DiscloseAction,
  EgressDecision,
  GateVerdict,
  SecurityContext,
  SecurityObject
} from '@shuvix/agent-runtime'

type Judge = Pick<SecurityContext, 'judgeGate'>

export interface RedactionVerdict {
  action: DiscloseAction
  verdict: GateVerdict
}

export function judgeModelRequest(
  security: Judge,
  provider: string,
  model: string
): RedactionVerdict {
  const verdict = security.judgeGate(
    'send',
    { type: 'modelRequest', provider, model },
    { supportedDispositions: ['detect'] }
  )
  if (!verdict.allowed) return { action: 'block', verdict }
  return { action: verdict.decision.dispositions?.includes('detect') ? 'redact' : 'send', verdict }
}

export function judgeDisclosure(
  security: Judge,
  item: { category: string; rule: string; value: string },
  provider: string,
  model: string
): RedactionVerdict {
  const object: SecurityObject = {
    type: 'sensitive',
    category: item.category,
    rule: item.rule,
    provider,
    model
  }
  Object.defineProperty(object, 'value', { enumerable: false, get: () => item.value })
  const verdict = security.judgeGate('disclose', object, { supportedDispositions: ['redact'] })
  if (!verdict.allowed) return { action: 'block', verdict }
  return { action: verdict.decision.dispositions?.includes('redact') ? 'redact' : 'send', verdict }
}

/** 一次请求的出口判定（第二层按需逐处判） */
export function egressDecisionOf(security: Judge, provider: string, model: string): EgressDecision {
  const first = judgeModelRequest(security, provider, model)
  if (first.action === 'block') return { blocked: true, applies: false, disclose: () => 'redact' }
  return {
    applies: first.action === 'redact',
    disclose: (item) => judgeDisclosure(security, item, provider, model).action
  }
}
