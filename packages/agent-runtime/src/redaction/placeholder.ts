/**
 * 占位符 —— `{{CATEGORY_xxxxxxxx}}`，8 位是 `base32(HMAC-SHA256(key, category + "\0" + value))` 的前 8 个字符
 * （小写）。同一个值永远得到同一个占位符：发给厂商的字节不变，前缀缓存和 thinking 签名都不受影响；
 * 跨会话传递时只复制对照表项、不改写文本。格式与识别移植自 magpie（yetone/magpie v0.1.1548，MIT）。
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

export function makePlaceholder(
  signer: PlaceholderSigner,
  category: string,
  value: string
): string {
  return `{{${category}_${base32Head(signer.sign(`${category}\u0000${value}`))}}}`
}

/** 占位符的标准写法 */
export const PLACEHOLDER_PATTERN = String.raw`\{\{[A-Z][A-Z0-9_]*_[a-z2-7]{8}\}\}`

/** 文本里已有的占位符（[起, 止)）—— 检测不会在它们里面再认出东西 */
export function placeholderSpans(s: string): Array<[number, number]> {
  if (!s.includes('{{')) return []
  const re = new RegExp(PLACEHOLDER_PATTERN, 'g')
  const out: Array<[number, number]> = []
  for (let m = re.exec(s); m; m = re.exec(s)) out.push([m.index, m.index + m[0].length])
  return out
}

/** 占位符的类别段（`{{API_KEY_k3v7x2mq}}` → `API_KEY`） */
export function categoryOfPlaceholder(placeholder: string): string {
  return placeholder.slice(2, placeholder.length - 2 - 9)
}

// ─────────────────────────── 识别模型写回来的占位符 ───────────────────────────

/** 去掉括号的占位符正文，模型可能这样写回来：API_KEY_k3v7x2mq、phone_b5puzbfv、PHONE_B5PUZBFV */
const PLACEHOLDER_BODY = /[A-Za-z][A-Za-z0-9_]*_[A-Za-z2-7]{8}/g

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c)

/** 不管大小写，正文对应的标准占位符 */
function canonical(body: string): string {
  const cut = body.length - 8
  return `{{${body.slice(0, cut).toUpperCase()}${body.slice(cut).toLowerCase()}}}`
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
 * 找出文本里的占位符，包括模型写坏的形式（{{ PHONE_b5puzbfv }}、少了括号、改了大小写）。
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
    if (a < last || isWordChar(s[a - 1]) || isWordChar(s[z])) continue
    const placeholder = canonical(m[0])
    if (!known(placeholder)) continue
    ;[a, z] = braces(s, a, z)
    if (a < last) continue
    out.push({ start: a, end: z, placeholder })
    last = z
  }
  return out
}
