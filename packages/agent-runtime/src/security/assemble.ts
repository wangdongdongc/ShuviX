/**
 * 规则装配 —— 把三层来源汇成一份扁平规则集（评估的直接输入）。
 *
 *   builtin md（模块级缓存的解析产物）
 *     ⊕ 用户 md（provider.getUserPolicies 现扫；同名覆盖内置）
 *     ⊕ 宿主派生（provider.derivedRules；仅限无法 md 化的特例）
 *
 * 会话授权曾是独立的第四层（allowList / autoAllow 在这里编译成 force-allow 原生谓词），
 * 现已下沉为策略 md：条目经 buildPolicyVars 变成 vars.autoAllow / vars.grantedRead /
 * vars.grantedWrite，逻辑由内置 session-auto-allow 与 session-path-grants 两份策略用
 * `effect: force-allow` 表达 —— 于是它们也可覆盖、可移除、在策略页可见。
 *
 * tier 由 md 声明的 effect 唯一决定（TIER_BY_EFFECT）；强度编进 effect 名字（force- 前缀）
 * 而非拆一根正交轴，理由见 types.ts PolicyEffect。结算优先序见 evaluate.ts。
 *
 * 策略规则的谓词 = **结构化条件（原生谓词）AND CEL match 表达式**（celMatch，按
 * (sep, 表达式) 缓存编译产物）。有效条件 = 策略级 scope ∩ 规则级字段（矛盾在解析期
 * 已判非法，见 policyFile）。JS 短路因此保证：条件不命中的规则既不跑 CEL，也不会
 * 触发本策略 lets 的求值。
 *
 * 策略级 lets **惰性求值**：首次真正有规则走到 CEL 时才算，按本次装配 memoize
 * （上下文 {vars}，每次装配现算 —— vars 可变）。急切求值会让一次 bash 命令评估也
 * 把凭据目录清单之类的 map 宏跑一遍。let 求值失败：记警告后该名字缺失 —— 引用它的
 * 规则求值报错，由 evaluate 按规则 effect fail-safe 处置（deny/ask 多拦、allow 不放）。
 *
 * 运行时数据（用户路径等）**绝不拼进 CEL 源码**（转义/注入隐患）—— 一律经 vars 以
 * 数据绑定进入求值上下文，md 里的表达式始终是固定文本。
 */
import { buildBuiltinPolicies } from './builtinPolicies'
import { evaluateLet, evaluateMatch } from './celMatch'
import { compileConditions, mergeConditions } from './conditions'
import { buildPolicyVars } from './policyVars'
import type {
  MatchContext,
  ParsedPolicyFile,
  PolicyEffect,
  PolicyVarValue,
  RuleTier,
  SecurityHostProvider,
  SecurityRule
} from './types'

/**
 * md 声明的 effect → 内部 {tier, effect}。这张表就是强度不需要独立字段的全部理由：
 * tier 是 effect 的函数，反过来 TIER_EFFECT（evaluate.ts）是它的逆。
 * 表的书写顺序即强弱顺序（deny 最强，allow 最弱）。
 */
const TIER_BY_EFFECT: Record<PolicyEffect, RuleTier> = {
  deny: 'deny',
  'force-ask': 'force-ask',
  'force-allow': 'force-allow',
  ask: 'ask',
  allow: 'static-allow'
}

/** md effect → SecurityRule 的三态 effect（force- 档落回它的基础值） */
const NORMALIZED_EFFECT: Record<PolicyEffect, SecurityRule['effect']> = {
  deny: 'deny',
  'force-ask': 'ask',
  'force-allow': 'allow',
  ask: 'ask',
  allow: 'allow'
}

/** 合并策略文件：用户同名覆盖内置（provider 已过滤非法用户文件 —— 非法不遮蔽内置） */
export function mergePolicyFiles(
  builtins: ParsedPolicyFile[],
  users: ParsedPolicyFile[]
): Array<{ policy: ParsedPolicyFile; sourceKind: 'builtin' | 'user' }> {
  const userNames = new Set(users.map((p) => p.name))
  return [
    ...builtins
      .filter((p) => !userNames.has(p.name))
      .map((policy) => ({ policy, sourceKind: 'builtin' as const })),
    ...users.map((policy) => ({ policy, sourceKind: 'user' as const }))
  ]
}

