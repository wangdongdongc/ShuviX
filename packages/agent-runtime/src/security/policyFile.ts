/**
 * 安全策略定义文件（<name>.md）解析 —— 与 agent 定义文件（agentProfile/definitionFile.ts）
 * 平行的独立格式（frontmatter 键集完全不同，刻意不塞进 ParsedAgentFile）。
 *
 * 格式：YAML frontmatter + 正文。
 *   - 首行 `shuvix: policy v1` 是**文件类型标记**（与 `shuvix: agent v1` / `shuvix:chart v1`
 *     同形词汇表）：写入时恒输出，读取时可选；
 *   - `name` / `description`：策略标识与一句话摘要（列表/检视 UI 用）；
 *   - `shuvix-displayName`：显示名（对齐 agent md；缺省 = name；人读面，宽容解析）；
 *   - `shuvix-builtin: true`：随包发布的内置策略的**自述标记**，本解析器不读它
 *     （builtin/user 的判定在加载方：buildBuiltinPolicies vs policyService 的目录扫描）；
 *   - `shuvix-policy-lets`：策略级 let 绑定（可选）—— 名字 → CEL 值表达式（上下文
 *     {vars}），装配时求值一次、以顶层名字注入本策略所有规则的 match 上下文。
 *     多条规则共享一份路径清单等去重场景用它（取代 YAML 锚点与旧 {{var}} 展开）。
 *     名字必须是合法标识符且不得与内置命名空间（subject/action/tool/object/env/vars）
 *     冲突；表达式语法错 → 整份文件非法；
 *   - `shuvix-policy-scope`：策略级共同条件（可选）—— 与规则级同一套条件键，
 *     **AND 进本策略每条规则**（不是独立的前置门：策略头部可见地参与每条规则的条件，
 *     没有隐藏的过滤）。多条规则共享同一批条件时用它去重；单规则策略直接写在规则上。
 *   - `shuvix-policy-rules`：规则数组 —— **引擎评估的唯一输入**。每条规则的键：
 *       effect: allow | consent | ask | deny （必填）—— consent 效果同 allow，但结算落在
 *                                             consent 层，压得过询问门（"用户明示同意"）；
 *                                             出厂用它表达免询问开关与「允许并记住」，
 *                                             用户策略同样可写（叠加式局部放宽某道门）。
 *       结构化条件（可选，扁平键，键即 CEL 路径）：
 *         subject.kind / action / object.type / env.host / tool.name
 *         值为字符串或字符串列表（列表内 OR），`'*'` = 任意；语义见 conditions.ts
 *       prompt: "<一句话>"                  （可选；命中时给人看的提示语 —— 不参与匹配，
 *                                             deny 拼进工具错误、ask 上询问卡片、
 *                                             allow/consent 只在策略页显示，见 types.ts。
 *                                             **唯一不会让文件非法的键**：空值按没写处理，
 *                                             类型错/超长记警告后降级）
 *       match: "<CEL 表达式>"                （可选；省略 = 结构化条件即全部条件。
 *                                             对整份请求文档求值，上下文/注入函数/
 *                                             strict 语义见 celMatch.ts；
 *                                             语法错 → 整份文件非法）
 *     `subject.kind` **必填**（scope 或规则满足其一）—— 它是唯一一个「忘写」会产生
 *     语义事故的维度：漏掉它，一条 deny 会连用户亲手在 UI 里的操作一起拦掉。必填让
 *     「想清楚了要作用于所有主体」（写 `'*'`）与「忘了」变成两件可区分的事。
 *     键带 `shuvix-policy-` 前缀与 agent md 的 `shuvix-tools` 同理 —— 裸词
 *     rules/lets/scope 会被其他读该 md 的应用误解；类型标记 + 前缀键让文件语义自明。
 *   - 正文 = 纯人读说明（rationale/示例/边界），引擎不评估 —— 评估必须是确定性的，
 *     不能依赖对散文的理解。
 *
 * 解析哲学与 agent 文件一致：结构非法（effect 未知、rules 非数组、未知规则键、
 * 条件值非法、缺 `subject.kind`、scope 与规则条件矛盾、match/lets 语法错…）
 * **整份文件判非法返回 null**，宁可整体拒绝也不静默降级 —— 半生效的安全策略比
 * 不生效更危险。frontmatter 出现**裸 `rules`/`lets`/`scope` 键**亦整份非法
 * （写了旧键名的文件被静默判"无规则"会让用户误信策略生效）。
 * 非法原因经 `warn` 输出（新增的必填/矛盾校验若只返回 null 会很难排查）。
 * 调用方对用户文件记警告跳过；内置文件解析失败属开发期错误（守护测试钉死）。
 *
 * i18n 取舍：内置策略按语言一文件（见 builtinPolicies/index.ts），但 frontmatter
 * 规则是安全语义的唯一事实源、恒取 en —— 本地化文件只贡献人读面，守护测试断言
 * 各语言 rules/lets 与 en 一致（翻译漂移在 CI 就红，不静默改变安全语义）。
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { splitFrontmatter } from '../markdownFrontmatter'
import { compileMatch } from './celMatch'
import { CONDITION_KEYS, mergeConditions } from './conditions'
import type { ParsedPolicyFile, PolicyConditions, PolicyEffect, PolicyRuleSpec } from './types'

/** 文件类型标记 —— 序列化时恒写在首位；解析时不作要求 */
export const POLICY_FILE_MARKER_KEY = 'shuvix'
export const POLICY_FILE_MARKER = 'policy v1'

