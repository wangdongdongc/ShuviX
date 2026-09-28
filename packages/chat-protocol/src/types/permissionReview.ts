/**
 * 自动审查的判决词汇 —— 判定型 hook `permission.request` 派出的审查 agent 经 `next` 交回它，
 * 安全模块据此放行 / 拒绝 / 转给人，询问卡片展示其中写给人看的那几项。
 *
 * 放在 chat-protocol 是因为三方都要读：agent-runtime 的 hook runner（结果契约的 schema）、
 * 安全模块（按判决执行），以及渲染询问卡片的 chat-ui。设计稿：docs/permission-review-design.md。
 */

/** 判决：放行 / 转给人 / 拒绝。严格程度 deny > ask > allow（多个 hook 同时给出时最严格者胜） */
export const PERMISSION_DECISIONS = ['allow', 'ask', 'deny'] as const
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number]

/** 风险等级 —— 给人看、进日志；执行只看 decision */
export const PERMISSION_RISKS = ['low', 'medium', 'high', 'critical'] as const
export type PermissionRisk = (typeof PERMISSION_RISKS)[number]

/** 一份审查判决（审查 agent 调 `next` 的参数就是它） */
export interface PermissionVerdict {
  decision: PermissionDecision
  risk: PermissionRisk
  /** 写给用户：用会话的语言一句话说清这次操作做什么 */
  summary: string
  /** 写给 agent（拒绝时）与日志：为什么是这个判决 */
  reason: string
}

/**
 * 结果契约的 JSON Schema —— 即审查 agent 的 `next` 工具参数（顶层 object，见 agent-runtime nextTool）。
 *
 * 刻意不设 maxLength：`next` 用它完整校验参数，超长会被判不合格、逼模型再调一次 —— 为一句话的长短多花
 * 一次请求不值，展示与日志侧自己截断。描述写给模型看，所以只用英文。
 */
export const PERMISSION_VERDICT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['decision', 'risk', 'summary', 'reason'],
  properties: {
    decision: {
      type: 'string',
      enum: [...PERMISSION_DECISIONS],
      description:
        'allow = run it without asking; ask = put it in front of the user; deny = refuse it outright (only for clearly harmful operations).'
    },
    risk: { type: 'string', enum: [...PERMISSION_RISKS] },
    summary: {
      type: 'string',
      description:
        'One sentence for the user, in the language of the conversation, saying what this operation does.'
    },
    reason: {
      type: 'string',
      description: 'Why this decision. The agent reads it when the operation is denied.'
    }
  },
  additionalProperties: false
}

/** 形状守卫 —— 捕获值来自模型，`next` 已按 schema 校验过，这里是交给执行方之前的最后一道 */
export function isPermissionVerdict(value: unknown): value is PermissionVerdict {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (PERMISSION_DECISIONS as readonly unknown[]).includes(v.decision) &&
    (PERMISSION_RISKS as readonly unknown[]).includes(v.risk) &&
    typeof v.summary === 'string' &&
    typeof v.reason === 'string'
  )
}

/** 判决的严格程度（数大者更严）—— 多个判定 hook 同时给出结论时取最大者 */
export function permissionDecisionSeverity(decision: PermissionDecision): number {
  return PERMISSION_DECISIONS.indexOf(decision)
}
