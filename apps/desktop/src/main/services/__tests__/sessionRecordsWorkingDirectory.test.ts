/**
 * `sessionRecords.existsWithWorkingDirectory(dir)` —— 库里的行（`sessionDao.existsWithWorkingDirectory`，
 * 见 dao/__tests__/sessionDaoWorkingDirectory.test.ts）再加上**活着的内存会话**（md 窗口）。删除一条会话时
 * sessionService 据此判断一个临时工作区还有没有人用：一个开着的 md 窗口若正以它为工作目录，它就还有人用。
 *
 * 真的 SQLite（node:sqlite 内存库跑全部迁移），sessionRecords / sessionDao 都是真的。
 *
 *   RW-1  活着的内存会话指着它 → true（库里没有这样的行）；那条内存会话删掉之后 → false
 *   RW-2  内存会话同样只认整串相等的 workingDirectory 键（子目录 / 结尾斜杠 / 别的键都不算）
 *   RW-3  内存会话不匹配、库里一行匹配 → true；库里那行删掉 → false
 *   RW-4  库里一行坏 JSON 不让它抛
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../../dao/database', () => {
  class BaseDao {
    protected get db(): { prepare: (sql: string) => unknown } {
      return holder.db as { prepare: (sql: string) => unknown }
    }
    protected stmt(sql: string): unknown {
      return (holder.db as { prepare: (sql: string) => unknown }).prepare(sql)
    }
  }
  return { BaseDao, databaseManager: { getDb: () => holder.db } }
})
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../../dao/migrations'
import { sessionDao } from '../../dao/sessionDao'
import type { Session, SessionSettings } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const DIR = '/Users/me/Library/Application Support/shuvix/temp_workspace/019a-src'

function session(id: string, settings: SessionSettings): Session {
  return {
    id,
    title: id,
    projectId: null,
    parentId: null,
    settings,
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  sessionRecords.clearEphemeralForTests()
})

describe('RW sessionRecords adds the live in-memory sessions', () => {
  it('RW-1 a live in-memory session pointing at dir → true with no stored row; after its delete → false', () => {
    sessionRecords.insert(session('md-window', { workingDirectory: DIR }), { ephemeral: true })
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(true)

    sessionRecords.deleteById('md-window')
    expect(sessionRecords.isEphemeral('md-window')).toBe(false)
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(false)
  })

  it('RW-2 in-memory sessions use the same exact-match rule (no subfolder, no trailing slash, other keys ignored)', () => {
    sessionRecords.insert(session('m1', { workingDirectory: `${DIR}/sub` }), { ephemeral: true })
    sessionRecords.insert(session('m2', { workingDirectory: `${DIR}/` }), { ephemeral: true })
    sessionRecords.insert(session('m3', { notebookPath: DIR }), { ephemeral: true })
    sessionRecords.insert(session('m4', { knowledgeBases: [DIR] }), { ephemeral: true })
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(false)
    expect(sessionRecords.existsWithWorkingDirectory(`${DIR}/sub`)).toBe(true)
  })

  it('RW-3 in-memory non-match + stored match → true; deleting the stored row → false', () => {
    sessionRecords.insert(session('md-window', { workingDirectory: '/Users/me/docs' }), {
      ephemeral: true
    })
    sessionRecords.insert(session('fork', { workingDirectory: DIR }))
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(true)

    sessionRecords.deleteById('fork')
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(false)
    expect(sessionRecords.existsWithWorkingDirectory('/Users/me/docs')).toBe(true)
  })

  it('RW-4 a bad-JSON stored row does not make it throw', () => {
    sessionRecords.insert(session('broken', {}))
    ;(holder.db as DatabaseSync)
      .prepare('UPDATE sessions SET settings = ? WHERE id = ?')
      .run('{bad', 'broken')
    expect(() => sessionRecords.existsWithWorkingDirectory(DIR)).not.toThrow()
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(false)
    sessionRecords.insert(session('md-window', { workingDirectory: DIR }), { ephemeral: true })
    expect(sessionRecords.existsWithWorkingDirectory(DIR)).toBe(true)
  })
})
