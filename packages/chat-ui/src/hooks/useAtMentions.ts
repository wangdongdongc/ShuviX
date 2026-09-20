/**
 * useAtMentions —— 聊天输入框 `@` 引用（仿笔记本 `[[ ]]` 双链补全），多源可注册。
 *
 * 与斜杠命令芯片（仅行首单个）不同：`@` 可在输入框任意位置触发、可多个。故不走「芯片 + text-indent」，
 * 而是让 textarea 存明文 `@<token>`，配合 MentionHighlighter 背景镜像画出胶囊（胶囊文字 === 底层文字，
 * 光标天然对齐）。发送时把每处引用就地替换成 {{shuvixInlineToken}} 标记 + 构造 InlineToken
 * （`at` 类型按 ref 分派展开正文：文件给相对路径、知识条目给 knowledge 工具指针）。
 *
 * 多源：`@query` 走默认合并（各就绪源分区展示），`@源:query` 显式路由单个源（findActiveAt 解析）。
 * 候选数据由 provider 体系提供（atMentionProviders.ts：内置 file / knowledge 两源，registry 可扩展）；
 * 本 hook 只做触发解析路由、候选合并与明文登记表，选中/退格/prune/matchMentions 这些明文驱动机制
 * 与单源时代一致。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  atTokenRef,
  buildAtToken,
  makeTokenMarker,
  mentionRefId,
  type AtMentionRef
} from '@shuvix/chat-protocol/utils/inlineTokens'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { getAtMentionProviders, type AtSuggestionItem } from './atMentionProviders'

/** 合并弹层里每个源最多展示的条数（段头小字标题 + 每源 5 条，方向键跨段循环） */
const PER_SOURCE_LIMIT = 5

/** 一条已选中的 @ 引用：text 为写入 textarea 的明文（含前导 @），ref 供构造 token */
export interface AtMention {
  /** 写入 textarea 的明文，如 `@src/foo.ts` / `@knowledge:配置中心`（含前导 @） */
  text: string
  /** 明文去掉前导 @（= token 的 displayText；知识条目可能带消歧后缀） */
  displayText: string
  /** 实体引用（构造 token 所需的全部信息） */
  ref: AtMentionRef
}

/** @ 弹层候选（provider 统一形态） */
export type AtSuggestion = AtSuggestionItem

