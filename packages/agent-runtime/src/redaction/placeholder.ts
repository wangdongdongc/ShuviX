/**
 * 占位符 —— `{{REDACTED_CATEGORY_xxxxxxxx}}`，8 位是 `base32(HMAC-SHA256(key, category + "\0" + value))` 的前 8 个
 * 字符（小写）。同一个值永远得到同一个占位符：发给厂商的字节不变，前缀缓存和 thinking 签名都不受影响；
 * 跨会话传递时只复制对照表项、不改写文本。格式与识别移植自 magpie（yetone/magpie v0.1.1548，MIT）。
 *
 * `REDACTED_` 让模型在看到它的地方就知道这是脱敏掉的值：magpie 的 `{{CATEGORY_xxxxxxxx}}` 像没填的模板变量，
 * 模型会去猜它是什么、去别处找它。v0.2.30 / v0.2.31 写下的是没有前缀的旧写法，照样认（会话已有的值沿用它）。
 *
 * HMAC 由宿主注入（PlaceholderSigner）：密钥是宿主的秘密，agent-runtime 不碰 Node 的 crypto。
 */

/** 宿主提供的签名：HMAC-SHA256(密钥, data)，返回摘要（至少 5 个字节） */
export interface PlaceholderSigner {
  sign(data: string): Uint8Array
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/** 摘要前 5 个字节（40 位）→ 8 个 base32 字符，小写 */
function base32Head(digest: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < 5; i++) {
    value = (value << 8) | digest[i]
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out
}

/** 占位符正文的开头（旧写法没有） */
export const PLACEHOLDER_PREFIX = 'REDACTED_'

export function makePlaceholder(
  signer: PlaceholderSigner,
  category: string,
  value: string
): string {
  return `{{${PLACEHOLDER_PREFIX}${category}_${base32Head(signer.sign(`${category}\u0000${value}`))}}}`
}

/**
 * 一个新认出的值用哪个占位符：会话里已有它的旧写法（同一类别同一个值，v0.2.30 / v0.2.31 记下的）就沿用 ——
 * 同一个值在一个会话里只有一个名字。has = 会话对照表里有没有。
 */
export function placeholderFor(
  signer: PlaceholderSigner,
  category: string,
  value: string,
  has: (placeholder: string) => boolean
): string {
  const placeholder = makePlaceholder(signer, category, value)
  const legacy = `{{${placeholder.slice(2 + PLACEHOLDER_PREFIX.length)}`
  return has(legacy) ? legacy : placeholder
}

/**
 * 用户照原样发的一个值在对照表里的键（docs/auto-redaction-design.md §14.2）：HMAC 的前 16 个字节（十六进制），
 * 不存真值 —— 只用来认「这个值用户决定让模型看」。与类别无关：同一个值换个规则认出来也是它。
 */
export function asWrittenKey(signer: PlaceholderSigner, value: string): string {
  let out = ''
  for (const byte of signer.sign(`as-written\u0000${value}`).subarray(0, 16)) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/** 占位符的标准写法（新旧两种都认） */
export const PLACEHOLDER_PATTERN = String.raw`\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}`

/** 文本里已有的占位符（[起, 止)）—— 检测不会在它们里面再认出东西 */
export function placeholderSpans(s: string): Array<[number, number]> {
  if (!s.includes('{{')) return []
  const re = new RegExp(PLACEHOLDER_PATTERN, 'g')
  const out: Array<[number, number]> = []
  for (let m = re.exec(s); m; m = re.exec(s)) out.push([m.index, m.index + m[0].length])
  return out
}

/** 占位符的类别段（`{{REDACTED_API_KEY_k3v7x2mq}}`、旧写法 `{{API_KEY_k3v7x2mq}}` → `API_KEY`） */
export function categoryOfPlaceholder(placeholder: string): string {
  const body = placeholder.slice(2, placeholder.length - 2 - 9)
  return body.startsWith(PLACEHOLDER_PREFIX) ? body.slice(PLACEHOLDER_PREFIX.length) : body
}

// ─────────────────────────── 识别模型写回来的占位符 ───────────────────────────

/**
 * 去掉括号的占位符正文，模型可能这样写回来：REDACTED_API_KEY_k3v7x2mq、redacted_phone_b5puzbfv、PHONE_B5PUZBFV。
 * 正文就是一整个词：前后紧贴字母、数字、_ 的不算（xPHONE_b5puzbfv）。这一条必须写在正则里 —— 只在循环里
 * 丢掉的话，正则会从一长串字母数字（零填充的 base64、十六进制）的每个位置起都吃到串尾、再一路退回来找 _，
 * 长串上是平方级（5 万字符近 1 秒）；有了前后断言，只有词首会去试，一个词只扫一遍。
 */
const PLACEHOLDER_BODY = /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8}(?![A-Za-z0-9_])/g

/** 不管大小写，正文对应的标准占位符；再加上多写或少写了 REDACTED_ 的那个（新旧写法混着出现时模型会写串） */
function candidates(body: string): [string, string] {
  const cut = body.length - 8
  const head = body.slice(0, cut).toUpperCase()
  const hash = body.slice(cut).toLowerCase()
  const other = head.startsWith(PLACEHOLDER_PREFIX)
    ? head.slice(PLACEHOLDER_PREFIX.length)
    : PLACEHOLDER_PREFIX + head
  return [`{{${head}${hash}}}`, `{{${other}${hash}}}`]
}

/**
 * 把正文 s[a:z] 扩到模型在它两边写的括号（以及括号里的空格）：{{ 和 }} 都有，或者少了一边的一个
 * （{{X} 或 {X}}），或者只有 {{ 或只有 }}。只在一边有单个括号的，是文本自己的（代码里的 {X），不动。
 */
function braces(s: string, a: number, z: number): [number, number] {
  let la = a
  let l = 0
  while (la > 0 && (s[la - 1] === ' ' || s[la - 1] === '\t')) la--
  while (l < 2 && la > 0 && s[la - 1] === '{') {
    la--
    l++
  }
  let rz = z
  let r = 0
  while (rz < s.length && (s[rz] === ' ' || s[rz] === '\t')) rz++
  while (r < 2 && rz < s.length && s[rz] === '}') {
    rz++
    r++
  }
  if (l === 2 || (l === 1 && r >= 1)) a = la
  if (r === 2 || (r === 1 && l >= 1)) z = rz
  return [a, z]
}

/** 文本里认出的一个占位符：位置（含括号）、标准写法 */
export interface PlaceholderHit {
  start: number
  end: number
  placeholder: string
}

/**
 * 找出文本里的占位符，包括模型写坏的形式（{{ REDACTED_PHONE_b5puzbfv }}、少了括号、改了大小写、多写或少写了
 * REDACTED_）。
 * 只认 known 里有的（类别 + 8 位哈希对得上 —— 随便一段文字碰巧对上几乎不可能）。
 */
export function findPlaceholders(
  s: string,
  known: (placeholder: string) => boolean
): PlaceholderHit[] {
  if (!s.includes('_')) return []
  const out: PlaceholderHit[] = []
  let last = 0
  PLACEHOLDER_BODY.lastIndex = 0
  for (let m = PLACEHOLDER_BODY.exec(s); m; m = PLACEHOLDER_BODY.exec(s)) {
    let a = m.index
    let z = a + m[0].length
    if (a < last) continue
    const placeholder = candidates(m[0]).find(known)
    if (placeholder === undefined) continue
    ;[a, z] = braces(s, a, z)
    if (a < last) continue
    out.push({ start: a, end: z, placeholder })
    last = z
  }
  return out
}
