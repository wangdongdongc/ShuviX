/**
 * useSecretChips —— 输入框里要对模型藏起来的值（docs/auto-redaction-design.md §14）：+ 添加的，和确认了提示的。
 *
 * 与粘贴芯片同法（usePasteChips）：textarea 里放一段占位明文（`密码 #1`），镜像层把它画成胶囊；真值只在这里
 * （内存），发送时展开回真值、随 `secrets` 交给宿主 —— 宿主换成占位符，模型只看到占位符。确认的提示落在粘贴芯片的
 * 全文里时没有胶囊可放，只记下这个值（`extra`），同样随 `secrets` 交出去（宿主按值替换）。
 *
 * 发出去的消息里存的是宿主换上的占位符（`{{REDACTED_…}}`）。回退把那条消息放回输入框时经 `adopt` 换回胶囊
 * （真值问会话对照表）：再发时和新加的胶囊走同一条路，宿主沿用同一个占位符。
 *
 * 占位明文是类别 + 递增序号，草稿内唯一；和 @ 引用一样没有括号、没有图标（三种胶囊一个样子，用户 2026-11-12 的
 * 要求）。在它内部编辑即破坏字面量 → prune 丢掉这个胶囊（真值随之丢掉，不会以残文形式发出去 —— 残文是占位明文，
 * 不是真值）。没有括号收尾，`密码 #1` 是 `密码 #10` 的开头：同一处起点取长的那个（matchSecretChips），退格也只认
 * 整个命中的结尾。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  splitPlaceholders,
  type RedactionMarkInfo,
  type UserSecret
} from '@shuvix/chat-protocol/utils/redactionPlaceholders'

/** 一个胶囊 */
export interface SecretChip {
  /** 写进 textarea 的占位明文，如 `密码 #1` */
  text: string
  value: string
  category: string
  seq: number
}

/** textarea 内一处胶囊命中的区间 [start, end) */
export interface SecretMatch {
  start: number
  end: number
  chip: SecretChip
}

