/**
 * 迁移 v38 —— bot 会话只归属 bot：在项目里建的 bot 根会话（连同它的直接子会话）不再是项目的成员，`projectId` 挪进
 * `settings.workProject`（工作位置的引用），另记项目路径快照 `settings.workingDirectory`；触发器开出来的 bot 根会话
 * 打上 `settings.triggerRun`。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 migrationV36.test）：按顺序跑 v1 起的每一个 up()。MV38-1 走真的
 * runMigrations（user_version 从 37 推到最新），用的是同一个 better-sqlite3 薄壳。
 *
 *   MV38-1  v37 库 → 最新：项目里的 bot 根会话与它的直接子会话 projectId → NULL、workProject = 原项目、workingDirectory =
 *           项目此刻的路径（旧值被换掉）；别的设置键原样；bot 名带空白也认；别的表不动
 *   MV38-2  该原样的行逐字节不变：普通项目会话、笔记本 bot、Chrome 标签页 bot、空白 / 非字符串的 bot、普通会话的子会话、
 *           父会话不是 bot 根的 bot 子会话、孙会话、不在项目里的 bot 会话、坏 JSON / 数组 / null 设置（不抛）、
 *           **被挪走的根下面那条坏 JSON 的子会话**；悬空的项目 → 写 workProject、不写 workingDirectory
 *   MV38-3  triggerRun：bot 根会话最早一条（按 timestamp，不按插入次序）非 'created' 条目来自 trigger → 标上；
 *           最早的是别的来源 / 只有 'created' 行 / 没有条目 / origin 为 NULL / 不是 bot / 是子会话 / 是笔记本 /
 *           坏 JSON → 不标；已经标过的行原样；项目里的触发会话两个键都拿到
 *   MV38-4  再跑一遍 v38（user_version 被拨回 37）：整张会话表与第一次跑完一模一样；runMigrations 在最新版本上什么都不做
 */
import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations, runMigrations } from '../migrations'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

/** 按顺序跑迁移到 upTo（含） */
function migrate(db: DatabaseSync, upTo: number): void {
  for (const m of migrations) {
    if (m.version > upTo) break
    m.up(db as unknown as Db)
  }
}

const v38 = (): (typeof migrations)[number] => migrations.find((m) => m.version === 38)!

