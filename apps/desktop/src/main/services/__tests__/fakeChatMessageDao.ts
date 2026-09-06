/**
 * `chatMessageDao` 的内存替身（单测用）。
 *
 * 为什么需要它：真 DAO 一经导入就会把 `dao/database` 拉进模块图，而 `DatabaseManager`
 * 的**构造函数**就打开 sqlite —— better-sqlite3 的原生绑定是按 Electron ABI 编译的，
 * vitest（node）加载不了。仓里既有的做法就是把 DAO 整个 mock 掉，被替换的模块连同它的
 * import 一起不再求值。
 *
 * 行为与真 DAO 对齐到「测试关心的那部分」：seq 会话内单调、按 seq 升序、回退删区间、
 * 附件描述符原样带过。用法：
 *
 * ```ts
 * vi.mock('../../dao/chatMessageDao', async () => await import('./fakeChatMessageDao'))
 * ```
 *
 * 需要断言存了什么的用例，直接 import 本模块读 `__rows` / 调 `__reset`。
 */
import type { ChatMessageInsert, ChatMessageRow } from '../../dao/types/chatMessage'

let rows: ChatMessageRow[] = []
let counter = 0

export const chatMessageDao = {
  findBySession(sessionId: string): ChatMessageRow[] {
    return rows.filter((r) => r.sessionId === sessionId).sort((a, b) => a.seq - b.seq)
  },
  findTail(sessionId: string, limit: number): ChatMessageRow[] {
    const all = chatMessageDao.findBySession(sessionId)
    return all.slice(Math.max(0, all.length - limit))
  },
  findAfterSeq(sessionId: string, seq: number): ChatMessageRow[] {
    return chatMessageDao.findBySession(sessionId).filter((r) => r.seq > seq)
  },
  findById(id: string): ChatMessageRow | undefined {
    return rows.find((r) => r.id === id)
  },
  append(input: ChatMessageInsert): ChatMessageRow {
    const seq = chatMessageDao.findBySession(input.sessionId).length + 1
    const row: ChatMessageRow = {
      ...input,
      id: input.id ?? `fake-msg-${++counter}`,
      seq,
      // hop 是遗留列（接力已取消）：真 DAO 缺省写 0，这里同口径
      hop: input.hop ?? 0,
      createdAt: Date.now()
    }
    rows.push(row)
    return row
  },
  countBySession(sessionId: string): number {
    return chatMessageDao.findBySession(sessionId).length
  },
  deleteFromMessage(sessionId: string, messageId: string): ChatMessageRow[] {
    const target = rows.find((r) => r.id === messageId && r.sessionId === sessionId)
    if (!target) return []
    const doomed = chatMessageDao.findBySession(sessionId).filter((r) => r.seq >= target.seq)
    const ids = new Set(doomed.map((r) => r.id))
    rows = rows.filter((r) => !ids.has(r.id))
    return doomed
  },
  deleteBySession(sessionId: string): void {
    rows = rows.filter((r) => r.sessionId !== sessionId)
  }
}

/** 仅供测试：读全部行 */
export function __rows(): ChatMessageRow[] {
  return rows
}

/** 仅供测试：清空（beforeEach 调用，用例之间不串味） */
export function __reset(): void {
  rows = []
  counter = 0
}
