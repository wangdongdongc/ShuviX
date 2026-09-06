/**
 * useAtMentions —— 聊天输入框 `@` 引用工作区文件（仿笔记本 `[[ ]]` 双链补全）。
 *
 * 与斜杠命令芯片（仅行首单个）不同：`@` 可在输入框任意位置触发、可多个。故不走「芯片 + text-indent」，
 * 而是让 textarea 存明文 `@<token>`，配合 MentionHighlighter 背景镜像画出胶囊（胶囊文字 === 底层文字，
 * 光标天然对齐）。发送时把每处引用就地替换成 {{shuvixInlineToken}} 标记 + 构造 InlineToken
 * （`at` 类型展开为「用户引用了工作区文件 xxx」）。
 *
 * 文件表：files.scan 一次性拉回工作目录路径，建内存 FileMap 后本地过滤（不每次击键回后端），
 * 随 files.changed 事件刷新。查询/排序复用 chat-protocol 的 searchFileMap（与双链同一套）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildFileMap,
  isContentOnlyFileChange,
  searchFileMap,
  type FileMap,
  type FileSuggestion
} from '@shuvix/chat-protocol/utils/fileMap'
import {
  buildAtToken,
  makeTokenMarker,
  type AtFileLike
} from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { getSessionChannelApi } from '../api/chatApi'
import { useAppEvent } from './useAppEvents'

/** 一条已选中的 @ 引用：text 为写入 textarea 的明文（含前导 @），rel/base 供展开与展示 */
export interface AtMention extends AtFileLike {
  /** 写入 textarea 的明文，如 `@src/foo.ts`（含前导 @） */
  text: string
}

/** @ 弹层候选：工作区文件 */
export type AtSuggestion = FileSuggestion

/** textarea 内一处命中的引用区间 [start, end) */
export interface MentionMatch {
  start: number
  end: number
  mention: AtMention
}

const FILE_MAPS = new Map<string, FileMap>()

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 光标左侧最近的有效 `@` 触发；query 为 @ 到光标之间的文本（不含空白）。无则返回 null */
export function findActiveAt(text: string, caret: number): { at: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : ''
      // @ 须在词边界（行首或空白后），避免 email/代码里的 @ 误触发
      if (prev === '' || /\s/.test(prev)) {
        return { at: i, query: text.slice(i + 1, caret) }
      }
      return null
    }
    // 触发到光标之间不允许空白（一遇空白即中断）
    if (/\s/.test(ch)) return null
  }
  return null
}

/**
 * 在文本内定位所有已登记引用的非重叠命中（供背景镜像画胶囊 + 发送时替换）。
 * 长 key 优先（避免 `@a.ts` 抢占 `@a.ts.bak`）；命中须两侧边界成立，
 * 否则视为用户已编辑破坏（如把 `@a.ts` 续写成 `@a.tsx`）→ 降级为普通文字。
 */
export function matchMentions(text: string, mentions: AtMention[]): MentionMatch[] {
  if (mentions.length === 0) return []
  const byText = new Map(mentions.map((m) => [m.text, m]))
  const keys = [...byText.keys()].sort((a, b) => b.length - a.length)
  const re = new RegExp(keys.map(escapeRe).join('|'), 'g')
  const out: MentionMatch[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const prev = start > 0 ? text[start - 1] : ''
    const next = end < text.length ? text[end] : ''
    const prevOk = prev === '' || /\s/.test(prev)
    // 后一字符不能是会延续文件名的字符（词/点/斜杠/连字符）
    const nextOk = next === '' || !/[\w./\\-]/.test(next)
    if (prevOk && nextOk) {
      out.push({ start, end, mention: byText.get(m[0])! })
    } else {
      re.lastIndex = start + 1
    }
  }
  return out
}

