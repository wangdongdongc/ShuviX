/**
 * usePasteChips —— 聊天输入框长文粘贴折叠为「粘贴芯片」。
 *
 * 粘贴文本超阈值（行数/字符数）时不落入 textarea，改插入短占位明文（如 `[粘贴文本 #1 · 45 行]`），
 * 完整内容暂存草稿态；发送时把每处占位替换成 {{shuvixInlineToken:pN}} 标记 + 构造 paste 类型
 * InlineToken（payload 随 metadata 持久化），后端 resolveTokensForAgent 展开为完整原文交给 LLM，
 * 气泡侧则渲染为 TokenChip 胶囊（点击弹窗看原文）——聊天记录不再被超长粘贴撑爆。
 *
 * 与 @ 引用同用「textarea 存明文 + 镜像层画胶囊」方案（见 useAtMentions / MentionHighlighter）；
 * 占位明文自带 `[...]` 括号与递增序号，草稿内天然唯一，故匹配用严格字面量、不做词边界判定
 * （用户在占位符内部编辑即破坏字面量 → prune 丢弃芯片，残文降级为普通文字，与 @ 引用一致）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { buildPasteToken, makeTokenMarker } from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'

/** 触发折叠的行数阈值（超过即折叠） */
export const PASTE_LINE_THRESHOLD = 8
/** 触发折叠的字符数阈值（超过即折叠） */
export const PASTE_CHAR_THRESHOLD = 800

/** 一条已登记的粘贴芯片 */
export interface PasteChip {
  /** 写入 textarea 的占位明文（含括号），如 `[粘贴文本 #1 · 45 行]` */
  text: string
  /** 完整粘贴内容（行尾已归一为 \n） */
  payload: string
  /** 草稿内序号（1 起，随 reset 归零） */
  seq: number
  /** 弹窗标题（如 `粘贴文本 #1`） */
  name: string
}

/** textarea 内一处占位命中的区间 [start, end) */
export interface PasteMatch {
  start: number
  end: number
  chip: PasteChip
}

/** 粘贴文本是否达到折叠阈值 */
export function isLargePaste(text: string): boolean {
  if (text.length > PASTE_CHAR_THRESHOLD) return true
  return countPasteLines(text) > PASTE_LINE_THRESHOLD
}

/** 行数统计（忽略尾部空行，至少 1 行） */
export function countPasteLines(text: string): number {
  return text.replace(/\n+$/, '').split('\n').length
}

/**
 * 在文本内定位所有已登记芯片占位的非重叠命中（镜像层画胶囊 + 发送时替换共用）。
 * 占位串含序号互不相同，直接收集全部字面量出现位置，按起点排序后贪心去重叠。
 */
