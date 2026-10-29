/**
 * 检测 —— 在一段文本里认出敏感内容：规则认出的（rules.ts）加上会话已知值的原文匹配（known.ts），
 * 再去掉 ID 里的片段与小数、JSON 数字里的「号码」，最后按「先开始、同起点取最长、同一段取规则表里
 * 靠前的」挑出互不重叠的若干处。流水线与取舍移植自 magpie（yetone/magpie v0.1.1548，MIT）的
 * mask / noIDs / noNumbers / apply；用户词表、用户规则、本地模型三路这里没有（用户只能使用检测结果）。
 *
 * 只认值，不替换：替换成什么（占位符）、哪些处保持占位符，由调用方按会话对照表与策略决定。
 */
import { isPersonalCategory, type SensitiveCategory } from './categories'
import { ALNUM, DIGITS } from './checks'
import { KnownValues } from './known'
import { placeholderSpans } from './placeholder'
import { DETECT_RULES, type DetectRule } from './rules'

/** 一处敏感内容 */
export interface Finding {
  start: number
  end: number
  value: string
  category: SensitiveCategory | string
  /** 认出它的规则；按已知值匹配到的为 'known' */
  rule: string
}

type By = 'rule' | 'known'
interface Span {
  start: number
  end: number
  category: string
  rule: string
  by: By
}

/** ASCII 字母转小写、长度不变（下标在两份文本里通用；toLowerCase 可能改变非 ASCII 字符的长度） */
function lowerASCII(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase())
}

/** s[a:b] 是这条规则要的值：两边没有不许贴着的字符，校验都过 */
function takes(
  rule: DetectRule,
  s: string,
  a: number,
  b: number,
  ok: ((v: string) => boolean) | undefined
): boolean {
  if (b <= a) return false
  if (
    rule.bound &&
    ((a > 0 && rule.bound.includes(s[a - 1])) || (b < s.length && rule.bound.includes(s[b])))
  ) {
    return false
  }
  if (ok && !ok(s.slice(a, b))) return false
  return !rule.at || rule.at(s, a, b)
}

// ─────────────────────────── ID 里的片段（magpie ids.go）───────────────────────────

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const hexOrHyphen = (c: string | undefined): boolean => c !== undefined && /[-0-9a-fA-F]/.test(c)

/** s[a:b] 所在（或本身就是）的 ID：一串十六进制和连字符，是 UUID 或 32 位以上不带连字符的十六进制 */
function idAround(s: string, a: number, b: number): [number, number] | null {
  let l = a
  let r = b
  while (l > 0 && hexOrHyphen(s[l - 1])) l--
  while (r < s.length && hexOrHyphen(s[r])) r++
  while (l < r && s[l] === '-') l++
  while (r > l && s[r - 1] === '-') r--
  if (a < l || b > r) return null
  const v = s.slice(l, r)
  if (!/^[-0-9a-fA-F]+$/.test(v)) return null
  if (!(UUID_RE.test(v) || (v.length >= 32 && !v.includes('-')))) return null
  return [l, r]
}

const isHexDigit = (c: string | undefined): boolean => c !== undefined && /[0-9a-fA-F]/.test(c)

/**
 * s[a:b] 是一个短十六进制 token 里的一段（不是整个 token）：token 是 12 位以上、不带连字符的十六进制，至少有一个
 * a–f 字母，前后不紧贴别的字母数字 —— docker 的短 ID（`docker ps`、`docker images`）、12 位缩写的 git 提交、
 * AWS 的 `i-0…`。随机的 12 位十六进制里约万分之三含一段像手机号的 11 位数字。带 `0x` 前缀的（内存地址、十六进制
 * 字面量）前缀本身就说明是十六进制：多长、有没有字母都不论，紧跟在前缀后的整串也算一段。
 */
function inShortHexToken(s: string, a: number, b: number): boolean {
  let l = a
  let r = b
  while (l > 0 && isHexDigit(s[l - 1])) l--
  while (r < s.length && isHexDigit(s[r])) r++
  const v = s.slice(l, r)
  if (!/^[0-9a-fA-F]+$/.test(v) || (r < s.length && ALNUM.includes(s[r]))) return false
  if (l >= 2 && (s[l - 1] === 'x' || s[l - 1] === 'X') && s[l - 2] === '0') {
    return !(l > 2 && ALNUM.includes(s[l - 3]))
  }
  return (
    (l < a || b < r) && v.length >= 12 && /[a-fA-F]/.test(v) && !(l > 0 && ALNUM.includes(s[l - 1]))
  )
}