/** 文本里各胶囊的非重叠命中（镜像层画胶囊 + 发送时展开共用）。同一处起点取长的（`密码 #10` 不算成 `密码 #1` 加个 0） */
export function matchSecretChips(text: string, chips: readonly SecretChip[]): SecretMatch[] {
  const hits: SecretMatch[] = []
  for (const chip of chips) {
    for (
      let i = text.indexOf(chip.text);
      i !== -1;
      i = text.indexOf(chip.text, i + chip.text.length)
    ) {
      hits.push({ start: i, end: i + chip.text.length, chip })
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SecretMatch[] = []
  let lastEnd = -1
  for (const h of hits) {
    if (h.start < lastEnd) continue
    out.push(h)
    lastEnd = h.end
  }
  return out
}

export interface UseSecretChips {
  chips: SecretChip[]
  /** 在选区处放一个胶囊（替换选区）：返回新文本与光标 */
  insert: (
    value: string,
    category: string,
    text: string,
    selStart: number,
    selEnd: number
  ) => { text: string; caret: number }
  /** 确认一条提示：文本里所有出现的 value 换成一个胶囊；文本里没有（在粘贴芯片里）就只记下这个值 */
  hide: (value: string, category: string, text: string) => string
  /**
   * 回退把发过的消息放回输入框：文本里宿主当初换下的占位符（`{{REDACTED_…}}`）换回胶囊，真值取自会话对照表
   * （`infoOf`）。取不到真值的原样留着 —— 那个占位符本身照发，宿主认得。
   */
  adopt: (text: string, infoOf: (placeholder: string) => RedactionMarkInfo | undefined) => string
  /** 文本变化后剪掉占位已不在的胶囊 */
  prune: (text: string) => void
  /** 光标紧贴胶囊尾部时，一次退格删掉整个胶囊；否则 null */
  backspace: (text: string, caret: number) => { text: string; caret: number } | null
  /** 发送：胶囊展开回真值；secrets = 全部要藏的值（含粘贴芯片里确认的） */
  expand: (text: string) => { text: string; secrets: UserSecret[] }
  /** 屏幕上（乐观占位气泡、粘贴全文）不出现真值：要藏的值换成它的胶囊文字 */
  maskForDisplay: (text: string) => string
  /** 已经要藏的值（提示不再提它们） */
  isHidden: (value: string) => boolean
  reset: () => void
  /** 此刻的胶囊（清空输入框之前记下，发送没成时经 restore 放回 —— 真值只在这里，放回文本里的是占位明文） */
  snapshot: () => SecretChipsSnapshot
  restore: (snapshot: SecretChipsSnapshot) => void
}

export interface SecretChipsSnapshot {
  chips: SecretChip[]
  extra: SecretChip[]
  seq: number
}

export function useSecretChips(): UseSecretChips {
  const { t } = useTranslation()
  const [chips, setChips] = useState<SecretChip[]>([])
  // 确认在粘贴芯片全文里的：没有胶囊，只有值
  const extraRef = useRef<SecretChip[]>([])
  const seqRef = useRef(0)
  const chipsRef = useRef(chips)
  useEffect(() => {
    chipsRef.current = chips
  })

  const makeChip = useCallback(
    (value: string, category: string): SecretChip => {
      const seq = ++seqRef.current
      const label = t(`redaction.category.${category}`, { defaultValue: category })
      return { text: t('input.secretChip', { seq, label }), value, category, seq }
    },
    [t]
  )

  const insert = useCallback(
    (value: string, category: string, text: string, selStart: number, selEnd: number) => {
      const chip = makeChip(value, category)
      chipsRef.current = [...chipsRef.current, chip]
      setChips(chipsRef.current)
      return {
        text: text.slice(0, selStart) + chip.text + text.slice(selEnd),
        caret: selStart + chip.text.length
      }
    },
    [makeChip]
  )

  const hide = useCallback(
    (value: string, category: string, text: string): string => {
      if (value.length === 0) return text
      const chip = makeChip(value, category)
      if (!text.includes(value)) {
        extraRef.current = [...extraRef.current, chip]
        return text
      }
      chipsRef.current = [...chipsRef.current, chip]
      setChips(chipsRef.current)
      return text.split(value).join(chip.text)
    },
    [makeChip]
  )

  const adopt = useCallback(
    (text: string, infoOf: (placeholder: string) => RedactionMarkInfo | undefined): string => {
      const segments = splitPlaceholders(text)
      if (segments.every((segment) => typeof segment === 'string')) return text
      // 同一个占位符（= 同一个值）出现几次都是同一个胶囊；null = 取不到真值
      const adopted = new Map<string, SecretChip | null>()
      let out = ''
      for (const segment of segments) {
        if (typeof segment === 'string') {
          out += segment
          continue
        }
        let chip = adopted.get(segment.placeholder)
        if (chip === undefined) {
          const info = infoOf(segment.placeholder)
          chip = info?.value ? makeChip(info.value, info.category) : null
          adopted.set(segment.placeholder, chip)
        }
        out += chip?.text ?? segment.placeholder
      }
      const added = [...adopted.values()].filter((chip): chip is SecretChip => chip !== null)
      if (added.length > 0) {
        chipsRef.current = [...chipsRef.current, ...added]
        setChips(chipsRef.current)
      }
      return out
    },
    [makeChip]
  )

  const prune = useCallback((text: string): void => {
    setChips((prev) => {
      const next = prev.filter((c) => text.includes(c.text))
      if (next.length === prev.length) return prev
      chipsRef.current = next
      return next
    })
  }, [])

  const backspace = useCallback(
    (text: string, caret: number): { text: string; caret: number } | null => {
      // 只认整个命中的结尾：光标在 `密码 #1|0` 里不是 #1 的结尾
      const hit = matchSecretChips(text, chipsRef.current).find((m) => m.end === caret)
      return hit ? { text: text.slice(0, hit.start) + text.slice(caret), caret: hit.start } : null
    },
    []
  )

  const expand = useCallback((text: string): { text: string; secrets: UserSecret[] } => {
    const matches = matchSecretChips(text, chipsRef.current)
    let out = ''
    let last = 0
    for (const m of matches) {
      out += text.slice(last, m.start) + m.chip.value
      last = m.end
    }
    out += text.slice(last)
    const used = new Set(matches.map((m) => m.chip))
    const secrets = [...used, ...extraRef.current].map((c) => ({
      value: c.value,
      category: c.category
    }))
    return { text: out, secrets }
  }, [])

  const maskForDisplay = useCallback((text: string): string => {
    let out = text
    const all = [...chipsRef.current, ...extraRef.current].sort(
      (a, b) => b.value.length - a.value.length
    )
    for (const c of all) out = out.split(c.value).join(c.text)
    return out
  }, [])

  const isHidden = useCallback(
    (value: string): boolean =>
      chipsRef.current.some((c) => c.value === value) ||
      extraRef.current.some((c) => c.value === value),
    []
  )

  const reset = useCallback((): void => {
    chipsRef.current = []
    extraRef.current = []
    seqRef.current = 0
    setChips([])
  }, [])

  const snapshot = useCallback(
    (): SecretChipsSnapshot => ({
      chips: chipsRef.current,
      extra: extraRef.current,
      seq: seqRef.current
    }),
    []
  )
  const restore = useCallback((saved: SecretChipsSnapshot): void => {
    chipsRef.current = saved.chips
    extraRef.current = saved.extra
    seqRef.current = saved.seq
    setChips(saved.chips)
  }, [])

  return {
    chips,
    insert,
    hide,
    adopt,
    prune,
    backspace,
    expand,
    maskForDisplay,
    isHidden,
    reset,
    snapshot,
    restore
  }
}
