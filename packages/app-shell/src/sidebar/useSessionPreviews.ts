import { useEffect, useMemo, useRef, useState } from 'react'
import { getChatApi, type ChatMessage, type Session } from '@shuvix/chat-ui'

/** 一屏会话列表里取摘要的上限：每条都是一次 `message.list`（整段对话的投影），不给无限条 */
const PREVIEW_LIMIT = 30
/** 摘要留多长（两行字用不了更多） */
const PREVIEW_CHARS = 160

/**
 * 一段回复压成一行纯文字：代码围栏整块去掉（摘要里放半截代码没有意义，没闭合的也算到末尾），图片去掉，
 * 链接只留字，markdown 的记号去掉，空白折成一个空格。
 *
 * 记号只在它是记号的位置去掉：`*` / `_` 成对包着字才算强调（`2*3` 留着；`_` 还得不在词中间，`my_file.py` 留着），
 * `#` / `>` 只认行首。
 */
function plainPreview(raw: string): string {
  return raw
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}|>+)[ \t]*/gm, '')
    .replace(/`+/g, '')
    .replace(/(\*\*|\*)(?=\S)([^*\n]+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\p{L}\p{N}])(__|_)(?=\S)([^_\n]+?)(?<=\S)\1(?![\p{L}\p{N}])/gu, '$2')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 系统写的"用户消息"（后台完成通知、指令文件注入）和压缩摘要不是谁说的话，不拿来当摘要 */
function spoken(m: ChatMessage): boolean {
  const meta = m.metadata as
    | { isSystemNotice?: boolean; isInstructionInjection?: boolean; isCompactionSummary?: boolean }
    | undefined
  return !(meta?.isSystemNotice || meta?.isInstructionInjection || meta?.isCompactionSummary)
}

/**
 * 一条会话的摘要：最后那张**压完还有字**的助手卡片；没有就取最后一条有字的用户消息；都没有 → null。
 * 最后一张回复只有一张图 / 一段代码时往前找，不让这一行空着。
 */
export function sessionPreviewText(messages: ChatMessage[]): string | null {
  const pick = (role: 'assistant' | 'user'): string | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== role || typeof m.content !== 'string' || !spoken(m)) continue
      const text = plainPreview(m.content)
      if (text) return text
    }
    return null
  }
  const text = pick('assistant') ?? pick('user')
  // 按字符（码点）截：按 UTF-16 截会把一个表情切成半个
  return text ? Array.from(text).slice(0, PREVIEW_CHARS).join('') : null
}

/** 一条会话里此刻还没答的那个选择题（`ask` 工具的调用还没有结果）：问题那一句；没有 → null */
export function sessionPendingQuestion(messages: ChatMessage[]): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return null
  for (const block of last.blocks ?? []) {
    if (block.type !== 'tool' || block.toolName !== 'ask' || block.result !== undefined) continue
    const question = block.args?.question
    if (typeof question !== 'string') continue
    const text = plainPreview(question)
    if (text) return Array.from(text).slice(0, PREVIEW_CHARS).join('')
  }
  return null
}

/** 一条会话取回来的那一份：最后一条回复的摘要，和（有的话）此刻在等你回答的那个问题 */
export interface SessionDigest {
  text: string | null
  question: string | null
}

const EMPTY_DIGEST: SessionDigest = { text: null, question: null }

/**
 * 会话列表各行的摘要（手机布局的会话列表：标题下面那两行灰字）—— 会话 id → 那一份；还没读到的不在表里，
 * 读到了但没有字的是 `{ text: null, question: null }`。
 *
 * `stamps` 是每条会话「内容此刻的版本」（调用方拼：最后动手的时间、在不在跑、未读从哪一刻起、有几个询问）：它变了才重取 ——
 * 一轮跑完（在跑 → 不在跑）正是回复写完的那一刻。重取期间留着上一份摘要，不闪成空；
 * 取失败的那一条不记账，列表下一次变化时重取。
 */
export function useSessionDigests(
  sessions: Session[],
  stamps: Record<string, string>,
  enabled: boolean
): Record<string, SessionDigest> {
  const [digests, setDigests] = useState<Record<string, SessionDigest>>({})
  const requested = useRef(new Map<string, string>())
  useEffect(() => {
    if (!enabled) return
    for (const session of sessions.slice(0, PREVIEW_LIMIT)) {
      const stamp = stamps[session.id] ?? ''
      if (requested.current.get(session.id) === stamp) continue
      requested.current.set(session.id, stamp)
      // 回来时这一份已经不是最新要的那一份（中间戳又变过）→ 丢掉，不让旧的盖住新的
      const current = (): boolean => requested.current.get(session.id) === stamp
      getChatApi()
        .message.list(session.id)
        .then((messages) => {
          if (!current()) return
          const digest: SessionDigest = {
            text: sessionPreviewText(messages),
            question: sessionPendingQuestion(messages)
          }
          setDigests((prev) => ({ ...prev, [session.id]: digest }))
        })
        .catch(() => {
          if (!current()) return
          // 没取到：忘掉这一次，列表下一次有动静时再取（断线重连之后不至于一直空着）
          requested.current.delete(session.id)
          setDigests((prev) =>
            session.id in prev ? prev : { ...prev, [session.id]: EMPTY_DIGEST }
          )
        })
    }
  }, [sessions, stamps, enabled])
  return digests
}

/** 只要摘要那一句的调用方：会话 id → 摘要（没有字的是 null；还没读到的不在表里） */
export function useSessionPreviews(
  sessions: Session[],
  stamps: Record<string, string>,
  enabled: boolean
): Record<string, string | null> {
  const digests = useSessionDigests(sessions, stamps, enabled)
  return useMemo(() => {
    const out: Record<string, string | null> = {}
    for (const [id, digest] of Object.entries(digests)) out[id] = digest.text
    return out
  }, [digests])
}
