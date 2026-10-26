/**
 * 已知值 —— 会话对照表里已有的真值，按原文精确匹配（magpie 的 known.go）。
 *
 * 规则靠前后文认值（DB_PASSWORD=、邮箱两边不能贴着的字符）；同一个值换了说法（用户在消息里光秃秃地
 * 打出那个密码、模型在回复里提到它）就认不出来了。会话见过它一次，之后在哪儿出现都按原文换掉。
 * 短于 MIN_KNOWN 的不按已知值匹配：三个字母的密码到处都是。
 *
 * 查找是线性的：每个位置先用前 4 个字符的哈希查位图，绝大多数位置一次位运算就跳过；命中再按前 8 个
 * 字符查候选、逐个比对（长的优先）。
 */

/** 按已知值匹配的最短长度（同 magpie：赋值规则对值的要求就是 8） */
export const MIN_KNOWN = 8

export interface KnownValue {
  value: string
  placeholder: string
  category: string
}

/** 一处已知值：位置与它的表项 */
export interface KnownSpan extends KnownValue {
  start: number
  end: number
}

const GRAM_BITS = 20
const GRAM_MASK = (1 << GRAM_BITS) - 1

function gramAt(s: string, i: number): number {
  const g =
    (s.charCodeAt(i) * 29791 +
      s.charCodeAt(i + 1) * 961 +
      s.charCodeAt(i + 2) * 31 +
      s.charCodeAt(i + 3)) >>>
    0
  return Math.imul(g, 2654435761) >>> (32 - GRAM_BITS)
}

export class KnownValues {
  /** 前 8 个字符 → 以它开头的表项（长的在前） */
  private readonly byHead = new Map<string, KnownValue[]>()
  private readonly bits = new Uint32Array((GRAM_MASK + 1) >>> 5)
  private readonly byValue = new Map<string, KnownValue>()

  get size(): number {
    return this.byValue.size
  }

  /** 加入一个值；同一个值重复加入只留第一次（同一个值的占位符本来就一样） */
  add(entry: KnownValue): void {
    if (entry.value.length < MIN_KNOWN || this.byValue.has(entry.value)) return
    this.byValue.set(entry.value, entry)
    const head = entry.value.slice(0, MIN_KNOWN)
    const list = this.byHead.get(head)
    if (list) {
      list.push(entry)
      list.sort((a, b) => b.value.length - a.value.length)
    } else {
      this.byHead.set(head, [entry])
    }
    const g = gramAt(entry.value, 0)
    this.bits[g >>> 5] |= 1 << (g & 31)
  }

  get(value: string): KnownValue | undefined {
    return this.byValue.get(value)
  }

  values(): IterableIterator<KnownValue> {
    return this.byValue.values()
  }

  /** s 里出现的已知值，从左到右、长的优先、互不重叠 */
  spans(s: string): KnownSpan[] {
    const out: KnownSpan[] = []
    if (this.byValue.size === 0) return out
    for (let i = 0; i + MIN_KNOWN <= s.length; ) {
      const g = gramAt(s, i)
      if ((this.bits[g >>> 5] & (1 << (g & 31))) === 0) {
        i++
        continue
      }
      const candidates = this.byHead.get(s.slice(i, i + MIN_KNOWN))
      const hit = candidates?.find((c) => s.startsWith(c.value, i))
      if (!hit) {
        i++
        continue
      }
      out.push({ ...hit, start: i, end: i + hit.value.length })
      i += hit.value.length
    }
    return out
  }

  /**
   * s 的结尾可能是某个已知值的开头：返回那一段的长度（没有返回 0）。流式输出时，这一段先压住不放出，
   * 等下一个事件补全后再按整段替换 —— 否则用户中途停止会留下半个秘密。
   */
  pendingTail(s: string): number {
    if (s.length === 0 || this.byValue.size === 0) return 0
    const lastChar = s[s.length - 1]
    let best = 0
    for (const { value } of this.byValue.values()) {
      // 结尾那一段必须是 value 的一个真前缀：在 value 里找和 s 最后一个字符相同的位置
      for (let j = Math.min(value.length - 2, s.length - 1); j >= best; j--) {
        if (value[j] !== lastChar) continue
        if (s.endsWith(value.slice(0, j + 1))) {
          best = j + 1
          break
        }
      }
    }
    return best
  }
}
