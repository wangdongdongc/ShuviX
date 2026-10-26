/**
 * 统一评估函数（PDP 核心）—— 同步函数，无副作用；唯一的 IO 是门面递进来的真实路径解析
 * （opts.realPath，供 inDir 按位置比较），不给就是纯函数。
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
 *   2. force-ask    这道门不接受会话级同意 → ask（「允许并记住」过也照问）
 *   3. force-allow  用户明示同意 → allow（策略 md 里的 `effect: force-allow`；出厂已不用，
 *                   「允许并记住」写在 ask-on-external-path 的 match 里，
 *                   用户策略也可声明，用于叠加式地局部放宽某道询问门）
 *   4. ask          显式 ask 规则（内置/用户策略 md）→ ask
 *   5. static-allow 静态 allow 规则 → allow（当前主要供决策日志归因与用户自定义）
 *   6. default      未命中 → **allow**（无策略即放行）
 *
 * 为什么不是朴素的 deny→ask→allow：force-allow 必须压过静态 ask（否则一条用户写的
 * 放宽规则对询问门失效），force-ask 又必须压过 force-allow（否则「始终询问」
 * 名不副实），而 deny 压过全部 —— 构成偏序，由 tier 显式表达而非靠规则排列顺序。
 * ask 压过 static-allow：询问门不被宽泛 allow 静默穿透，放宽走 force-allow
 * （「允许并记住」）或同名覆盖门策略本身。
 */
import { buildAllowEntry } from './allowEntries'
import { withRealPaths } from './celMatch'
import type {
  AttrValue,
  Disposition,
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
  /**
   * 真实路径解析（门面按次给出、带本次的记忆表）—— 规则求值期间交给 inDir，让它按位置比较
   * （见 celMatch.withRealPaths）。省略 = 按写法比较。唯一的 IO 入口：给了它，本函数就不再是
   * 纯函数，而是「给定文件系统状态下确定」的函数。
   */
  realPath?: (path: string) => string
}

/**
 * 把 source 的自有属性搬进 target：搬运**属性描述符**而不是取值 —— 命令客体的结构属性、网络主体的
 * cookie / 网卡名都是惰性 getter（见 context.ts 的 buildCommandObject）。Object.entries 会当场读取，把
 * 「没有策略引用它就不计算」毁掉；而它们又是非枚举的（不让决策日志的序列化拖进整棵树），entries 干脆
 * 看不到。值为 undefined 的键剔除（与缺键同义，统一走 strict 报错）；`skip` 里的键不搬（固定字段）。
 */
function copyAttributes(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  skip?: ReadonlySet<string>
): void {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (skip?.has(key)) continue
    const desc = Object.getOwnPropertyDescriptor(source, key)
    if (!desc) continue
    if (desc.get) {
      Object.defineProperty(target, key, { ...desc, configurable: true })
      continue
    }
    if (desc.value !== undefined) target[key] = desc.value
  }
}

/** 主体的固定字段：开放属性不能覆盖它们（`subject.kind` 是结构化条件键，覆盖了就是换了主体） */
const FIXED_SUBJECT_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'agentKind',
  'profile',
  'sessionId',
  'depth'
])

/**
 * SecurityRequest → match 求值文档。subject 的固定字段与 tool/env 固定命名空间补空串缺省
 * （恒可访问 —— `tool.name == 'ssh'` 对被动 UI 求 false 而非报错）；
 * object 与 subject 的开放属性原样透传（undefined 属性剔除 —— CEL 上下文里"值为 undefined 的键"
 * 与"缺键"应当同义，统一走 strict 报错）。
 */
