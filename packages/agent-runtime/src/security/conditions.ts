/**
 * 结构化条件字段 —— 规则级字段与策略级 `shuvix-policy-scope` 共用的一套语义。
 *
 * 拿出来做字段的，是**每个请求都必然具备的身份标签**（谁 / 什么动作 / 什么客体种类 /
 * 哪个端 / 经由哪个工具）；留在 `match` 里的，是**资源自身的属性**（path/command/sql/
 * gitAction/force…）。这条线正是旧设计翻车的地方：旧的 `object: {kind, prefixes}` 把
 * 身份标签与资源属性塞进同一字段，于是每加一种客体就要给引擎加一个匹配器分支。
 * 这里只取 type 标签，五个键共用**同一套语义**（值 ∈ 列表），新客体类型引擎零改动。
 *
 * **键名即 CEL 路径**：`object.type: [path]` 与 match 里的 `object.type == 'path'`
 * 是同一件事的两种写法 —— 读者不用在两套词汇之间做翻译，需要的维度不在白名单里时，
 * 心智步骤也只是「那条路径不是字段，写进 match」。
 *
 * 语义：
 *   - 列表内 OR，字段之间 AND，再与 `match` AND；省略 = 不约束
 *   - `'*'` = 任意（与省略等价；`subject.kind` 因必填，`'*'` 是它表达「任意主体」的写法）
 *   - 空列表非法（「命中零个」一定是笔误，见 policyFile）
 *
 * 求值上这些条件编译成**原生谓词**（不拼 CEL 源码），与 match 谓词 AND —— JS 短路
 * 因此保证：条件不命中时 CEL 不跑、该策略的 lets 也不会被触发求值（见 assemble.ts）。
 */
import type { ConditionKey, MatchContext, PolicyConditions } from './types'

/** 允许作为字段的条件键（键即 CEL 路径）；其余维度一律写进 match */
export const CONDITION_KEYS: readonly ConditionKey[] = [
  'subject.kind',
  'action',
  'object.type',
  'env.host',
  'tool.name'
]

/** 通配值 —— 等价于「不约束」 */
export const CONDITION_ANY = '*'

/** 条件键 → 从求值文档取值（读法与 match 里同名表达式一致） */
const READERS: Record<ConditionKey, (ctx: MatchContext) => string> = {
  'subject.kind': (ctx) => ctx.subject.kind,
  action: (ctx) => ctx.action,
  'object.type': (ctx) => String(ctx.object.type ?? ''),
  'env.host': (ctx) => ctx.env.host,
  'tool.name': (ctx) => ctx.tool.name
}

/** 单个条件是否满足（含 `'*'` 通配） */
function satisfies(list: string[], value: string): boolean {
  return list.includes(CONDITION_ANY) || list.includes(value)
}

/**
 * 两个条件列表求交（`'*'` 视为全集）。返回 `null` = 空交集 ——
 * 策略级 scope 与规则级字段矛盾时，该规则永远不可能命中，属死代码，
 * 由 policyFile 判整份文件非法（静默的死规则 = 保护静默失效）。
 */
export function intersectCondition(a: string[], b: string[]): string[] | null {
  if (a.includes(CONDITION_ANY)) return b
  if (b.includes(CONDITION_ANY)) return a
  const both = a.filter((v) => b.includes(v))
  return both.length > 0 ? both : null
}

/** 深拷贝（键 + 列表）—— 见 mergeConditions 的别名隔离说明 */
function cloneConditions(conditions: PolicyConditions): PolicyConditions {
  const out: PolicyConditions = {}
  for (const key of CONDITION_KEYS) {
    const list = conditions[key]
    if (list) out[key] = [...list]
  }
  return out
}

/**
 * scope ⊕ 规则字段 → 有效条件（同键取交、异键取并）。
 * 返回 `null` = 某个键的交集为空（矛盾 → 该规则是死代码）。
 *
 * 恒返回**新对象与新列表**：装配产物会挂到 SecurityRule.conditions 上流向 IPC/UI/
 * 未来的维度索引，而入参可能是 buildBuiltinPolicies 的**模块级缓存**产物 ——
 * 共享引用会让任何下游的就地修改跨会话污染内置策略。
 */
export function mergeConditions(
  scope: PolicyConditions | undefined,
  rule: PolicyConditions | undefined
): PolicyConditions | null {
  if (!scope) return rule ? cloneConditions(rule) : {}
  if (!rule) return cloneConditions(scope)
  const merged: PolicyConditions = cloneConditions(scope)
  for (const key of CONDITION_KEYS) {
    const ruleList = rule[key]
    if (!ruleList) continue
    const scopeList = scope[key]
    if (!scopeList) {
      merged[key] = [...ruleList]
      continue
    }
    const both = intersectCondition(scopeList, ruleList)
    if (!both) return null
    merged[key] = [...both]
  }
  return merged
}

/** 有效条件 → 原生谓词；无任何条件时返回 undefined（恒命中，由调用方处置） */
export function compileConditions(
  conditions: PolicyConditions
): ((ctx: MatchContext) => boolean) | undefined {
  const checks = CONDITION_KEYS.filter((key) => conditions[key]).map((key) => {
    const list = conditions[key]!
    const read = READERS[key]
    return (ctx: MatchContext): boolean => satisfies(list, read(ctx))
  })
  if (checks.length === 0) return undefined
  return (ctx) => checks.every((check) => check(ctx))
}
