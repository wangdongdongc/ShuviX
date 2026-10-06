/**
 * `isLegacySession` —— 桌面端唯一的「旧格式（只读）会话」判断（P4-03）。messageService、transcriptSource、
 * syncWiring 的 `legacyViewOf` 都经它；这里钉住它的两种口径：
 *
 *   P4-03-01  行是 `harness-v3-jsonl`，或存储类型缺省（v30 之前的行）→ true
 *   P4-03-02  新格式行、不认识的存储类型（更新的版本写的）→ false
 *   P4-03-03  查不到行：缺省按 storageKindOf 的口径读成旧格式（true）；`rowRequired` → false
 *   P4-03-04  只读 `storageKind` 一列
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const holder = vi.hoisted(() => ({
  rows: new Map<string, { storageKind?: string | null }>(),
  pick: vi.fn()
}))

vi.mock('../sessionRecords', () => ({
  sessionRecords: {
    pick: (id: string, fields: string[]) => {
      holder.pick(id, fields)
      const row = holder.rows.get(id)
      return row
        ? Object.fromEntries(fields.map((f) => [f, row[f as keyof typeof row]]))
        : undefined
    }
  }
}))

import { isLegacySession } from '../legacySession'

beforeEach(() => {
  holder.rows.clear()
  holder.pick.mockClear()
})

describe('isLegacySession', () => {
  it('P4-03-01 旧格式行 / 存储类型缺省 → true（两种口径一致）', () => {
    holder.rows.set('old', { storageKind: 'harness-v3-jsonl' })
    holder.rows.set('implicit', { storageKind: null })
    holder.rows.set('absent', {})
    for (const id of ['old', 'implicit', 'absent']) {
      expect(isLegacySession(id), id).toBe(true)
      expect(isLegacySession(id, { rowRequired: true }), id).toBe(true)
    }
  })

  it('P4-03-02 新格式行、不认识的存储类型 → false（两种口径一致）', () => {
    holder.rows.set('new', { storageKind: 'durable-sqlite-1' })
    holder.rows.set('future', { storageKind: 'durable-sqlite-9' })
    holder.rows.set('empty', { storageKind: '' })
    for (const id of ['new', 'future', 'empty']) {
      expect(isLegacySession(id), id).toBe(false)
      expect(isLegacySession(id, { rowRequired: true }), id).toBe(false)
    }
  })

  it('P4-03-03 查不到行：缺省读成旧格式；rowRequired → false', () => {
    expect(isLegacySession('missing')).toBe(true)
    expect(isLegacySession('missing', {})).toBe(true)
    expect(isLegacySession('missing', { rowRequired: false })).toBe(true)
    expect(isLegacySession('missing', { rowRequired: true })).toBe(false)
  })

  it('P4-03-04 只读 storageKind 一列', () => {
    holder.rows.set('old', { storageKind: 'harness-v3-jsonl' })
    isLegacySession('old', { rowRequired: true })
    expect(holder.pick).toHaveBeenCalledTimes(1)
    expect(holder.pick).toHaveBeenCalledWith('old', ['storageKind'])
  })
})