export function matchPasteChips(text: string, chips: PasteChip[]): PasteMatch[] {
  if (chips.length === 0) return []
  const hits: PasteMatch[] = []
  for (const chip of chips) {
    let from = 0
    let idx: number
    while ((idx = text.indexOf(chip.text, from)) !== -1) {
      hits.push({ start: idx, end: idx + chip.text.length, chip })
      from = idx + chip.text.length
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: PasteMatch[] = []
  let lastEnd = -1
  for (const h of hits) {
    if (h.start >= lastEnd) {
      out.push(h)
      lastEnd = h.end
    }
  }
  return out
}

export interface UsePasteChips {
  /** 已登记的芯片（供镜像层渲染） */
  chips: PasteChip[]
  /**
   * 尝试捕获一次粘贴：低于阈值返回 null（调用方走默认粘贴）；
   * 否则登记芯片并返回「插入占位后的文本 + 新光标位置」。
   */
  capture: (
    clip: string,
    text: string,
    selStart: number,
    selEnd: number
  ) => { text: string; caret: number } | null
  /** 文本变化后剪除占位已不存在的芯片（丢弃其暂存内容） */
  prune: (text: string) => void
  /** 光标紧邻占位尾部时，一次退格整体删除；否则返回 null */
  backspace: (text: string, caret: number) => { text: string; caret: number } | null
  /** 发送时构造标记文本 + paste 类型 InlineToken（无芯片则原样返回） */
  buildOutgoing: (text: string) => {
    contentText: string
    inlineTokens?: Record<string, InlineToken>
  }
  /** 斜杠命令等无法携带 token 的场景：把占位就地展开为完整粘贴内容 */
  resolveInline: (text: string) => string
  /** 回退草稿重建：按 paste 类型 token 重新登记芯片（占位/payload 原样保留），配合明文回填恢复胶囊 */
  restoreFromTokens: (tokens: InlineToken[]) => void
  /** 发送后清空芯片登记与序号 */
  reset: () => void
}

export function usePasteChips(): UsePasteChips {
  const { t } = useTranslation()
  const [chips, setChips] = useState<PasteChip[]>([])
  const seqRef = useRef(0)

  // 回调内读最新 chips 而不进依赖数组（与 useAtMentions 同法：ref 在提交后 effect 中更新）
  const chipsRef = useRef(chips)
  useEffect(() => {
    chipsRef.current = chips
  })

  const capture = useCallback(
    (
      clip: string,
      text: string,
      selStart: number,
      selEnd: number
    ): { text: string; caret: number } | null => {
      if (!isLargePaste(clip)) return null
      // 行尾归一（textarea 默认粘贴也会把 \r\n 归一为 \n）
      const payload = clip.replace(/\r\n?/g, '\n')
      const seq = ++seqRef.current
      const lines = countPasteLines(payload)
      const placeholder =
        lines > 1
          ? t('input.pasteChipLines', { seq, lines })
          : t('input.pasteChipChars', { seq, chars: payload.length })
      const name = t('input.pasteName', { seq })
      setChips((prev) => [...prev, { text: placeholder, payload, seq, name }])
      return {
        text: text.slice(0, selStart) + placeholder + text.slice(selEnd),
        caret: selStart + placeholder.length
      }
    },
    [t]
  )

  const prune = useCallback((text: string): void => {
    setChips((prev) => {
      const next = prev.filter((c) => text.includes(c.text))
      return next.length === prev.length ? prev : next
    })
  }, [])

  const backspace = useCallback(
    (text: string, caret: number): { text: string; caret: number } | null => {
      if (caret <= 0) return null
      const cands = [...chipsRef.current].sort((a, b) => b.text.length - a.text.length)
      for (const c of cands) {
        const s = caret - c.text.length
        if (s < 0) continue
        if (text.slice(s, caret) !== c.text) continue
        return { text: text.slice(0, s) + text.slice(caret), caret: s }
      }
      return null
    },
    []
  )

  const buildOutgoing = useCallback(
    (text: string): { contentText: string; inlineTokens?: Record<string, InlineToken> } => {
      const matches = matchPasteChips(text, chipsRef.current)
      if (matches.length === 0) return { contentText: text }
      const uidBySeq = new Map<number, string>()
      const tokens: Record<string, InlineToken> = {}
      let out = ''
      let last = 0
      let counter = 0
      for (const m of matches) {
        out += text.slice(last, m.start)
        let uid = uidBySeq.get(m.chip.seq)
        if (!uid) {
          // uid 前缀 p 与 @ 引用的 a / 命令的 t0 互不冲突，可在同一 inlineTokens 字典合并
          uid = `p${counter++}`
          uidBySeq.set(m.chip.seq, uid)
          tokens[uid] = buildPasteToken({
            payload: m.chip.payload,
            displayText: m.chip.text,
            seq: m.chip.seq,
            name: m.chip.name
          })
        }
        out += makeTokenMarker(uid)
        last = m.end
      }
      out += text.slice(last)
      return { contentText: out, inlineTokens: tokens }
    },
    []
  )

  const resolveInline = useCallback((text: string): string => {
    const matches = matchPasteChips(text, chipsRef.current)
    if (matches.length === 0) return text
    let out = ''
    let last = 0
    for (const m of matches) {
      out += text.slice(last, m.start) + m.chip.payload
      last = m.end
    }
    return out + text.slice(last)
  }, [])

  const restoreFromTokens = useCallback((tokens: InlineToken[]): void => {
    if (tokens.length === 0) return
    const restored: PasteChip[] = []
    for (const t of tokens) {
      // 序号取自 token id（paste-N），并推进计数器避免与后续新粘贴撞号
      const parsed = Number(/^paste-(\d+)$/.exec(t.id)?.[1])
      const seq = Number.isFinite(parsed) && parsed > 0 ? parsed : seqRef.current + 1
      seqRef.current = Math.max(seqRef.current, seq)
      restored.push({ text: t.displayText, payload: t.payload, seq, name: t.name ?? t.displayText })
    }
    setChips((prev) => {
      const add = restored.filter((c) => !prev.some((p) => p.text === c.text))
      return add.length > 0 ? [...prev, ...add] : prev
    })
  }, [])

  const reset = useCallback((): void => {
    setChips([])
    seqRef.current = 0
  }, [])

  return {
    chips,
    capture,
    prune,
    backspace,
    buildOutgoing,
    resolveInline,
    restoreFromTokens,
    reset
  }
}