/** 字段名的词（小写）：next_page_token、nextPageToken、X-Next-Page-Token 都是 next page token */
function nameWords(name: string): string[] {
  const out: string[] = []
  let w = ''
  const flush = (): void => {
    if (w) out.push(w)
    w = ''
  }
  for (let i = 0; i < name.length; i++) {
    const c = name[i]
    if (c === '_' || c === '-' || c === '.') {
      flush()
    } else if (c >= 'A' && c <= 'Z') {
      if (i > 0 && name[i - 1] >= 'a' && name[i - 1] <= 'z') flush()
      w += c.toLowerCase()
    } else {
      w += c
    }
  }
  flush()
  return out
}

const NOT_CREDENTIAL_WORDS = new Set(
  (
    'page next cursor continuation csrf xsrf trace request idempotency sync nonce hash digest checksum ' +
    'sha fingerprint etag'
  ).split(' ')
)

/** 值从 s[at] 开始的那个字段是为凭据起的名字：refresh_token、DB_PASSWORD、x-api-key；不是 ID、游标、请求，也不是光秃秃的 key */
function credentialField(s: string, at: number): boolean {
  const skip = ' \t"\'\\'
  let i = at
  while (i > 0 && skip.includes(s[i - 1])) i--
  if (i === 0 || (s[i - 1] !== ':' && s[i - 1] !== '=')) return false
  i--
  while (i > 0 && skip.includes(s[i - 1])) i--
  let j = i
  while (j > 0 && (ALNUM + '_.-').includes(s[j - 1])) j--
  const words = nameWords(s.slice(j, i))
  if (words.length < 2 && (words.length === 0 || words[0] === 'key')) return false
  if (['id', 'ids', 'uuid', 'guid'].includes(words[words.length - 1])) return false
  return !words.some((w) => NOT_CREDENTIAL_WORDS.has(w))
}

/**
 * 去掉 ID 里的东西：后端生成的 ID（UUID、32 位以上的十六进制）原样发出 —— 模型要读它、原样写回工具调用。
 * ID 的一段永远不算一个值；整个 ID 只在凭据字段里才算（password=、api_key:），已知值照样算。
 * 更短的十六进制 token 没那么确定是 ID，只去掉其中的个人信息（手机号、卡号不会紧贴着十六进制字母写）；
 * 密钥类照样算，整个 token 也照样算（S/N: 后面的十六进制序列号）。
 */
function noIDs(s: string, found: Span[]): Span[] {
  return found.filter((f) => {
    const id = idAround(s, f.start, f.end)
    if (!id) return !(isPersonalCategory(f.category) && inShortHexToken(s, f.start, f.end))
    if (f.start > id[0] || f.end < id[1]) return false // ID 的一段
    if (f.by === 'known') return true
    if (['PASSWORD', 'API_KEY', 'TOKEN', 'PRIVATE_KEY'].includes(f.category)) return true
    if (f.category === 'SECRET') return credentialField(s, id[0])
    return false
  })
}

// ─────────────────────────── 小数与 JSON 数字（magpie noNumbers）───────────────────────────

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** s[a:b] 是一个裸 JSON 数字：全是数字，是对象的值或数字数组的元素，后面只跟着 , } ] */
function jsonNumber(s: string, a: number, b: number): boolean {
  if (a >= b || !/^[0-9]+$/.test(s.slice(a, b))) return false
  let k = b
  while (k < s.length && isSpace(s[k])) k++
  if (k < s.length && !',}]'.includes(s[k])) return false
  let i = a - 1
  while (i >= 0 && isSpace(s[i])) i--
  if (i < 0) return false
  if (s[i] === ':') {
    for (i--; i >= 0 && isSpace(s[i]); i--);
    return i >= 0 && s[i] === '"'
  }
  if (s[i] === '[' || s[i] === ',') {
    for (; i >= 0; i--) {
      if (s[i] === '[') return true
      if (!(DIGITS + ',.-+eE').includes(s[i]) && !isSpace(s[i])) return false
    }
  }
  return false
}