export function buildMatchContext(
  request: SecurityRequest,
  vars: Record<string, PolicyVarValue>
): MatchContext {
  const object: Record<string, AttrValue> = {}
  copyAttributes(object, request.object)
  const subject: MatchContext['subject'] = {
    kind: request.subject.kind,
    agentKind: request.subject.agentKind ?? '',
    profile: request.subject.profileName ?? '',
    sessionId: request.subject.sessionId,
    depth: request.subject.depth ?? 0
  }
  if (request.subject.attrs) copyAttributes(subject, request.subject.attrs, FIXED_SUBJECT_KEYS)
  return {
    subject,
    action: request.action,
    tool: {
      name: request.tool?.name ?? '',
      operation: request.tool?.operation ?? '',
      restored: request.tool?.restored ?? []
    },
    object,
    env: { host: request.environment.host, platform: request.environment.platform ?? '' },
    vars
  }
}

/**
 * ask 决策的询问材料 —— 按客体属性推导（匹配不看 type，材料/展示要看）：
 * path 给 `Read(...)` / `Write(...)` 形态的条目、session 给 `Session(read|write, <id>)`（卡片上的展示文本，也是
 * 「允许并记住」的依据 —— 记下的是会话权限表的一行；force-ask 胜出时不给，见下）；其余类型按「主展示属性」回退链
 * （command → sql → 工具名 → type）取原文，没有记忆条目（会话权限表只有路径与会话）。
 */
function buildAskMaterials(
  request: SecurityRequest,
  tier: (typeof TIER_ORDER)[number]
): NonNullable<SecurityDecision['ask']> {
  const object = request.object
  if (object.type === 'path' && typeof object.path === 'string') {
    const mode = request.action === 'write' ? 'write' : 'read'
    // 条目与卡片上的主路径都是**真实去处**：策略判的是它，「允许并记住」记下的也是它 ——
    // 记成请求时的写法，同一个文件换个链接名就得再授权一次，而一条经链接记下的授权
    // 会替用户同意一个他没见过的位置
    const entry = buildAllowEntry(mode, object.path)
    const requested =
      typeof object.requestedPath === 'string' && object.requestedPath !== object.path
        ? { requestedPath: object.requestedPath }
        : {}
    // force-ask 胜出时不给「允许并记住」：force-ask 的含义就是「这道门不接受会话级同意」——
    // 记下的授权只会被不问它的规则尊重，压不过这道门，给出按钮等于给一个点了不生效的假承诺
    return tier === 'force-ask'
      ? { command: entry, ...requested }
      : { command: entry, rememberEntry: entry, ...requested }
  }
  // 会话：条目 `Session(read|write, <id>)` 是卡片的主文本、决策日志与审查员看到的目标，也是「允许并记住」的依据 ——
  // 记下的是会话权限表里 `kind: 'session'` 的一行。卡片按 `session` 渲染（标题、查看 / 对话）。force-ask 不给记住，同路径
  if (object.type === 'session' && typeof object.sessionId === 'string') {
    const access = request.action === 'write' ? 'write' : 'read'
    const entry = `Session(${access}, ${object.sessionId})`
    const session = {
      sessionId: object.sessionId,
      title: typeof object.title === 'string' ? object.title : '',
      access,
      operation: request.tool?.operation ?? ''
    } as const
    return tier === 'force-ask'
      ? { command: entry, session }
      : { command: entry, rememberEntry: entry, session }
  }
  // 远端命令把目标机器写进卡片：用户批准一条 `rm -rf` 时，必须看得见它要跑在哪台机器上
  if (typeof object.command === 'string') {
    return {
      command:
        typeof object.host === 'string' && object.host
          ? `ssh ${object.host}: ${object.command}`
          : object.command
    }
  }
  // SQL 同理：批准一条 `DELETE` 时必须看得见它落在哪个已保存的连接上（生产库还是测试库）——
  // 用一行 SQL 注释写在语句前面，卡片上仍是一段合法的 SQL
  if (typeof object.sql === 'string') {
    return {
      command:
        typeof object.credential === 'string' && object.credential
          ? `-- ${object.credential}\n${object.sql}`
          : object.sql
    }
  }
  if (typeof object.url === 'string') return { command: object.url }
  const tool = request.tool
  if (tool) return { command: tool.operation ? `${tool.name}: ${tool.operation}` : tool.name }
  return { command: object.type }
}