export interface UseAtMentions {
  /** 当前触发的补全弹层是否可见 */
  showPopover: boolean
  /** 补全候选（按 searchFileMap 排序） */
  suggestions: AtSuggestion[]
  /** 键盘选中索引 */
  selectedIndex: number
  /** 已登记的引用（供背景镜像渲染） */
  mentions: AtMention[]
  /** 输入/光标变化后重算触发态（onChange / onKeyUp / onClick 调用） */
  refresh: (text: string, caret: number) => void
  /** 文本变化后剪除已不存在的引用 */
  prune: (text: string) => void
  /** 弹层可见时的方向键/Esc 导航；消费返回 true */
  handleKeyDown: (e: React.KeyboardEvent) => boolean
  /** 选中某候选：返回替换后的文本与新光标位置（并登记引用） */
  select: (suggestion: AtSuggestion, text: string, caret: number) => { text: string; caret: number }
  /** 光标紧邻引用尾部时，一次退格整体删除；否则返回 null */
  backspace: (text: string, caret: number) => { text: string; caret: number } | null
  /** 发送时构造标记文本 + at 类型 InlineToken（无引用则原样返回） */
  buildOutgoing: (text: string) => {
    contentText: string
    inlineTokens?: Record<string, InlineToken>
  }
  /** 斜杠命令场景：把引用就地展开为 payload 文本内联进参数（cmd payload 为整条替换，无法混用 token） */
  resolveInline: (text: string) => string
  /** 回退草稿重建：按 at 类型 token 重新登记引用（text=`@displayText`、rel=id），配合明文回填恢复胶囊 */
  restoreFromTokens: (tokens: InlineToken[]) => void
  /** 发送后清空引用登记与触发态 */
  reset: () => void
}