/** textarea 内一处命中的引用区间 [start, end) */
export interface MentionMatch {
  start: number
  end: number
  mention: AtMention
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 光标左侧最近的有效 `@` 触发；无则返回 null。
 * `@` 到光标之间不允许空白（一遇空白即中断）。`@源:query` 显式路由：文本含 `:` 且前缀命中
 * 已注册源名（sources）→ 回传 source 与冒号后的 query；否则整体作为默认源的 query。
 */
export function findActiveAt(
  text: string,
  caret: number,
  sources: readonly string[] = []
): { at: number; source?: string; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '@') {
      const prev = i > 0 ? text[i - 1] : ''
      // @ 须在词边界（行首或空白后），避免 email/代码里的 @ 误触发
      if (prev !== '' && !/\s/.test(prev)) return null
      const raw = text.slice(i + 1, caret)
      const colon = raw.indexOf(':')
      if (colon > 0) {
        const prefix = raw.slice(0, colon)
        if (sources.includes(prefix)) {
          return { at: i, source: prefix, query: raw.slice(colon + 1) }
        }
      }
      return { at: i, query: raw }
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

/**
 * 由候选构造登记表项（选中与单测共用）。明文撞上已登记的**另一目标**且候选带了消歧内容时，
 * 自动加 ` (suffix)` 后缀（知识条目标题跨库重名）——胶囊文字与底层明文逐字一致的原则不破。
 */
export function buildMentionEntry(
  suggestion: AtSuggestionItem,
  existing: readonly AtMention[]
): AtMention {
  let displayText = suggestion.displayText
  if (
    suggestion.disambiguator &&
    existing.some(
      (m) => m.text === `@${displayText}` && mentionRefId(m.ref) !== mentionRefId(suggestion.ref)
    )
  ) {
    displayText = `${displayText} (${suggestion.disambiguator})`
  }
  return { text: `@${displayText}`, displayText, ref: suggestion.ref }
}

export interface UseAtMentions {
  /** 当前触发的补全弹层是否可见 */
  showPopover: boolean
  /** 补全候选（合并模式按源分区、每源 ≤5；显式路由只出该源） */
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
  /** 回退草稿重建：按 at 类型 token 重新登记引用（text=`@displayText`），配合明文回填恢复胶囊 */
  restoreFromTokens: (tokens: InlineToken[]) => void
  /** 发送后清空引用登记与触发态 */
  reset: () => void
}

export function useAtMentions(sessionId: string | null): UseAtMentions {
  const [mentions, setMentions] = useState<AtMention[]>([])
  const [trigger, setTrigger] = useState<{ at: number; source?: string; query: string } | null>(
    null
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  // provider 数据到达后自增以触发重渲染（数据本体在 provider 的模块级缓存，渲染期直接查——切会话即时生效）
  const [dataVersion, setDataVersion] = useState(0)

  const providers = getAtMentionProviders()

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

    setTrigger(null)
  }, [sessionId])

  // ── provider 数据：挂载/切会话即确保加载；数据变化 bump 渲染 ──
  useEffect(() => {
    if (!sessionId) return
    for (const p of providers) p.load(sessionId)
  }, [sessionId, providers])

  useEffect(() => {
    const unsubs = providers.map((p) => p.subscribe(() => setDataVersion((v) => v + 1)))
    return () => {
      for (const u of unsubs) u()
    }
  }, [providers])

  const suggestions = useMemo<AtSuggestion[]>(() => {
    if (!trigger || !sessionId) return []
    // 显式路由：只出该源
    if (trigger.source) {
      const p = providers.find((p) => p.source === trigger.source)
      return p && p.ready(sessionId) ? p.search(sessionId, trigger.query, PER_SOURCE_LIMIT) : []
    }
    // 默认合并：各就绪源分区（顺序 = registry 注册序），每源 ≤ PER_SOURCE_LIMIT
    return providers
      .filter((p) => p.ready(sessionId))
      .flatMap((p) => p.search(sessionId, trigger.query, PER_SOURCE_LIMIT))
    // dataVersion 驱动重算：provider 数据到达/重扫后 trigger 未变也要刷新候选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, sessionId, providers, dataVersion])

  const showPopover = trigger !== null && suggestions.length > 0

  const refresh = useCallback(
    (text: string, caret: number): void => {
      const t = findActiveAt(
        text,
        caret,
        providers.map((p) => p.source)
      )
      // 光标恰落在一个完整已登记引用之后（无尾随空白）→ 不重开弹层
      if (t && mentionsRef.current.some((m) => m.text === text.slice(t.at, caret))) {
        setTrigger(null)
        return
      }
      setTrigger((prev) => {
        if (!t) return null
        if (prev && prev.at === t.at && prev.query === t.query && prev.source === t.source) {
          return prev
        }
        setSelectedIndex(0)
        return t
      })
    },
    [providers]
  )

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
      // 写入 textarea 的明文与胶囊逐字一致（镜像层字符须与底层一致）。知识条目标题重名时
      // buildMentionEntry 自动加消歧后缀；唯一标识/展开正文用 ref，同名不同库不串味。
      const entry = buildMentionEntry(suggestion, mentionsRef.current)
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
      const uidByRef = new Map<string, string>()
      const tokens: Record<string, InlineToken> = {}
      let out = ''
      let last = 0
      let counter = 0
      for (const mt of matches) {
        out += text.slice(last, mt.start)
        const refId = mentionRefId(mt.mention.ref)
        let uid = uidByRef.get(refId)
        if (!uid) {
          uid = `a${counter++}`
          uidByRef.set(refId, uid)
          tokens[uid] = buildAtToken(mt.mention.ref, mt.mention.displayText)
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
      out +=
        text.slice(last, mt.start) + buildAtToken(mt.mention.ref, mt.mention.displayText).payload
      last = mt.end
    }
    return out + text.slice(last)
  }, [])

  const restoreFromTokens = useCallback((tokens: InlineToken[]): void => {
    if (tokens.length === 0) return
    setMentions((prev) => {
      const next = [...prev]
      for (const t of tokens) {
        // 按 token 反推实体引用（知识条目恢复 base/path 指针，文件与存量逐字一致），
        // 重建的引用发送时能构造出等价 payload —— 回退草稿里的引用仍是「活的」
        const entry: AtMention = {
          text: `@${t.displayText}`,
          displayText: t.displayText,
          ref: atTokenRef(t)
        }
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
