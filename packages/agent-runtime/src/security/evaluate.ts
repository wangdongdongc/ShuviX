/**
 * 统一评估函数（PDP 核心）—— 同步纯函数，无 IO、无副作用。
 *
 * 原则（个人桌面应用，用户主权优先）：**无策略 = 放行** —— 未命中任何规则的操作
 * 直接执行，所有策略都是叠加上去的防护限制（deny 硬保护 / ask 询问门）。
 * 出厂的防护（写入询问、命令询问、凭据保护…）全部以内置策略 md 表达，
 * 用户可覆盖或移除；引擎本身不内置任何不可见的门。
 *
 * 匹配语义只有一种：每条规则一个谓词（策略规则 = CEL match 表达式对请求文档求值，
 * session/derived 规则 = 原生谓词），引擎不含逐要素/逐客体种类的匹配代码。
 * 谓词抛错走 fail-safe：deny/ask 视为命中 + 告警（保护宁可多拦一次，绝不静默蒸发），
 * allow 视为不命中（不白送放行）—— strict 缺失属性语义（见 celMatch.ts）依赖这一兜底。
 *
 * 结算优先序（tier）—— md 里的 effect 名字自带强弱（`force-` 压过不带前缀的，
 * 同档按 deny > ask > allow，deny 恒在顶）：
 *   1. deny         任意来源 deny 命中 → deny（不可被任何层覆盖）
 *   2. force-ask    这道门不接受会话级同意 → ask（免询问开着也照问）
 *   3. force-allow  用户明示同意 → allow（策略 md 里的 `effect: force-allow`；出厂由
 *                   session-auto-allow / session-path-grants 表达「免询问」与「允许并记住」，
 *                   用户策略也可声明，用于叠加式地局部放宽某道询问门）
 *   4. ask          显式 ask 规则（内置/用户策略 md）→ ask
 *   5. static-allow 静态 allow 规则 → allow（当前主要供决策日志归因与用户自定义）
 *   6. default      未命中 → **allow**（无策略即放行）
 *
 * 为什么不是朴素的 deny→ask→allow：force-allow 必须压过静态 ask（否则「免询问」开关
 * 对内置 ask-on-command 策略失效），force-ask 又必须压过 force-allow（否则「始终询问」
 * 名不副实），而 deny 压过全部 —— 构成偏序，由 tier 显式表达而非靠规则排列顺序。
 * ask 压过 static-allow：询问门不被宽泛 allow 静默穿透，放宽走 force-allow
 * （免询问/记住）或同名覆盖门策略本身。
 */
import { buildAllowEntry } from './allowEntries'
import type {
  AttrValue,
  MatchContext,
  PolicyVarValue,
  SecurityDecision,
  SecurityRequest,
  SecurityRule
} from './types'

const TIER_ORDER = ['deny', 'force-ask', 'force-allow', 'ask', 'static-allow'] as const

const TIER_EFFECT: Record<(typeof TIER_ORDER)[number], SecurityDecision['effect']> = {
  deny: 'deny',
  'force-ask': 'ask',
  'force-allow': 'allow',
  ask: 'ask',
  'static-allow': 'allow'
}

export interface EvaluateOpts {
  /**
   * 是否纳入 force-allow 层（被动 UI 判定传 false：per-path 授权不放宽 UI 范围）。
   *
   * 注意这是按 **tier** 过滤，不按来源 —— 用户 md 里写死的 `effect: force-allow` 策略
   * 同样被丢弃，而不只是会话运行时授权。对"工具级 per-path 授权"这个原始理由是贴切的，
   * 对"我在策略里声明信任 /data"就略严：用户会觉得策略对智能体生效、对预览面板不生效。
   * 方向偏安全（UI 更严）所以保持现状；真要区分，应按 source.kind 而非 tier 过滤。
   */
  includeForceAllow?: boolean
  /** 宿主变量表（match 上下文的 vars；省略 = 空表） */
  vars?: Record<string, PolicyVarValue>
  /** 告警出口（谓词求值失败的 fail-safe 处置需要可见） */
  warn?: (msg: string) => void
}

/**
 * SecurityRequest → match 求值文档。subject/tool/env 固定命名空间补空串缺省
 * （恒可访问 —— `tool.name == 'ssh'` 对被动 UI 求 false 而非报错）；
 * object 原样透传（undefined 属性剔除 —— CEL 上下文里"值为 undefined 的键"
 * 与"缺键"应当同义，统一走 strict 报错）。
 */
export function buildMatchContext(
  request: SecurityRequest,
  vars: Record<string, PolicyVarValue>
): MatchContext {
  // 搬运**属性描述符**而不是取值：命令客体的结构属性是惰性 getter（见 context.ts 的
  // buildCommandObject）。Object.entries 会当场读取，把「没有策略引用它就不解析」毁掉；
  // 而它们又是非枚举的（不让决策日志的序列化拖进整棵树），entries 干脆看不到。
  const object: Record<string, AttrValue> = {}
  for (const key of Object.getOwnPropertyNames(request.object)) {
    const desc = Object.getOwnPropertyDescriptor(request.object, key)
    if (!desc) continue
    if (desc.get) {
      Object.defineProperty(object, key, desc)
      continue
    }
    if (desc.value !== undefined) object[key] = desc.value as AttrValue
  }
  return {
    subject: {
      kind: request.subject.kind,
      agentKind: request.subject.agentKind ?? '',
      profile: request.subject.profileName ?? '',
      sessionId: request.subject.sessionId,
      depth: request.subject.depth ?? 0
    },
    action: request.action,
    tool: { name: request.tool?.name ?? '', operation: request.tool?.operation ?? '' },
    object,
    env: { host: request.environment.host, platform: request.environment.platform ?? '' },
    vars
  }
}

