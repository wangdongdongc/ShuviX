/**
 * 用户原话（用户 2026-11-07 的裁定；模型文本与 Token 的形状在 chat-protocol userWords.ts）：父会话给自己的子会话发消息时，
 * 宿主把用户在父会话里自己写的话原样附上，父 agent 改不了。这里定挑哪些、截多长、从哪儿接着：
 *
 *  - **谁收**：由调用方（subSessionRunner）判 —— 只有父会话自己的子会话，且接收方档案声明了 `shuvix-user-words: true`
 *    （内置 coding 开着）。别的会话不收：把一条会话里用户说的话送进另一条，是范围与隐私上的另一回事。
 *  - **收哪些**：人打的消息 —— 没有来源记录（别的会话代发的、触发器替 bot 发的都有记录，认不出的形状也算有）、不是旧会话里
 *    系统写的、不是空白；
 *    点提议发出的也收，标明字是 agent 写的。人对父会话 ask 卡片的回答（父会话自己被代答的不收）。通知本来就不在转写里。
 *  - **从哪儿接着**：这条子会话还没收过 → 父会话当前对话里到目前为止的；收过 → `settings.userWordsThrough` 之后的。
 *    游标只在发送确实落进子会话之后才前移（`markUserWordsSent`），没发出去的下次照样附上。
 *  - **上限**：第一次 = 首条 + 最近 10 条；之后 = 最近 10 条；每条 4000 字，超出从中间截掉并写明截了多少。被省掉的照样
 *    算「附过了」（游标越过它们）—— 否则每次都会再附一遍。
 *  - **文字**：内联 Token 按「复制」的口径（粘贴还原全文，文件 / 命令 / 知识条目是标签，不展开文件内容 —— 子会话要看自己去读）；
 *    用户加的密钥本来就只以占位符出现，子会话拿不到值（密钥表按会话）；图片不带（转写本就丢掉图片）。
 */
import type { QuotedUserWord, UserWordsQuote } from '@shuvix/chat-protocol/userWords'
import { sessionRecords } from './sessionRecords'
import type { TranscriptItem } from './transcriptSource'

export const USER_WORDS_LIMITS = {
  /** 第一次附时保留开头几条（最初的需求） */
  first: 1,
  /** 保留最近几条 */
  recent: 10,
  /** 每条至多多少字（按码点） */
  chars: 4000
} as const

/** 一次要附的：引用本身 + 发出去之后游标该前移到哪 */
export interface UserWordsSelection extends UserWordsQuote {
  /** 这次覆盖到的最后一条的时间戳（含被上限省掉的） */
  through: number
}

/** 截长：保留开头和结尾各一半，中间写明截掉了多少字（按码点，不切开 emoji） */
export function clipWord(text: string, max: number = USER_WORDS_LIMITS.chars): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const half = Math.floor(max / 2)
  return `${chars.slice(0, half).join('')}\n…[${chars.length - 2 * half} characters left out by ShuviX]…\n${chars.slice(-half).join('')}`
}

/** 转写项 → 可引用的用户原话（旧 → 新）。口径见文件头 */
export function userWordsOf(items: readonly TranscriptItem[]): QuotedUserWord[] {
  const out: QuotedUserWord[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      if (item.source !== undefined || item.systemWritten) continue
      if (!item.text.trim()) continue
      out.push({
        kind: 'message',
        ts: item.ts,
        text: item.text,
        ...(item.suggested ? { suggested: true as const } : {})
      })
    } else if (item.kind === 'ask') {
      if (item.answeredBy !== undefined || !item.answer.trim()) continue
      out.push({ kind: 'answer', ts: item.ts, text: item.answer, question: item.question })
    }
  }
  return out
}

/** `through` 之后的那些，套上上限；没有可附的 → undefined */
export function selectUserWords(
  words: readonly QuotedUserWord[],
  sessionId: string,
  through?: number
): UserWordsSelection | undefined {
  const fresh = through === undefined ? [...words] : words.filter((w) => w.ts > through)
  if (fresh.length === 0) return undefined
  const { first, recent } = USER_WORDS_LIMITS
  const kept =
    through === undefined
      ? fresh.length > first + recent
        ? [...fresh.slice(0, first), ...fresh.slice(-recent)]
        : fresh
      : fresh.length > recent
        ? fresh.slice(-recent)
        : fresh
  return {
    sessionId,
    scope: through === undefined ? 'start' : 'since-last',
    words: kept.map((w) => ({ ...w, text: clipWord(w.text) })),
    omitted: fresh.length - kept.length,
    through: fresh.reduce((max, w) => Math.max(max, w.ts), through ?? 0)
  }
}

/** 父会话 `parentId` 里这次该附给子会话 `childId` 的用户原话；读不到转写 → undefined（不挡发送） */
export async function readUserWordsFor(
  parentId: string,
  childId: string
): Promise<UserWordsSelection | undefined> {
  // 没写过的键从库里读出来是 null（JSON 抽取），不是 undefined：只认数字
  const raw: unknown = sessionRecords.pickSettings(childId, ['userWordsThrough'])?.userWordsThrough
  const through = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
  // 读口按需加载：它带着会话宿主一整串依赖，而本模块被 subSessionRunner 静态引入 —— 不在这里拖进去
  const { readSessionTranscript } = await import('./transcriptSource')
  const items = await readSessionTranscript(parentId, { tokens: 'copy' })
  return selectUserWords(userWordsOf(items), parentId, through)
}

/** 附了用户原话的那次发送落进了子会话：游标前移 */
export function markUserWordsSent(childId: string, through: number): void {
  sessionRecords.updateSettings(childId, { userWordsThrough: through })
}
