/**
 * 「这条会话是不是切换前的旧格式（`harness-v3-jsonl`，只读）会话」—— 桌面端唯一的判断处（存储路由
 * `sessionStorage.ts` 的 `storageRoute` 自己分流，不经这里）。messageService、transcriptSource 与同步
 * 接缝（syncWiring 的 `legacyViewOf`）都问它，口径因此只有一份。
 *
 * 单独一个模块而不放进 sessionStorage.ts：后者在大量单测里被整体 mock，判断放这里，那些 mock 不必跟着改。
 */
import { HARNESS_V3_JSONL, storageKindOf } from '@shuvix/chat-protocol/sessionStorageKind'
import { sessionRecords } from './sessionRecords'

export interface LegacySessionQuery {
  /**
   * 查不到行时怎么答。缺省（false）按 `storageKindOf` 的缺省口径读成旧格式 —— messageService /
   * transcriptSource 一直如此；true 时查不到行答 false（同步视图与清空要的口径：没有行就没有旧格式视图，
   * 也没有存储类型可换）。
   */
  rowRequired?: boolean
}

/** 这条会话是不是旧格式（只读）会话；查不到行的口径见 `LegacySessionQuery.rowRequired` */
export function isLegacySession(sessionId: string, query: LegacySessionQuery = {}): boolean {
  const row = sessionRecords.pick(sessionId, ['storageKind'])
  if (row === undefined && query.rowRequired === true) return false
  return storageKindOf(row ?? {}) === HARNESS_V3_JSONL
}
