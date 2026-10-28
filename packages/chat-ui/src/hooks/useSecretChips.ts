/**
 * useSecretChips —— 输入框里要对模型藏起来的值（docs/auto-redaction-design.md §14）：+ 添加的，和确认了提示的。
 *
 * 与粘贴芯片同法（usePasteChips）：textarea 里放一段占位明文（`[🔒 密码 #1]`），镜像层把它画成胶囊；真值只在这里
 * （内存），发送时展开回真值、随 `secrets` 交给宿主 —— 宿主换成占位符，模型只看到占位符。确认的提示落在粘贴芯片的
 * 全文里时没有胶囊可放，只记下这个值（`extra`），同样随 `secrets` 交出去（宿主按值替换）。
 *
 * 占位明文自带括号与递增序号，草稿内唯一；在它内部编辑即破坏字面量 → prune 丢掉这个胶囊（真值随之丢掉，不会
 * 以残文形式发出去 —— 残文是占位明文，不是真值）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserSecret } from '@shuvix/chat-protocol/utils/redactionPlaceholders'

/** 一个胶囊 */
export interface SecretChip {
  /** 写进 textarea 的占位明文（含括号），如 `[🔒 密码 #1]` */
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

/** 文本里各胶囊的非重叠命中（镜像层画胶囊 + 发送时展开共用） */
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
      for (const c of chipsRef.current) {
        const s = caret - c.text.length
        if (s >= 0 && text.slice(s, caret) === c.text) {
          return { text: text.slice(0, s) + text.slice(caret), caret: s }
        }
      }
      return null
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

  return { chips, insert, hide, prune, backspace, expand, maskForDisplay, isHidden, reset }
}