/**
 * 胜出 tier 的提示语汇总 —— 取**该 tier 内全部命中规则**的 prompt，去重后按装配序拼接。
 *
 * 刻意不是「只取 winning」：装配序是内置在前、用户在后（mergePolicyFiles），而 winning
 * 取 tier 内第一条 —— 只认 winner 的话，用户自己写的 ask 规则永远排在内置
 * ask-on-external-path 之后，他写的提示语一次也不会出现。非胜出 tier 不收：deny 赢了，ask 规则那句话就无关了。
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

/**
 * 胜出 tier 的处置汇总 —— 取**该 tier 内全部命中规则**的处置，按装配序去重。不只取 winning 的理由同
 * collectPrompt：内置在前、用户在后，只认 winner 的话用户写的处置永远不生效。想去掉一个处置要升一档
 * （不带处置的 force-allow 压过 allow + redact），或者覆盖那份策略。
 */
function collectDispositions(rules: SecurityRule[]): Disposition[] | undefined {
  const out: Disposition[] = []
  for (const rule of rules) {
    for (const disposition of rule.dispositions ?? []) {
      if (!out.includes(disposition)) out.push(disposition)
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * 只交给点名了它的规则判的对象类型 → 它的动作（自动脱敏的出口，docs/auto-redaction-design.md §13.3）。每个发给模型的请求、
 * 请求里的每一处敏感内容都判一次，那里没有人可问；一条既没写 `object.type` 也没写 `action` 的 ask / deny（「这个 bot
 * 什么都要问我」）本意是管工具，让它碰到模型请求，那个 bot 就一个请求也发不出去了。所以这两种对象只认 `object.type`
 * 列出了它、或 `action` 列出了它的动作的规则；别的规则再宽也碰不到它们，没有规则点名 = 放行（「无策略 = 放行」）。
 */
export const OPT_IN_OBJECT_TYPES: Readonly<Record<string, string>> = {
  modelRequest: 'send',
  sensitive: 'disclose'
}

/** 规则（含策略级 scope）有没有明确点名这种对象：`'*'` 不算点名 */
function namesObject(rule: SecurityRule, type: string, action: string): boolean {
  return (
    rule.conditions?.['object.type']?.includes(type) === true ||
    rule.conditions?.action?.includes(action) === true
  )
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
  const optInAction = Object.hasOwn(OPT_IN_OBJECT_TYPES, request.object.type)
    ? OPT_IN_OBJECT_TYPES[request.object.type]
    : undefined
  for (const rule of rules) {
    if (!includeForceAllow && rule.tier === 'force-allow') continue
    if (optInAction !== undefined && !namesObject(rule, request.object.type, optInAction)) continue

    let matched: boolean
    const matches = rule.matches
    if (!matches) {
      matched = true
    } else {
      try {
        // inDir 按位置比较：解析器只在谓词求值期间生效（其间惰性求值的 lets 也在内）
        matched = withRealPaths(opts.realPath, () => matches(ctx))
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
    const dispositions = effect === 'allow' ? collectDispositions(bucket) : undefined
    return {
      effect,
      tier,
      matched,
      winning: winner.id,
      reason: effect === 'deny' ? `Denied by security policy rule '${winner.id}'` : undefined,
      // 放行不带话（allow / force-allow 上的 prompt 只在策略页显示，见 types.ts PolicyRuleSpec）
      prompt: effect === 'allow' ? undefined : collectPrompt(bucket),
      ...(dispositions ? { dispositions } : {}),
      ask: effect === 'ask' ? buildAskMaterials(request, tier) : undefined
    }
  }

  // 未命中任何规则：放行（无策略 = 自由；防护全部以显式策略表达）
  return {
    effect: 'allow',
    tier: 'default',
    matched,
    winning: `default:${request.object.type}`
  }
}
