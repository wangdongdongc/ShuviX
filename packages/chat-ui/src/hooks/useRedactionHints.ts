/**
 * useRedactionHints —— 输入框的提示（docs/auto-redaction-design.md §14.2）：停笔一会儿，问宿主这段话里哪些按策略会对
 * 这个会话的模型藏起来。**只提示**：用户点「隐藏」才换成胶囊（useSecretChips.hide）；不理会的照原样发。
 *
 * 粘贴芯片的全文一起问：落在那里的只出现在提示行里，不画下划线。下划线只画在问的时候那段原文上（文本一变就收起，
 * 等下一次结果）；提示行里的项只要值还在文本里就留着，免得打字时一闪一闪。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSessionChannelApi } from '../api/chatApi'
import type { RedactionHint } from '@shuvix/chat-protocol/utils/redactionPlaceholders'

/** 停笔多久再问（毫秒） */
export const HINT_DEBOUNCE_MS = 400

/** 提示行里的一项：同一个值在几处出现只算一项 */
export interface RedactionHintItem {
  value: string
  category: string
}

/** 镜像层要画下划线的一处（textarea 里的区间） */
export type RedactionHintSpan = RedactionHint

interface InspectResult {
  text: string
  pastes: string[]
  hints: RedactionHint[][]
}

export function useRedactionHints(params: {
  sessionId: string | null
  provider?: string
  model?: string
  /** textarea 里的文字（含胶囊的占位明文） */
  text: string
  /** 粘贴芯片的全文 */
  pastes: string[]
  /** 已经要藏的值 */
  isHidden: (value: string) => boolean
  enabled: boolean
}): {
  items: RedactionHintItem[]
  spans: RedactionHintSpan[]
  dismiss: () => void
} {
  const { sessionId, provider, model, text, pastes, isHidden, enabled } = params
  const [result, setResult] = useState<InspectResult | null>(null)
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const pastesKey = pastes.join('\u0000')

  useEffect(() => {
    if (!enabled || (text.trim().length < 3 && pastes.length === 0)) {
      setResult(null)
      return
    }
    let redaction: ReturnType<typeof getSessionChannelApi>['redaction'] | undefined
    try {
      redaction = getSessionChannelApi().redaction
    } catch {
      return
    }
    // 旧宿主 / 没有这一项的渠道端：不提示
    if (typeof redaction?.inspect !== 'function') return
    const api = redaction
    let live = true
    const timer = setTimeout(() => {
      const texts = [text, ...pastes]
      api
        .inspect({
          ...(sessionId ? { sessionId } : {}),
          ...(provider && model ? { provider, model } : {}),
          texts
        })
        .then((hints) => {
          if (live && Array.isArray(hints)) setResult({ text, pastes, hints })
        })
        .catch(() => {
          // 提示可有可无：宿主不认、出错就当没有
        })
    }, HINT_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // pastes 按内容比较（pastesKey）：每次渲染都是新数组
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionId, provider, model, text, pastesKey])

  // 发掉 / 清空之后，「不用提示了」的记忆跟着清掉
  useEffect(() => {
    if (text.length === 0 && pastes.length === 0) setDismissed(new Set())
  }, [text, pastes.length])

  const items = useMemo((): RedactionHintItem[] => {
    if (!result) return []
    const sources = [result.text, ...result.pastes]
    const seen = new Map<string, RedactionHintItem>()
    result.hints.forEach((list, i) => {
      for (const hint of list ?? []) {
        const value = sources[i]?.slice(hint.start, hint.end)
        if (!value || seen.has(value) || dismissed.has(value) || isHidden(value)) continue
        // 还在文本里（或还在某块粘贴里）才算
        if (!text.includes(value) && !pastes.some((p) => p.includes(value))) continue
        seen.set(value, { value, category: hint.category })
      }
    })
    return [...seen.values()]
  }, [result, dismissed, isHidden, text, pastes])

  const spans = useMemo((): RedactionHintSpan[] => {
    if (!result || result.text !== text) return []
    const shown = new Set(items.map((item) => item.value))
    return (result.hints[0] ?? []).filter((hint) => shown.has(text.slice(hint.start, hint.end)))
  }, [result, text, items])

  const dismiss = useCallback(() => {
    setDismissed((prev) => new Set([...prev, ...items.map((item) => item.value)]))
  }, [items])

  return { items, spans, dismiss }
}