/** s[a:b] 以小数的小数部分开头，或以整数部分结尾 */
function inDecimal(s: string, a: number, b: number): boolean {
  const isDigit = (i: number): boolean => i >= 0 && i < s.length && s[i] >= '0' && s[i] <= '9'
  return (
    (isDigit(a) && a >= 2 && s[a - 1] === '.' && isDigit(a - 2)) ||
    (isDigit(b - 1) && b + 1 < s.length && s[b] === '.' && isDigit(b + 1))
  )
}

/** 去掉小数的一段、裸 JSON 数字里认出的个人信息（身高、价格、坐标、时间戳不是电话号或卡号） */
function noNumbers(s: string, found: Span[]): Span[] {
  return found.filter(
    (f) =>
      !(
        isPersonalCategory(f.category) &&
        (inDecimal(s, f.start, f.end) || jsonNumber(s, f.start, f.end))
      )
  )
}

// ─────────────────────────── 规则 ───────────────────────────

function ruleSpans(s: string): Span[] {
  let lowerCache: string | undefined
  const lower = (): string => (lowerCache ??= lowerASCII(s))
  const found: Span[] = []
  // 一次匹配被拆成几个值的（user@host）：从同一处起、落在里面的邮箱作废
  const split: Array<[number, number]> = []
  for (const rule of DETECT_RULES) {
    for (const m of rule.scan(s, lower)) {
      if (rule.groups) {
        let took = false
        rule.groups.forEach((group, g) => {
          const pair = m.groups[g + 1]
          if (pair && takes(rule, s, pair[0], pair[1], group.ok)) {
            found.push({
              start: pair[0],
              end: pair[1],
              category: group.category,
              rule: rule.id,
              by: 'rule'
            })
            took = true
          }
        })
        if (took && m.groups[1]) split.push([m.groups[1][0], m.groups[0]![1]])
        continue
      }
      let [a, b] = m.groups[0]!
      for (let g = 1; g < m.groups.length; g++) {
        const pair = m.groups[g]
        if (pair) {
          ;[a, b] = pair
          break
        }
        if (!rule.anyGroup) break
      }
      let ok = rule.ok
      if (rule.fix) {
        const fixed = rule.fix(s, a, b)
        if (!fixed) continue
        ;[a, b] = fixed
        ok = undefined
      }
      if (takes(rule, s, a, b, ok)) {
        found.push({ start: a, end: b, category: rule.category!, rule: rule.id, by: 'rule' })
      }
    }
  }
  if (split.length === 0) return found
  return found.filter(
    (f) =>
      !(f.category === 'EMAIL' && split.some(([start, end]) => f.start === start && f.end <= end))
  )
}

// ─────────────────────────── 入口 ───────────────────────────

/**
 * 认出 s 里的敏感内容。known（可选）：会话对照表里的真值，按原文匹配。except（可选）：不要的 —— 按类别（默认照发的
 * 几类）或值（用户照原样发的）；在挑互不重叠的之前就去掉，它们不会挤掉与之重叠的别的。
 * 已有的占位符里不会再认出东西；返回按位置排好、互不重叠。
 */
export function detectSensitive(
  s: string,
  known?: KnownValues,
  opts: { except?: (category: string, value: string) => boolean } = {}
): Finding[] {
  if (s.length < 3) return []
  let spans = ruleSpans(s)
  for (const k of known?.spans(s) ?? []) {
    spans.push({ start: k.start, end: k.end, category: k.category, rule: 'known', by: 'known' })
  }
  const { except } = opts
  if (except) spans = spans.filter((f) => !except(f.category, s.slice(f.start, f.end)))
  let found = noNumbers(s, noIDs(s, spans))
  if (found.length === 0) return []
  const existing = placeholderSpans(s)
  if (existing.length > 0) {
    found = found.filter((f) => !existing.some(([a, b]) => f.start < b && f.end > a))
  }
  // 先开始的赢；同起点取最长；起止都一样取规则表里靠前的（API_KEY=sk-… 归 API_KEY 而不是 SECRET）
  found = found
    .map((f, order) => ({ f, order }))
    .sort((x, y) => x.f.start - y.f.start || y.f.end - x.f.end || x.order - y.order)
    .map(({ f }) => f)
  const out: Finding[] = []
  let next = 0
  for (const f of found) {
    if (f.start < next) continue
    next = f.end
    out.push({
      start: f.start,
      end: f.end,
      value: s.slice(f.start, f.end),
      category: f.category,
      rule: f.rule
    })
  }
  return out
}