/** runMigrations 用到的 better-sqlite3 面：prepare / exec / pragma / transaction */
function betterSqliteShim(db: DatabaseSync): Parameters<typeof runMigrations>[0] {
  return {
    prepare: (sql: string) => db.prepare(sql),
    exec: (sql: string) => db.exec(sql),
    pragma: (source: string, opts?: { simple?: boolean }) => {
      if (source.includes('=')) {
        db.exec(`PRAGMA ${source}`)
        return []
      }
      const row = db.prepare(`PRAGMA ${source}`).get() as Row
      return opts?.simple ? Object.values(row)[0] : [row]
    },
    transaction: (fn: () => void) => () => {
      db.exec('BEGIN')
      try {
        fn()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  } as unknown as Parameters<typeof runMigrations>[0]
}

const userVersion = (db: DatabaseSync): number =>
  (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version

/** 一个跑到 v37 的库（user_version = 37），带两个项目 */
function v37Db(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  migrate(db, 37)
  db.exec('PRAGMA user_version = 37')
  insertProject(db, 'p1', '/work/p1')
  insertProject(db, 'p2', '/work/p2')
  return db
}

function insertProject(db: DatabaseSync, id: string, path: string): void {
  db.prepare(
    'INSERT INTO projects (id, name, path, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, id.toUpperCase(), path, '{}', 1, 1)
}

/** 插一条会话；settings 给对象就序列化，给字符串原样落（坏 JSON / 数组之类） */
function insertSession(
  db: DatabaseSync,
  id: string,
  opts: { projectId?: string | null; parentId?: string | null; settings?: unknown } = {}
): void {
  const settings =
    typeof opts.settings === 'string' ? opts.settings : JSON.stringify(opts.settings ?? {})
  db.prepare(
    'INSERT INTO sessions (id, title, projectId, parentId, settings, createdAt, updatedAt, lastActiveAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, `title ${id}`, opts.projectId ?? null, opts.parentId ?? null, settings, 10, 20, 30)
}

/** 日历一行（session_day_prompts）；origin 为 null 即 v34 之前没记来源的那种 */
function insertPrompt(
  db: DatabaseSync,
  sessionId: string,
  entryId: string,
  timestamp: number,
  origin: string | null
): void {
  db.prepare(
    'INSERT INTO session_day_prompts (sessionId, entryId, day, timestamp, origin) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, entryId, '2026-10-30', timestamp, origin)
}

/** 整行（含原样的 settings 字符串） */
const rowOf = (db: DatabaseSync, id: string): Row =>
  db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row

const settingsOf = (db: DatabaseSync, id: string): Record<string, unknown> =>
  JSON.parse(String(rowOf(db, id).settings))

const allSessions = (db: DatabaseSync): Row[] =>
  db.prepare('SELECT * FROM sessions ORDER BY id').all() as Row[]

describe('迁移 v38：bot 会话只归属 bot', () => {
  it('MV38-1 项目里的 bot 根会话与它的直接子会话挪成引用 + 路径快照；别的设置键原样；别的表不动', () => {
    const db = v37Db()
    insertSession(db, 'R1', {
      projectId: 'p1',
      settings: {
        bot: 'scout',
        enabledTools: ['mcp:a'],
        knowledgeBases: ['notes'],
        workingDirectory: '/stale'
      }
    })
    insertSession(db, 'C1', {
      projectId: 'p1',
      parentId: 'R1',
      settings: { enabledTools: [], agentProfile: 'coding' }
    })
    insertSession(db, 'R2', { projectId: 'p2', settings: { bot: '  pal  ' } })
    insertPrompt(db, 'R1', 'e1', 5, 'local')
    db.prepare(
      "INSERT INTO session_acl (id, sessionId, kind, target, access, source, sourceKey, createdAt, updatedAt) VALUES ('a1', 'R1', 'path', '/work/p1', 'write', 'workdir', '', 1, 1)"
    ).run()
    const promptsBefore = db.prepare('SELECT * FROM session_day_prompts').all()
    const aclBefore = db.prepare('SELECT * FROM session_acl').all()
    const projectsBefore = db.prepare('SELECT * FROM projects').all()

    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 37)
    expect(userVersion(db)).toBe(migrations.at(-1)!.version)

    const r1 = rowOf(db, 'R1')
    expect(r1.projectId).toBeNull()
    expect(settingsOf(db, 'R1')).toEqual({
      bot: 'scout',
      enabledTools: ['mcp:a'],
      knowledgeBases: ['notes'],
      workingDirectory: '/work/p1',
      workProject: 'p1'
    })
    // 只改 projectId 与 settings 两列
    expect(r1).toMatchObject({ title: 'title R1', parentId: null, updatedAt: 20, lastActiveAt: 30 })

    expect(rowOf(db, 'C1').projectId).toBeNull()
    expect(rowOf(db, 'C1').parentId).toBe('R1')
    expect(settingsOf(db, 'C1')).toEqual({
      enabledTools: [],
      agentProfile: 'coding',
      workProject: 'p1',
      workingDirectory: '/work/p1'
    })

    expect(rowOf(db, 'R2').projectId).toBeNull()
    expect(settingsOf(db, 'R2')).toEqual({
      bot: '  pal  ',
      workProject: 'p2',
      workingDirectory: '/work/p2'
    })

    expect(db.prepare('SELECT * FROM session_day_prompts').all()).toEqual(promptsBefore)
    expect(db.prepare('SELECT * FROM session_acl').all()).toEqual(aclBefore)
    expect(db.prepare('SELECT * FROM projects').all()).toEqual(projectsBefore)
  })

  it('MV38-2 不是项目里的 bot 根会话（及其直接子会话）的行逐字节不变；坏设置不抛', () => {
    const db = v37Db()
    // 被挪走的根，用来挂「坏 JSON 的子会话」与孙会话
    insertSession(db, 'ROOT', { projectId: 'p1', settings: { bot: 'scout' } })

    const untouched: Array<[string, Parameters<typeof insertSession>[2]]> = [
      ['plain', { projectId: 'p1', settings: { enabledTools: ['mcp:a'] } }],
      ['notebook-bot', { projectId: 'p1', settings: { bot: 'scout', notebookPath: 'scout.md' } }],
      [
        'tab-bot',
        {
          projectId: 'p1',
          settings: { bot: 'scout', chromeTab: { installId: 'i', runId: 'r', tabId: 1 } }
        }
      ],
      ['blank-bot', { projectId: 'p1', settings: { bot: '   ' } }],
      ['number-bot', { projectId: 'p1', settings: { bot: 42 } }],
      ['plain-parent', { projectId: 'p1', settings: {} }],
      ['plain-child', { projectId: 'p1', parentId: 'plain-parent', settings: {} }],
      // 带 bot 键的子会话，父会话不是 bot 根：它自己不是根，也不挂在根下
      ['bot-child', { projectId: 'p1', parentId: 'plain-parent', settings: { bot: 'scout' } }],
      ['temp-bot', { projectId: null, settings: { bot: 'scout' } }],
      ['bad-json', { projectId: 'p1', settings: '{bad' }],
      ['array', { projectId: 'p1', settings: '["bot","scout"]' }],
      ['json-null', { projectId: 'p1', settings: 'null' }],
      // 坏 JSON 的子会话挂在被挪走的根下面：读不出来就不碰（改写只会把原来那份冲掉）
      ['bad-child', { projectId: 'p1', parentId: 'ROOT', settings: '{"enabledTools": [' }],
      ['array-child', { projectId: 'p1', parentId: 'ROOT', settings: '[1,2]' }]
    ]
    for (const [id, opts] of untouched) insertSession(db, id, opts)
    // 嵌套只有一层：子会话的子会话不在迁移范围里（它照旧是项目成员）
    insertSession(db, 'MID', { projectId: 'p1', parentId: 'ROOT', settings: {} })
    insertSession(db, 'GRAND', { projectId: 'p1', parentId: 'MID', settings: {} })
    const before = new Map(
      [...untouched.map(([id]) => id), 'GRAND'].map((id) => [id, rowOf(db, id)])
    )

    expect(() => v38().up(db as unknown as Db)).not.toThrow()

    for (const [id, row] of before) expect(rowOf(db, id), id).toEqual(row)
    // 对照组：根与它那条正常的子会话确实挪了（否则这条用例可能只是在测一个什么都不做的迁移）
    expect(rowOf(db, 'ROOT').projectId).toBeNull()
    expect(rowOf(db, 'MID').projectId).toBeNull()
    expect(settingsOf(db, 'MID').workProject).toBe('p1')
  })

  it('MV38-2 悬空的项目（项目行已删）→ 写 workProject、不写 workingDirectory；子会话同样', () => {
    const db = v37Db()
    insertSession(db, 'D', { projectId: 'gone', settings: { bot: 'scout' } })
    insertSession(db, 'DC', { projectId: 'gone', parentId: 'D', settings: { enabledTools: [] } })

    v38().up(db as unknown as Db)

    expect(rowOf(db, 'D').projectId).toBeNull()
    expect(settingsOf(db, 'D')).toEqual({ bot: 'scout', workProject: 'gone' })
    expect(rowOf(db, 'DC').projectId).toBeNull()
    expect(settingsOf(db, 'DC')).toEqual({ enabledTools: [], workProject: 'gone' })
  })

  it('MV38-3 triggerRun：只看 bot 根会话最早一条（按 timestamp）非 created 条目的来源', () => {
    const db = v37Db()
    // 标上的
    insertSession(db, 'T-first', { settings: { bot: 'scout' } })
    insertPrompt(db, 'T-first', 'created', 1, 'local')
    insertPrompt(db, 'T-first', 'a', 10, 'trigger')
    insertPrompt(db, 'T-first', 'b', 20, 'local')
    // 插入次序与时间次序相反：最早的（ts 5）是 trigger
    insertSession(db, 'T-order', { settings: { bot: 'scout' } })
    insertPrompt(db, 'T-order', 'late', 50, 'local')
    insertPrompt(db, 'T-order', 'early', 5, 'trigger')

    // 不标的
    insertSession(db, 'N-later', { settings: { bot: 'scout' } })
    insertPrompt(db, 'N-later', 'a', 5, 'local')
    insertPrompt(db, 'N-later', 'b', 10, 'trigger')
    insertSession(db, 'N-created-only', { settings: { bot: 'scout' } })
    insertPrompt(db, 'N-created-only', 'created', 1, 'trigger')
    insertSession(db, 'N-created-first', { settings: { bot: 'scout' } })
    insertPrompt(db, 'N-created-first', 'created', 1, 'trigger')
    insertPrompt(db, 'N-created-first', 'a', 5, 'local')
    insertSession(db, 'N-none', { settings: { bot: 'scout' } })
    insertSession(db, 'N-null-origin', { settings: { bot: 'scout' } })
    insertPrompt(db, 'N-null-origin', 'a', 5, null)
    insertSession(db, 'N-not-bot', { settings: {} })
    insertPrompt(db, 'N-not-bot', 'a', 5, 'trigger')
    insertSession(db, 'N-child', { parentId: 'T-first', settings: { bot: 'scout' } })
    insertPrompt(db, 'N-child', 'a', 5, 'trigger')
    insertSession(db, 'N-notebook', { settings: { bot: 'scout', notebookPath: 'scout.md' } })
    insertPrompt(db, 'N-notebook', 'a', 5, 'trigger')
    insertSession(db, 'N-bad', { settings: '{"bot": "scout"' })
    insertPrompt(db, 'N-bad', 'a', 5, 'trigger')
    // 已经标过：不再写一遍
    insertSession(db, 'N-already', { settings: { triggerRun: true, bot: 'scout' } })
    insertPrompt(db, 'N-already', 'a', 5, 'trigger')

    // 项目里的触发会话：先挪成引用，再标 triggerRun
    insertSession(db, 'T-project', { projectId: 'p1', settings: { bot: 'scout' } })
    insertPrompt(db, 'T-project', 'a', 5, 'trigger')

    const notMarked = [
      'N-later',
      'N-created-only',
      'N-created-first',
      'N-none',
      'N-null-origin',
      'N-not-bot',
      'N-child',
      'N-notebook',
      'N-bad',
      'N-already'
    ]
    const before = new Map(notMarked.map((id) => [id, rowOf(db, id)]))

    expect(() => v38().up(db as unknown as Db)).not.toThrow()

    expect(settingsOf(db, 'T-first')).toEqual({ bot: 'scout', triggerRun: true })
    expect(settingsOf(db, 'T-order')).toEqual({ bot: 'scout', triggerRun: true })
    for (const id of notMarked) expect(rowOf(db, id), id).toEqual(before.get(id))

    expect(rowOf(db, 'T-project').projectId).toBeNull()
    expect(settingsOf(db, 'T-project')).toEqual({
      bot: 'scout',
      workProject: 'p1',
      workingDirectory: '/work/p1',
      triggerRun: true
    })
  })

  it('MV38-4 再跑一遍：会话表与第一次跑完一模一样；runMigrations 在最新版本上什么都不做', () => {
    const db = v37Db()
    insertSession(db, 'R', { projectId: 'p1', settings: { bot: 'scout' } })
    insertSession(db, 'C', { projectId: 'p1', parentId: 'R', settings: {} })
    insertSession(db, 'D', { projectId: 'gone', settings: { bot: 'scout' } })
    insertSession(db, 'T', { projectId: 'p2', settings: { bot: 'scout' } })
    insertPrompt(db, 'T', 'a', 5, 'trigger')
    insertSession(db, 'B', { projectId: 'p1', settings: '{bad' })
    insertSession(db, 'P', { projectId: 'p1', settings: { enabledTools: [] } })

    runMigrations(betterSqliteShim(db))
    const once = allSessions(db)
    expect(settingsOf(db, 'T').triggerRun).toBe(true)

    expect(runMigrations(betterSqliteShim(db))).toBe(0)
    expect(allSessions(db)).toEqual(once)

    db.exec('PRAGMA user_version = 37')
    expect(runMigrations(betterSqliteShim(db))).toBe(migrations.at(-1)!.version - 37)
    expect(allSessions(db)).toEqual(once)

    v38().up(db as unknown as Db)
    expect(allSessions(db)).toEqual(once)
  })
})