/**
 * 装配当前会话此刻的完整规则集（每次评估现装配 —— 决策新鲜度优先，不缓存快照）。
 *
 * `vars` 由调用方传入，好让 match（evaluate 的 opts.vars）与 lets（这里）**用同一份**：
 * 两处各自 buildPolicyVars 不仅多跑一次 IO，还会在将来两边取值时机不同时给出不一致的
 * 授权视图。缺省参数只为直接调用 assembleRules 的测试留的方便。
 */
export function assembleRules(
  provider: SecurityHostProvider,
  vars: Record<string, PolicyVarValue> = buildPolicyVars(provider)
): SecurityRule[] {
  const warn = (msg: string): void => provider.logger?.warn(msg)
  const sep = provider.pathSep
  const rules: SecurityRule[] = []

  // 1. 策略 md（内置 + 用户覆盖/新增）；语言只影响人读面，规则恒取 en
  for (const { policy, sourceKind } of mergePolicyFiles(
    buildBuiltinPolicies(provider.getLanguage?.()),
    provider.getUserPolicies?.() ?? []
  )) {
    // 策略级 lets：惰性求值 + 按本次装配 memoize（条件不命中的请求永不触发）
    let letValues: Record<string, unknown> | undefined
    const getLets = (): Record<string, unknown> => {
      if (letValues) return letValues
      letValues = {}
      for (const [name, expr] of Object.entries(policy.lets ?? {})) {
        try {
          letValues[name] = evaluateLet(expr, vars, sep)
        } catch (e) {
          warn(
            `security policy '${policy.name}': let '${name}' evaluation failed ` +
              `(${e instanceof Error ? e.message : e}); rules referencing it will fail-safe`
          )
        }
      }
      return letValues
    }

    policy.rules.forEach((spec, i) => {
      const matchExpr = spec.match
      // 有效条件 = scope ∩ 规则字段。矛盾（空交集）在解析期已判整份非法，走到这里
      // 只可能是绕过解析器构造的产物 —— **丢弃该规则**而非当作无条件：
      // 无条件的 deny 会全域命中、无条件的 allow 会白送放行，方向与本模块 fail-safe 相反
      const conditions = mergeConditions(policy.scope, spec.conditions)
      if (!conditions) {
        warn(
          `security policy '${policy.name}' rule #${i}: conditions contradict the policy scope; ` +
            `rule dropped (it could never match)`
        )
        return
      }
      const condPred = compileConditions(conditions)
      const celPred = matchExpr
        ? (ctx: MatchContext): boolean => evaluateMatch(matchExpr, { ...ctx, ...getLets() }, sep)
        : undefined

      // 条件在前、CEL 在后：短路使不相关的请求既不跑 CEL 也不触发 lets
      let matches: ((ctx: MatchContext) => boolean) | undefined
      if (condPred && celPred) matches = (ctx) => condPred(ctx) && celPred(ctx)
      else matches = condPred ?? celPred

      rules.push({
        id: `${policy.name}#${i}`,
        // force-* 归一为对应基础三态：SecurityRule 保持三态 effect，fail-safe 判定不受影响
        effect: NORMALIZED_EFFECT[spec.effect],
        tier: TIER_BY_EFFECT[spec.effect],
        matchExpr,
        conditions: Object.keys(conditions).length > 0 ? conditions : undefined,
        matches,
        prompt: spec.prompt,
        source: {
          kind: sourceKind,
          policy: policy.name,
          // 询问卡片的署名取显示名（内置按界面语言本地化）；缺省解析回退为 name
          policyDisplayName: policy.displayName
        }
      })
    })
  }

  // 2. 宿主派生特例（会话授权已下沉为策略 md —— 见文件头）
  rules.push(...(provider.derivedRules?.() ?? []))

  return rules
}
