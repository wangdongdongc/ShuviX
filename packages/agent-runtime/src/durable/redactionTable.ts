/**
 * 会话的占位符对照表（`RedactionTableDoc`）—— 读写与内存视图（docs/auto-redaction-design.md §5）。
 *
 * 宿主无关：真值怎么加密（RedactionVault）由宿主交进来。内存里留一份解开的视图（RedactionTable），会话打开时
 * 读一次、之后随记随更 —— 工具执行前的还原、界面的还原、出口按策略换回真值、写入时的已知值匹配都查它。
 * 解不开的表项（主密钥不在、密文坏了）标成不可用：它的占位符照样认得出来，只是查不到真值（§2.2 的「查不到」）。
 */
import type { Harness } from '@earendil-works/pi-durable'
import { KnownValues } from '../redaction/known'
import { findPlaceholders } from '../redaction/placeholder'
import { backgroundContext as BG } from './context'
import { RedactionTableDoc } from './docs'

/** 用户在输入框里交来的（+ 添加的、确认了提示的）表项的规则名：短值也按整词匹配（known.ts wholeWord） */
export const USER_RULE = 'user'

/** 宿主的加密：真值进文档前加密、读出来解密；解不开时抛错 */
export interface RedactionVault {
  seal(value: string): string
  open(sealed: string): string
}

/** 一处被换成占位符的内容 */
export interface RedactionEntry {
  placeholder: string
  category: string
  rule: string
  value: string
}

/** 表里的一项：解不开的没有 value */
export interface RedactionTableItem {
  category: string
  rule: string
  value?: string
}

/** 会话对照表的内存视图 */
export class RedactionTable {
  private readonly items = new Map<string, RedactionTableItem>()
  /** 解得开的真值，供原文匹配（写入时的已知值、出口把回复里的真值换回占位符） */
  readonly known = new KnownValues()
  /** 用户照原样发的值（asWrittenKey，§14.2）：检测跳过它们 */
  readonly asWritten = new Set<string>()

  get size(): number {
    return this.items.size
  }

  has(placeholder: string): boolean {
    return this.items.has(placeholder)
  }

  get(placeholder: string): RedactionTableItem | undefined {
    return this.items.get(placeholder)
  }

  /** 占位符的真值；表里没有或解不开 → undefined */
  valueOf(placeholder: string): string | undefined {
    return this.items.get(placeholder)?.value
  }

  entries(): IterableIterator<[string, RedactionTableItem]> {
    return this.items.entries()
  }

  /** 放进内存视图（已在表里的不动：同一个占位符永远同一个值） */
  put(placeholder: string, item: RedactionTableItem): boolean {
    if (this.items.has(placeholder)) return false
    this.items.set(placeholder, item)
    if (item.value !== undefined) {
      this.known.add({
        value: item.value,
        placeholder,
        category: item.category,
        wholeWord: item.rule === USER_RULE
      })
    }
    return true
  }
}

/**
 * 这几段文本里引用到的、表里解得开的项 —— 内容从这个会话流进别的会话时（子会话的指令与结果、读取别的会话、
 * 日报 bot）随它一起复制过去（§5.3），对方的历史因此不依赖这个会话还在不在。
 */
export function entriesReferencedBy(
  table: RedactionTable,
  texts: readonly string[]
): RedactionEntry[] {
  const out = new Map<string, RedactionEntry>()
  for (const text of texts) {
    for (const hit of findPlaceholders(text, (p) => table.has(p))) {
      const item = table.get(hit.placeholder)
      if (item?.value === undefined || out.has(hit.placeholder)) continue
      out.set(hit.placeholder, {
        placeholder: hit.placeholder,
        category: item.category,
        rule: item.rule,
        value: item.value
      })
    }
  }
  return [...out.values()]
}

/** 读出会话的对照表；解不开的项标成不可用 */
export async function loadRedactionTable(
  harness: Harness,
  vault: RedactionVault
): Promise<RedactionTable> {
  const table = new RedactionTable()
  const doc = await harness.snapshot(RedactionTableDoc, BG)
  for (const [placeholder, raw] of Object.entries(doc?.items ?? {})) {
    let value: string | undefined
    try {
      value = vault.open(raw.value)
    } catch {
      value = undefined
    }
    table.put(placeholder, {
      category: raw.category,
      rule: raw.rule,
      ...(value === undefined ? {} : { value })
    })
  }
  for (const key of Object.keys(doc?.asWritten ?? {})) table.asWritten.add(key)
  return table
}

/**
 * 把新认出的几处记进对照表（文档与内存视图），连同用户照原样发的值（asWritten：asWrittenKey 的结果）。已在表里的
 * 跳过；返回这次新记了几项。在一个提交里写，并发的几次记录各自读到对方写下的项，不会互相覆盖。
 */
export async function recordRedactions(
  harness: Harness,
  table: RedactionTable,
  entries: readonly RedactionEntry[],
  vault: RedactionVault,
  asWritten: readonly string[] = []
): Promise<number> {
  const fresh = new Map<string, RedactionEntry>()
  for (const entry of entries) {
    if (!table.has(entry.placeholder) && !fresh.has(entry.placeholder))
      fresh.set(entry.placeholder, entry)
  }
  const freshKeys = [...new Set(asWritten)].filter((key) => !table.asWritten.has(key))
  if (fresh.size === 0 && freshKeys.length === 0) return 0
  const sealed = [...fresh.values()].map((entry) => ({ entry, value: vault.seal(entry.value) }))
  const written = await harness.commit(async (tx) => {
    const doc = await tx.doc(RedactionTableDoc)
    let n = 0
    for (const { entry, value } of sealed) {
      if (doc.items[entry.placeholder] !== undefined) continue
      doc.items[entry.placeholder] = { category: entry.category, rule: entry.rule, value }
      n++
    }
    if (freshKeys.length > 0) {
      doc.asWritten ??= {}
      for (const key of freshKeys) doc.asWritten[key] = true
    }
    return n
  }, BG)
  for (const entry of fresh.values()) {
    table.put(entry.placeholder, { category: entry.category, rule: entry.rule, value: entry.value })
  }
  for (const key of freshKeys) table.asWritten.add(key)
  return written
}