/** frontmatter 键（shuvix-policy- 前缀防其他应用误读裸词，同 agent md 的 shuvix-tools） */
export const POLICY_RULES_KEY = 'shuvix-policy-rules'
export const POLICY_LETS_KEY = 'shuvix-policy-lets'
export const POLICY_SCOPE_KEY = 'shuvix-policy-scope'
const RULES_KEY = POLICY_RULES_KEY
const LETS_KEY = POLICY_LETS_KEY
const SCOPE_KEY = POLICY_SCOPE_KEY

const EFFECTS: readonly PolicyEffect[] = ['allow', 'consent', 'ask', 'deny']

/** 字符串或字符串数组 → 非空字符串数组；类型不符/空条目/空列表返回 null（undefined 输入透传） */
function stringList(value: unknown): string[] | null | undefined {
  if (value === undefined || value === null) return undefined
  const arr = typeof value === 'string' ? [value] : value
  if (!Array.isArray(arr)) return null
  const out: string[] = []
  for (const item of arr) {
    if (typeof item !== 'string' || !item.trim()) return null
    out.push(item.trim())
  }
  return out.length > 0 ? out : null
}

/**
 * lets 名字约束：合法标识符，且不遮蔽请求文档的内置命名空间与注册函数
 * （let 叫 inDir 会在求值上下文里遮蔽函数，破坏同策略规则里的 inDir(...) 调用）。
 */
const LET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_NAMES = new Set(['subject', 'action', 'tool', 'object', 'env', 'vars', 'inDir'])

/** 规则允许的键 = effect / match / prompt / 五个条件键（其余一律整份非法，防"以为收窄生效"） */
const RULE_KEYS = new Set<string>(['effect', 'match', 'prompt', ...CONDITION_KEYS])

/**
 * prompt 长度上限 —— 超出记警告后截断（不判非法，理由见 parseRule）。
 * 询问卡片不该变成一堵墙，长篇解释属于正文 body（策略页详情里完整可读）。
 */
export const POLICY_PROMPT_MAX = 1000

/**
 * 解析一组结构化条件（规则级或 scope）。返回 undefined = 一个条件都没写；
 * null = 非法（值类型错、空列表、空串条目）。`allowedKeys` 之外的键由调用方处置。
 */
function parseConditions(raw: Record<string, unknown>): PolicyConditions | null | undefined {
  const conditions: PolicyConditions = {}
  for (const key of CONDITION_KEYS) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    const list = stringList(value)
    // stringList：null = 类型错/空串条目/空列表 —— 「命中零个」一定是笔误
    if (!list) return null
    conditions[key] = list
  }
  return Object.keys(conditions).length > 0 ? conditions : undefined
}

