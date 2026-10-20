/**
 * 「还有没有会话指着这个工作目录」—— `sessionDao.existsWithWorkingDirectory(dir)`（它上面加上活着的内存会话的
 * `sessionRecords.existsWithWorkingDirectory` 在 services/__tests__/sessionRecordsWorkingDirectory.test.ts）。会话 fork 共用源会话的临时
 * 工作区，删除一条会话时 sessionService 据此判断那个目录还有没有人用：答错成「有」只是留下一个临时目录，
 * 答错成「没有」就会删掉别的会话正在用的文件夹。
 *
 * 契约（dao 的注释）：只比 `settings.workingDirectory` 这一个键，**整串相等**（不是前缀、不是 LIKE、
 * 区分大小写）；坏 JSON 的行跳过，不让整条查询抛掉。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 sessionDaoChromeTab.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。坏 JSON 的行经 UPDATE 直接写进 settings 列。
 *
 *   DW-1  整串相等 → true；没有这样的行 → false
 *   DW-2  不认前缀 / 子目录 / 结尾斜杠 / 大小写不同（两个方向都试）
 *   DW-3  只认 workingDirectory 这个键：同一串写在 notebookPath / allowList / 嵌套对象里 / 非字符串值 → false
 *   DW-4  坏 JSON（`{bad`）、`{}`、空串的行跳过、不抛；另有一行真匹配时照样 true
 *   DW-5  没有 LIKE 语义（`_` / `%` 不是通配）；空格、引号、反斜杠、中文与重音字符原样往返
 *   DW-6  唯一指着它的那一行删掉之后 → false
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../database', () => {
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

import { migrations } from '../migrations'
import { sessionDao } from '../sessionDao'
import type { Session, SessionSettings } from '../types'

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

function insert(id: string, settings: SessionSettings): void {
  sessionDao.insert(session(id, settings))
}

/** 越过 DAO 直接把 settings 列写成任意文本（坏 JSON / 空串） */
function writeRawSettings(id: string, raw: string): void {
  insert(id, {})
  ;(holder.db as DatabaseSync).prepare('UPDATE sessions SET settings = ? WHERE id = ?').run(raw, id)
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
})

describe('DW-1 exact match', () => {
  it('DW-1 a row whose settings.workingDirectory is exactly dir → true', () => {
    insert('fork', { enabledTools: [], workingDirectory: DIR })
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(true)
  })

  it('DW-1 no such row (empty table, or rows without the key) → false', () => {
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
    insert('plain', { enabledTools: [] })
    insert('other', { workingDirectory: '/somewhere/else' })
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
  })
})

describe('DW-2 no prefix / descendant / trailing-slash / case match', () => {
  it.each<[string, string]>([
    ['stored is a descendant of the query (prefix query)', `${DIR}/sub`],
    ['stored has a trailing slash', `${DIR}/`],
    ['stored differs only in case', DIR.toUpperCase()],
    ['stored is the parent of the query', DIR.slice(0, DIR.lastIndexOf('/'))],
    ['stored shares a prefix of the last segment', `${DIR}x`]
  ])('DW-2 %s → false', (_label, stored) => {
    insert('row', { workingDirectory: stored })
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
  })

  it('DW-2 the other direction: a row at DIR does not answer for its parent, a child, DIR/ or a case variant', () => {
    insert('row', { workingDirectory: DIR })
    expect(sessionDao.existsWithWorkingDirectory(DIR.slice(0, DIR.lastIndexOf('/')))).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory(`${DIR}/sub`)).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory(`${DIR}/`)).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory(DIR.toUpperCase())).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory('')).toBe(false)
  })
})

describe('DW-3 only the workingDirectory key counts', () => {
  it.each<[string, SessionSettings]>([
    ['the same string in notebookPath', { notebookPath: DIR }],
    ['the same string inside allowList', { allowList: [DIR, `Read(${DIR})`] }],
    [
      'a nested object carrying a workingDirectory key',
      {
        model: { provider: 'p', modelId: 'm', workingDirectory: DIR }
      } as unknown as SessionSettings
    ],
    ['workingDirectory as an array holding the string', { workingDirectory: [DIR] } as never],
    [
      'workingDirectory as an object holding the string',
      { workingDirectory: { dir: DIR } } as never
    ]
  ])('DW-3 %s → false', (_label, settings) => {
    insert('row', settings)
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
  })

  it('DW-3 a numeric workingDirectory does not equal its string spelling', () => {
    insert('row', { workingDirectory: 1 } as never)
    expect(sessionDao.existsWithWorkingDirectory('1')).toBe(false)
  })
})

describe('DW-4 bad JSON rows are skipped', () => {
  it.each(['{bad', '{}', '', '[1,2', 'null', '"just a string"'])(
    'DW-4 a row with settings %j → no throw, false on its own; a real match beside it → true',
    (raw) => {
      writeRawSettings('broken', raw)
      expect(() => sessionDao.existsWithWorkingDirectory(DIR)).not.toThrow()
      expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
      insert('fork', { workingDirectory: DIR })
      expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(true)
    }
  )

  it('DW-4 the bad row is inserted after the match too (order in the table does not matter)', () => {
    insert('fork', { workingDirectory: DIR })
    writeRawSettings('broken-1', '{bad')
    writeRawSettings('broken-2', '')
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(true)
  })
})

describe('DW-5 literal comparison', () => {
  it('DW-5 `_` and `%` are not wildcards', () => {
    insert('underscore', { workingDirectory: '/a/b_c' })
    insert('percent', { workingDirectory: '/a/%' })
    expect(sessionDao.existsWithWorkingDirectory('/a/bXc')).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory('/a/anything')).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory('/a/')).toBe(false)
    expect(sessionDao.existsWithWorkingDirectory('/a/b_c')).toBe(true)
    expect(sessionDao.existsWithWorkingDirectory('/a/%')).toBe(true)
  })

  it.each([
    '/Users/me/My Documents/temp_workspace/s 1',
    `/Users/me/it's "quoted"/x`,
    '/Users/me/back\\slash',
    '/Users/me/文档/工作区',
    '/Users/me/café/ñ',
    '/Users/me/$.workingDirectory'
  ])('DW-5 %j round-trips', (dir) => {
    insert('row', { workingDirectory: dir })
    expect(sessionDao.existsWithWorkingDirectory(dir)).toBe(true)
  })
})

describe('DW-6 after the delete', () => {
  it('DW-6 deleting the only referencing row → false; a second reference keeps it true until both are gone', () => {
    insert('a', { workingDirectory: DIR })
    insert('b', { workingDirectory: DIR })
    sessionDao.deleteById('a')
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(true)
    sessionDao.deleteById('b')
    expect(sessionDao.existsWithWorkingDirectory(DIR)).toBe(false)
  })
})