export function useAtMentions(sessionId: string | null): UseAtMentions {
  const [mentions, setMentions] = useState<AtMention[]>([])
  const [trigger, setTrigger] = useState<{ at: number; query: string } | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  // 扫描完成后自增以触发重渲染（文件表本体存模块级 FILE_MAPS，渲染期直接查表——切会话即时生效）
  const [, setScanVersion] = useState(0)

  // 回调内读最新 mentions 而不进依赖数组（避免 refresh/backspace 频繁重建）。
  // 在 effect 中更新 ref（不在渲染期写 ref）——回调都在提交后的事件里触发，ref 已是最新。
  const mentionsRef = useRef(mentions)
  useEffect(() => {
    mentionsRef.current = mentions
  })

  // 切会话即收弹层：InputArea 不按会话重挂，触发态若跨会话存活，A 会话开着的弹层会
  // 带着过期锚点悬在 B 会话上 —— 此时回车在错误位置插胶囊而不是发送；
  // 空草稿的同值 input 事件被 React 去重，靠 refresh 清不掉它
  useEffect(() => {
    // 同步清态是本意：等微任务的话切换后首帧仍会闪一下旧弹层
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrigger(null)
  }, [sessionId])

  // ── 文件表：挂载即扫描，files.changed 时刷新（内存内过滤，不每次击键回后端） ──
  const scan = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    try {
      const r = await getSessionChannelApi().files.scan({ sessionId })
      if (!r.root) return
      FILE_MAPS.set(sessionId, buildFileMap(r.root, r.paths))
      setScanVersion((v) => v + 1)
    } catch {
      /* 扫描失败：@ 引用暂不可用，输入不受影响 */
    }
  }, [sessionId])

  useEffect(() => {
    void scan() // eslint-disable-line react-hooks/set-state-in-effect
  }, [scan])

  // 建表后按 root 过滤（别的会话工作目录的变更与本表无关）；纯内容变更（edit/write 且
  // 路径均已在表中）不改变成员关系 → 跳过；其余防抖 200ms 重扫（对齐 FilesPanel）
  const rescanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useAppEvent('files.changed', (e) => {
    const map = sessionId ? FILE_MAPS.get(sessionId) : null
    if (map) {
      if (e.root !== map.root) return
      if (isContentOnlyFileChange(e, (rel) => map.byRel.has(rel))) return
    }
    if (rescanTimer.current) clearTimeout(rescanTimer.current)
    rescanTimer.current = setTimeout(() => {
      rescanTimer.current = null
      void scan()
    }, 200)
  })
  useEffect(
    () => () => {
      if (rescanTimer.current) clearTimeout(rescanTimer.current)
    },
    []
  )

  // 渲染期从模块级表取当前会话的文件表（切会话即时呈现缓存，scan 回来再刷新）
  const fileMap = sessionId ? (FILE_MAPS.get(sessionId) ?? null) : null

  const suggestions = useMemo<AtSuggestion[]>(() => {
    if (!trigger) return []
    return searchFileMap(fileMap, trigger.query)
  }, [trigger, fileMap])

  const showPopover = trigger !== null && suggestions.length > 0

  const refresh = useCallback((text: string, caret: number): void => {
    const t = findActiveAt(text, caret)
    // 光标恰落在一个完整已登记引用之后（无尾随空白）→ 不重开弹层
    if (t && mentionsRef.current.some((m) => m.text === `@${t.query}`)) {
      setTrigger(null)
      return
    }
    setTrigger((prev) => {
      if (!t) return null
      if (prev && prev.at === t.at && prev.query === t.query) return prev
      setSelectedIndex(0)
      return t
    })
  }, [])

  const prune = useCallback((text: string): void => {
    setMentions((prev) => {
      const next = prev.filter((m) => text.includes(m.text))
      return next.length === prev.length ? prev : next
    })
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showPopover) return false
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
        return true
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i >= suggestions.length - 1 ? 0 : i + 1))
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setTrigger(null)
        return true
      }
      return false
    },
    [showPopover, suggestions.length]
  )

  const select = useCallback(
    (suggestion: AtSuggestion, text: string, caret: number): { text: string; caret: number } => {
      const at = trigger?.at ?? caret
      const before = text.slice(0, at)
      const after = text.slice(caret)
      // 写入 textarea 的明文用「完整文件名」（含扩展名）—— 胶囊即照此原样显示
      // （镜像层字符须与底层一致）。唯一标识/展开正文用 rel，同名不同目录不串味。
      const entry: AtMention = {
        text: `@${suggestion.label}`,
        rel: suggestion.rel,
        base: suggestion.label
      }
      const insert = `${entry.text} `
      setMentions((prev) => (prev.some((m) => m.text === entry.text) ? prev : [...prev, entry]))
      setTrigger(null)
      return { text: before + insert + after, caret: before.length + insert.length }
    },
    [trigger]
  )

  const backspace = useCallback(
    (text: string, caret: number): { text: string; caret: number } | null => {
      if (caret <= 0) return null
      const cands = [...mentionsRef.current].sort((a, b) => b.text.length - a.text.length)
      for (const m of cands) {
        const s = caret - m.text.length
        if (s < 0) continue
        if (text.slice(s, caret) !== m.text) continue
        const prev = s > 0 ? text[s - 1] : ''
        if (prev === '' || /\s/.test(prev)) {
          return { text: text.slice(0, s) + text.slice(caret), caret: s }
        }
      }
      return null
    },
    []
  )

  const buildOutgoing = useCallback(
    (text: string): { contentText: string; inlineTokens?: Record<string, InlineToken> } => {
      const matches = matchMentions(text, mentionsRef.current)
      if (matches.length === 0) return { contentText: text }
      const uidByRel = new Map<string, string>()
      const tokens: Record<string, InlineToken> = {}
      let out = ''
      let last = 0
      let counter = 0
      for (const mt of matches) {
        out += text.slice(last, mt.start)
        let uid = uidByRel.get(mt.mention.rel)
        if (!uid) {
          uid = `a${counter++}`
          uidByRel.set(mt.mention.rel, uid)
          tokens[uid] = buildAtToken(mt.mention)
        }
        out += makeTokenMarker(uid)
        last = mt.end
      }
      out += text.slice(last)
      return { contentText: out, inlineTokens: tokens }
    },
    []
  )

  const resolveInline = useCallback((text: string): string => {
    const matches = matchMentions(text, mentionsRef.current)
    if (matches.length === 0) return text
    let out = ''
    let last = 0
    for (const mt of matches) {
      out += text.slice(last, mt.start) + buildAtToken(mt.mention).payload
      last = mt.end
    }
    return out + text.slice(last)
  }, [])

  const restoreFromTokens = useCallback((tokens: InlineToken[]): void => {
    if (tokens.length === 0) return
    setMentions((prev) => {
      const next = [...prev]
      for (const t of tokens) {
        const entry: AtMention = { text: `@${t.displayText}`, rel: t.id, base: t.displayText }
        if (!next.some((m) => m.text === entry.text)) {
          next.push(entry)
        }
      }
      return next.length === prev.length ? prev : next
    })
  }, [])

  const reset = useCallback((): void => {
    setMentions([])
    setTrigger(null)
  }, [])

  return {
    showPopover,
    suggestions,
    selectedIndex,
    mentions,
    refresh,
    prune,
    handleKeyDown,
    select,
    backspace,
    buildOutgoing,
    resolveInline,
    restoreFromTokens,
    reset
  }
}