function parseRule(value: unknown, warn?: (msg: string) => void): PolicyRuleSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) {
      warn?.(`unknown rule key '${key}' (allowed: ${[...RULE_KEYS].join(', ')})`)
      return null
    }
  }
  if (typeof raw.effect !== 'string' || !(EFFECTS as readonly string[]).includes(raw.effect)) {
    return null
  }

  const rule: PolicyRuleSpec = { effect: raw.effect as PolicyEffect }

  const conditions = parseConditions(raw)
  if (conditions === null) {
    warn?.('invalid condition value (expected a non-empty string or list of non-empty strings)')
    return null
  }
  if (conditions) rule.conditions = conditions

  if (raw.match !== undefined) {
    if (typeof raw.match !== 'string' || !raw.match.trim()) return null
    const match = raw.match.trim()
    if (compileMatch(match) !== null) return null
    rule.match = match
  }

  // prompt：纯人读面，不参与匹配、不影响判决 —— 因此它**没有资格让规则非法**。
  // 其余字段判非法是因为「半生效的安全策略比不生效更危险」，可这条推理对 prompt 不成立：
  // 反过来，让一句被清空的提示语弄死用户自己写的 deny 规则，才是真的丢掉一道防护
  //（设置页把文字删干净、留下 `prompt:` 一行，是最容易发生的一种"清空"）。
  // 所以空值/空串一律按"没写"处理，类型错与超长记警告后降级 —— 与条件键的 null 语义一致。
  if (raw.prompt !== undefined && raw.prompt !== null) {
    if (typeof raw.prompt !== 'string') {
      warn?.('prompt must be a string; ignored')
    } else if (raw.prompt.trim()) {
      const prompt = raw.prompt.trim()
      if (prompt.length > POLICY_PROMPT_MAX) {
        warn?.(`prompt is too long (${prompt.length} > ${POLICY_PROMPT_MAX} characters); truncated`)
      }
      // 截断按 code unit 切，末位落在代理对上会劈出半个字符 —— 落单的高位代理直接丢掉
      const cut = prompt.slice(0, POLICY_PROMPT_MAX)
      rule.prompt = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
    }
  }

  return rule
}

function parseLets(value: unknown): Record<string, string> | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, string> = {}
  for (const [name, expr] of Object.entries(value as Record<string, unknown>)) {
    if (!LET_NAME_RE.test(name) || RESERVED_NAMES.has(name)) return null
    if (typeof expr !== 'string' || !expr.trim()) return null
    const trimmed = expr.trim()
    if (compileMatch(trimmed) !== null) return null
    out[name] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 解析策略定义 markdown。格式非法返回 null，由调用方决定处置
 * （用户文件：警告跳过且**不遮蔽内置同名策略**；内置文件：开发期错误）。
 * `defaultName` 为文件 basename（frontmatter `name` 可覆盖）。
 * `warn`（可选）：诊断出口 —— ① 判非法时输出原因（必填/矛盾这类新校验只返回 null
 * 会很难排查）；② 软告警：规则未声明 `object.type` 却在 match 里引用客体属性
 * （合法但易误拦：跨 type 引用会按 strict fail-safe 多拦，见 celMatch.ts）。
 */
export function parsePolicyDefinitionFile(
  raw: string,
  defaultName: string,
  warn?: (msg: string) => void
): ParsedPolicyFile | null {
  // \u65E9\u671F\u5931\u8D25\u65F6 frontmatter \u8FD8\u6CA1\u89E3\u6790\u51FA name\uFF0C\u7528\u6587\u4EF6 basename \u62A5\uFF08\u539F\u56E0\u7167\u6837\u8981\u53EF\u89C1\uFF09
  const rejectAs = (who: string, why: string): null => {
    warn?.(`security policy '${who}': ${why}; the whole file is rejected`)
    return null
  }

  const split = splitFrontmatter(raw)
  if (!split) return rejectAs(defaultName, 'no YAML frontmatter block')

  let fields: Record<string, unknown>
  try {
    const parsed: unknown = parseYaml(split.yaml)
    if (parsed === null || parsed === undefined) {
      fields = {}
    } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      fields = parsed as Record<string, unknown>
    } else {
      return rejectAs(defaultName, 'frontmatter must be a mapping')
    }
  } catch (e) {
    return rejectAs(defaultName, `invalid YAML (${e instanceof Error ? e.message : e})`)
  }

  const name =
    typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : defaultName
  const reject = (why: string): null => rejectAs(name, why)

  // 裸 rules/lets/scope 键 → 整份非法（旧键名/裸词误用不得被静默判"无规则"）
  for (const bare of ['rules', 'lets', 'scope']) {
    if (bare in fields) return reject(`bare '${bare}' key (use 'shuvix-policy-${bare}')`)
  }

  // 策略级共同条件（AND 进每条规则）
  let scope: PolicyConditions | undefined
  const scopeRaw = fields[SCOPE_KEY]
  if (scopeRaw !== undefined && scopeRaw !== null) {
    if (typeof scopeRaw !== 'object' || Array.isArray(scopeRaw)) {
      return reject(`${SCOPE_KEY} must be a mapping of condition keys`)
    }
    const scopeFields = scopeRaw as Record<string, unknown>
    for (const key of Object.keys(scopeFields)) {
      if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
        return reject(`unknown ${SCOPE_KEY} key '${key}' (allowed: ${CONDITION_KEYS.join(', ')})`)
      }
    }
    const parsedScope = parseConditions(scopeFields)
    if (parsedScope === null) return reject(`invalid condition value in ${SCOPE_KEY}`)
    scope = parsedScope
  }

  const rulesRaw = fields[RULES_KEY]
  if (!Array.isArray(rulesRaw)) return reject(`${RULES_KEY} must be a list`)
  const rules: PolicyRuleSpec[] = []
  for (const [i, item] of rulesRaw.entries()) {
    const rule = parseRule(item, (why) => warn?.(`security policy '${name}' rule #${i}: ${why}`))
    if (!rule) return reject(`rule #${i} is invalid`)
    // scope ∩ 规则条件：空交集 = 该规则永远不可能命中（死代码），不得静默存在
    const effective = mergeConditions(scope, rule.conditions)
    if (!effective) {
      return reject(`rule #${i} contradicts ${SCOPE_KEY} (a condition intersects to nothing)`)
    }
    // subject.kind 必填：漏写会让 deny 连用户亲手的 UI 操作一起拦掉
    if (!effective['subject.kind']) {
      return reject(
        `rule #${i} has no 'subject.kind' (declare it on the rule or in ${SCOPE_KEY}; use '*' for any subject)`
      )
    }
    rules.push(rule)
  }

  const lets = parseLets(fields[LETS_KEY])
  if (lets === null) return reject(`invalid ${LETS_KEY}`)
  // 显示名（对齐 agent md 的 shuvix-displayName）：人读面，宽容处理 —— 非字符串/空即回退 name
  const displayNameRaw = fields['shuvix-displayName']
  const displayName =
    typeof displayNameRaw === 'string' && displayNameRaw.trim() ? displayNameRaw.trim() : name
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''

  // 软告警：未声明 object.type 却在 match 里引用客体属性 —— 跨 type 引用会 fail-safe 多拦
  if (warn) {
    rules.forEach((rule, i) => {
      const declaresType = rule.conditions?.['object.type'] ?? scope?.['object.type']
      if (!declaresType && rule.match?.includes('object.') && !rule.match.includes('has(')) {
        warn(
          `security policy '${name}' rule #${i}: match reads object attributes without an ` +
            `'object.type' condition — cross-type access will fail-safe (deny/ask over-matches)`
        )
      }
    })
  }

  const parsed: ParsedPolicyFile = {
    name,
    displayName,
    description,
    rules,
    body: split.body.trim()
  }
  if (scope) parsed.scope = scope
  if (lets) parsed.lets = lets
  return parsed
}