/**
 * ask 决策的询问材料 —— 按客体属性推导（匹配不看 type，材料/展示要看）：
 * path 给 allowList 条目（force-ask 胜出时不给，见下）；其余类型按「主展示属性」回退链
 * （command → sql → 工具名 → type）取原文，无记忆条目（allowList 只有 Read/Write 形态）。
 */
function buildAskMaterials(
  request: SecurityRequest,
  tier: (typeof TIER_ORDER)[number]
): NonNullable<SecurityDecision['ask']> {
  const object = request.object
  if (object.type === 'path' && typeof object.path === 'string') {
    const mode = request.action === 'write' ? 'write' : 'read'
    const entry = buildAllowEntry(mode, object.path)
    // force-ask 胜出时不给「允许并记住」：那条授权落在 force-allow 层、压不过这道门，
    // 给出按钮等于给一个点了不生效的假承诺
    return tier === 'force-ask' ? { command: entry } : { command: entry, rememberEntry: entry }
  }
  if (typeof object.command === 'string') return { command: object.command }
  if (typeof object.sql === 'string') return { command: object.sql }
  const tool = request.tool
  if (tool) return { command: tool.operation ? `${tool.name}: ${tool.operation}` : tool.name }
  return { command: object.type }
}

/**
 * 胜出 tier 的提示语汇总 —— 取**该 tier 内全部命中规则**的 prompt，去重后按装配序拼接。
 *
 * 刻意不是「只取 winning」：装配序是内置在前、用户在后（mergePolicyFiles），而 winning
 * 取 tier 内第一条 —— 只认 winner 的话，用户自己写的 ask 规则永远排在内置 ask-on-write
 * 之后，他写的提示语一次也不会出现。非胜出 tier 不收：deny 赢了，ask 规则那句话就无关了。
 */
function collectPrompt(rules: SecurityRule[]): SecurityDecision['prompt'] {
  const texts: string[] = []
  const ruleIds: string[] = []
  const policies: string[] = []
  for (const rule of rules) {
    const text = rule.prompt?.trim()
    if (!text) continue
    ruleIds.push(rule.id)
    const policy = rule.source.policyDisplayName || rule.source.policy
    if (policy && !policies.includes(policy)) policies.push(policy)
    if (!texts.includes(text)) texts.push(text)
  }
  return texts.length > 0 ? { text: texts.join('\n\n'), rules: ruleIds, policies } : undefined
}

/** 统一评估：输入装配好的规则集与请求五要素，输出三态决策（含命中回链与询问材料） */
export function evaluate(
  rules: SecurityRule[],
  request: SecurityRequest,
  opts: EvaluateOpts = {}
): SecurityDecision {
  const includeForceAllow = opts.includeForceAllow !== false
  const ctx = buildMatchContext(request, opts.vars ?? {})

  const matchedByTier = new Map<(typeof TIER_ORDER)[number], SecurityRule[]>()
  for (const rule of rules) {
    if (!includeForceAllow && rule.tier === 'force-allow') continue

    let matched: boolean
    if (!rule.matches) {
      matched = true
    } else {
      try {
        matched = rule.matches(ctx)
      } catch (e) {
        // fail-safe：deny/ask 视为命中（保护绝不静默蒸发），allow 视为不命中（不白送放行）
        matched = rule.effect !== 'allow'
        opts.warn?.(
          `security rule '${rule.id}': match evaluation failed (${e instanceof Error ? e.message : e}), ` +
            (matched ? 'treating as matched (fail-safe)' : 'treating as not matched')
        )
      }
    }
    if (!matched) continue

    const bucket = matchedByTier.get(rule.tier)
    if (bucket) bucket.push(rule)
    else matchedByTier.set(rule.tier, [rule])
  }

  const matched = TIER_ORDER.flatMap((tier) => matchedByTier.get(tier) ?? []).map((r) => r.id)

  for (const tier of TIER_ORDER) {
    const bucket = matchedByTier.get(tier)
    if (!bucket?.length) continue
    const winner = bucket[0]
    const effect = TIER_EFFECT[tier]
    return {
      effect,
      matched,
      winning: winner.id,
      reason: effect === 'deny' ? `Denied by security policy rule '${winner.id}'` : undefined,
      // 放行不带话（allow / force-allow 上的 prompt 只在策略页显示，见 types.ts PolicyRuleSpec）
      prompt: effect === 'allow' ? undefined : collectPrompt(bucket),
      ask: effect === 'ask' ? buildAskMaterials(request, tier) : undefined
    }
  }

  // 未命中任何规则：放行（无策略 = 自由；防护全部以显式策略表达）
  return {
    effect: 'allow',
    matched,
    winning: `default:${request.object.type}`
  }
}