/**
 * 序列化为标准格式（未来设置页保存路径）。与 parsePolicyDefinitionFile 互逆：
 * 文件类型标记恒居首；空 description / 无 scope / 无 lets 省略；
 * 规则的结构化条件展平为扁平键（effect → 条件键 → match → prompt，与书写顺序一致）。
 */
export function serializePolicyDefinitionFile(data: ParsedPolicyFile): string {
  const fields: Record<string, unknown> = {
    [POLICY_FILE_MARKER_KEY]: POLICY_FILE_MARKER,
    name: data.name
  }
  if (data.displayName.trim() && data.displayName.trim() !== data.name) {
    fields['shuvix-displayName'] = data.displayName.trim()
  }
  if (data.description.trim()) fields.description = data.description.trim()
  if (data.scope && Object.keys(data.scope).length > 0) fields[SCOPE_KEY] = data.scope
  if (data.lets && Object.keys(data.lets).length > 0) fields[LETS_KEY] = data.lets
  fields[RULES_KEY] = data.rules.map((rule) => {
    const out: Record<string, unknown> = { effect: rule.effect }
    for (const key of CONDITION_KEYS) {
      const list = rule.conditions?.[key]
      if (list) out[key] = list
    }
    if (rule.match) out.match = rule.match
    if (rule.prompt) out.prompt = rule.prompt
    return out
  })

  const frontmatter = stringifyYaml(fields, { lineWidth: 0 }).trimEnd()
  const body = data.body.trim()
  return `---\n${frontmatter}\n---\n${body ? `\n${body}\n` : ''}`
}
