/**
 * 启动切换（P4-02，docs/pi-durable/p4-0102-test-design.md §B）—— 整合部分：真 SQLite（node:sqlite 内存库，
 * 跑全部迁移、`user_version` 拨到 30）、真 sessionDao / sessionRecords / sessionStorage、临时会话目录、
 * 需要打开时用真的 createSessionHost（faux 模型）。`sessionService.delete` 是记录型替身：自己做级联（子会话直接
 * 删行，不经替身）再删行 —— 真级联已由 sessionServiceSubSession / sessionServiceWorkingDirectory 钉着。
 *
 *   P4-02-10 选行（绑文件）：只有 A / B / C 换成新格式；其余各行类型一字不差；内存会话 N 照旧
 *   P4-02-11 被重置的笔记本的旧格式子会话 F 照旧只读（storageRefusalOf / legacyViewOf）
 *   P4-02-12 选行（标签页）：delete 恰收到 [J]；K（新格式）、L（坏绑定，PIN-06）不删
 *   P4-02-13 重置只动 storageKind（与 updatedAt）：其余列、settings 原文、钉住键、findAll 次序不变
 *   P4-02-14 `.jsonl` 留着、切换不建任何文件
 *   P4-02-15 下一次打开是全新的新格式存储（.jsonl 不读、不动）
 *   P4-02-16 重置后的会话能发送（真宿主 + faux 回复）
 *   P4-02-17 按 (项目, 笔记本路径) 查会话拿到的是同一行、新格式
 *   P4-02-18 删 / 清空重置后的会话：留下的 `.jsonl` 一起删
 *   P4-02-19 幂等：第二次 {0,0,0}、表与目录一字不差、delete 不再被调
 *   P4-02-20 user_version 与表结构不动、不加行
 *   P4-02-21 坏 settings JSON（PIN-09）：不抛、别的行照常处理、坏行不动
 *   P4-02-22 降级再升级（列还在）：只处理旧版本新建的 Q；A 不再动，旧版本写进 A.jsonl 的不显示
 *   P4-02-23 被拨回的库（L-9 的单测版）：曾是新格式的笔记本行重置回来、打开见原内容、镜像不动（PIN-14）；
 *            标签页行经 delete；不绑文件的照旧是旧格式
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHost } from '@shuvix/agent-runtime'
import {
  CURRENT_SESSION_STORAGE_KIND,
  DURABLE_SQLITE_1,
  HARNESS_V3_JSONL
} from '@shuvix/chat-protocol/sessionStorageKind'
import { REGISTRY_NOTE_PROJECT_IDS } from '@shuvix/chat-protocol/registryNotes'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  sessionsDir: '',
  deleted: [] as string[]
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  webContents: { fromId: () => undefined }
}))
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
vi.mock('../../utils/paths', () => ({ getSessionsDir: () => holder.sessionsDir }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
}))
// syncWiring（legacyViewOf）静态 import 宿主模块：换成从不建宿主的空壳
vi.mock('../sessionHost', () => ({
  getSessionHost: () => {
    throw new Error('the switchover must not build the session host')
  },
  peekSessionHost: () => undefined
}))
vi.mock('../sessionService', async () => {
  const { sessionRecords } = await import('../sessionRecords')
  return {
    sessionService: {
      delete: vi.fn(async (id: string) => {
        holder.deleted.push(id)
        // 级联：子会话直接删行（不经替身），再删自己
        for (const child of sessionRecords.findChildren(id)) sessionRecords.deleteById(child.id)
        sessionRecords.deleteById(id)
      })
    }
  }
})

import { migrations } from '../../dao/migrations'
import { sessionDao } from '../../dao/sessionDao'
import type { Session } from '../../dao/types'
import { legacyViewOf } from '../../frontend/sync/syncWiring'
import { runLegacySwitchover } from '../legacySwitchover'
import { sessionRecords } from '../sessionRecords'
import {
  SessionStorageUnavailableError,
  clearMemoryStoragesForTests,
  deleteSessionStorage,
  isDurableSession,
  openSessionStorage,
  sessionStorageExists,
  storageRefusalOf
} from '../sessionStorage'
import { answer, makeRealHost, transcript, withTimeout } from './support/realHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]
type Row = Record<string, unknown>

const STORAGE = {
  openStorage: openSessionStorage,
  storageExists: sessionStorageExists,
  deleteStorage: deleteSessionStorage
}

const P = 'proj-p'
const MEMORY_PATH = '/abs/memory/proj-p/topic.md'
const BINDING = (tabId: number): Row => ({ installId: 'inst', runId: 'run', tabId })

const dirs: string[] = []
const hosts: SessionHost[] = []

function db(): DatabaseSync {
  return holder.db as DatabaseSync
}

let seq = 0
/** 原生 SQL 插一行；`storageKind` 不给 = 列默认值（旧格式） */
function insertRow(id: string, over: Row = {}): void {
  seq++
  const row: Row = {
    id,
    title: `title ${id}`,
    projectId: null,
    parentId: null,
    settings: '{}',
    createdAt: 1_000 + seq,
    updatedAt: 2_000 + seq,
    lastActiveAt: 5_000 - seq * 7,
    ...over
  }
  if (typeof row.settings === 'object') row.settings = JSON.stringify(row.settings)
  const keys = Object.keys(row)
  db()
    .prepare(`INSERT INTO sessions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...(Object.values(row) as Array<string | number | null>))
}

/** 设计稿 §B 的种子矩阵 */
function seedMatrix(): void {
  insertRow('A', { projectId: P, settings: { notebookPath: 'notes/a.md' } })
  insertRow('B', { projectId: REGISTRY_NOTE_PROJECT_IDS.agent, settings: { notebookPath: 'x.md' } })
  insertRow('C', { projectId: P, settings: { notebookPath: MEMORY_PATH, memorySlug: 'topic' } })
  insertRow('D', { projectId: P })
  insertRow('E', { settings: { bot: 'scout' } })
  insertRow('F', { projectId: P, parentId: 'A' })
  insertRow('G', {
    projectId: P,
    storageKind: DURABLE_SQLITE_1,
    settings: { notebookPath: 'g.md' }
  })
  insertRow('H', { storageKind: DURABLE_SQLITE_1 })
  insertRow('I', { storageKind: 'durable-sqlite-9', settings: { notebookPath: 'i.md' } })
  insertRow('J', { settings: { chromeTab: BINDING(4) } })
  insertRow('J1', { parentId: 'J' })
  insertRow('K', { storageKind: DURABLE_SQLITE_1, settings: { chromeTab: BINDING(5) } })
  insertRow('L', { settings: { chromeTab: BINDING(-1) } })
  insertRow('M', { projectId: P, settings: { notebookPath: '' } })
  writeFileSync(join(holder.sessionsDir, 'A.jsonl'), legacyJsonl('A'))
  sessionRecords.insert(
    {
      id: 'N',
      title: 'ephemeral',
      projectId: P,
      parentId: null,
      settings: { notebookPath: 'n.md' },
      createdAt: 1,
      updatedAt: 1,
      lastActiveAt: 1
    } as Session,
    { ephemeral: true }
  )
}

/** 一份最小的合法 v3 转写（一条用户消息） */
function legacyJsonl(id: string, text = 'old notebook chat'): string {
  const lines = [
    { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/ws' },
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
    }
  ]
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

const kindOf = (id: string): unknown =>
  (db().prepare('SELECT storageKind FROM sessions WHERE id = ?').get(id) as Row | undefined)
    ?.storageKind

const rowOf = (id: string): Row =>
  db().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row

const dumpSessions = (): Row[] => db().prepare('SELECT * FROM sessions ORDER BY id').all() as Row[]

const listDir = (): string[] => readdirSync(holder.sessionsDir).sort()

function realHost(): ReturnType<typeof makeRealHost> {
  const made = makeRealHost({
    storage: STORAGE,
    isEphemeral: (id) => sessionRecords.isEphemeral(id)
  })
  hosts.push(made.host)
  return made
}

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  fresh.exec('PRAGMA user_version = 30')
  holder.db = fresh
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-legacy-switchover-'))
  dirs.push(holder.sessionsDir)
  holder.deleted = []
  seq = 0
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
})

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await withTimeout(host.closeAll(), 15000, 'closeAll').catch(() => undefined)
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('P4-02 启动切换：选行', () => {
  it('P4-02-10 绑文件：只有 A / B / C 换成新格式；其余类型一字不差；内存会话 N 照旧、不落库', async () => {
    seedMatrix()
    const before = Object.fromEntries(dumpSessions().map((r) => [r.id, r.storageKind]))

    const result = await runLegacySwitchover()

    expect(result).toEqual({ reset: 3, deleted: 1, failed: 0 })
    for (const id of ['A', 'B', 'C']) expect(kindOf(id)).toBe(CURRENT_SESSION_STORAGE_KIND)
    for (const id of ['D', 'E', 'F', 'G', 'H', 'I', 'L', 'M']) expect(kindOf(id)).toBe(before[id])
    expect(sessionRecords.pick('N', ['storageKind'])?.storageKind).toBe(HARNESS_V3_JSONL)
    expect(db().prepare("SELECT id FROM sessions WHERE id = 'N'").get()).toBeUndefined()
  })

  it('P4-02-11 A 重置之后，它的旧格式子会话 F 照旧只读', async () => {
    seedMatrix()
    await runLegacySwitchover()

    expect(kindOf('F')).toBe(HARNESS_V3_JSONL)
    expect(storageRefusalOf('F')).toBe('legacy')
    expect(legacyViewOf('F')).toBeDefined()
  })

  it('P4-02-12 标签页：delete 恰收到 [J]（J1 随级联走）；K、L 不删', async () => {
    seedMatrix()
    await runLegacySwitchover()

    expect(holder.deleted).toEqual(['J'])
    expect(kindOf('J')).toBeUndefined()
    expect(kindOf('J1')).toBeUndefined()
    expect(kindOf('K')).toBe(DURABLE_SQLITE_1)
    expect(kindOf('L')).toBe(HARNESS_V3_JSONL)
  })
})

describe('P4-02 启动切换：重置的语义', () => {
  it('P4-02-13 只动 storageKind（与 updatedAt）：其余列、settings 原文、钉住键、findAll 次序不变', async () => {
    seedMatrix()
    db()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('window.panelLayout.pinned.A', '{"pinned":true}')
    const before = rowOf('A')
    const order = sessionDao.findAll().map((s) => s.id)

    await runLegacySwitchover()

    const after = rowOf('A')
    for (const col of ['id', 'title', 'projectId', 'parentId', 'settings', 'createdAt']) {
      expect(after[col], col).toBe(before[col])
    }
    expect(after.lastActiveAt).toBe(before.lastActiveAt)
    expect(after.storageKind).toBe(CURRENT_SESSION_STORAGE_KIND)
    expect(after.updatedAt as number).toBeGreaterThanOrEqual(before.updatedAt as number)
    expect(
      db().prepare('SELECT value FROM settings WHERE key = ?').get('window.panelLayout.pinned.A')
    ).toEqual({ value: '{"pinned":true}' })
    // J / J1 被删，其余次序不变
    expect(sessionDao.findAll().map((s) => s.id)).toEqual(
      order.filter((id) => id !== 'J' && id !== 'J1')
    )
  })

  it('P4-02-14 `.jsonl` 字节不变；切换不建任何文件', async () => {
    seedMatrix()
    const bytes = readFileSync(join(holder.sessionsDir, 'A.jsonl'))

    await runLegacySwitchover()

    expect(readFileSync(join(holder.sessionsDir, 'A.jsonl')).equals(bytes)).toBe(true)
    expect(listDir()).toEqual(['A.jsonl'])
    expect(sessionStorageExists('A')).toBe(false)
  })

  it('P4-02-15 下一次打开是全新的新格式存储：空消息、不是旧格式视图、.jsonl 不动', async () => {
    seedMatrix()
    const text = readFileSync(join(holder.sessionsDir, 'A.jsonl'), 'utf8')
    await runLegacySwitchover()
    const { host } = realHost()

    const session = await host.open('A')

    expect(existsSync(join(holder.sessionsDir, 'A.sqlite'))).toBe(true)
    expect((await session.viewSnapshot()).messages).toEqual([])
    expect(await transcript(await session.currentConversation())).toEqual([])
    expect(legacyViewOf('A')).toBeUndefined()
    expect(isDurableSession('A')).toBe(true)
    expect(readFileSync(join(holder.sessionsDir, 'A.jsonl'), 'utf8')).toBe(text)
  })

  it('P4-02-16 重置后的会话能发送：用户与助手条目落进 A.sqlite', async () => {
    seedMatrix()
    await runLegacySwitchover()
    const { host, kit } = realHost()

    const session = await host.open('A')
    kit.queue(answer('hello from durable'))
    const submitted = await withTimeout(session.submitUser('hi'), 10000, 'submit')

    expect(submitted).not.toHaveProperty('error')
    const entries = await transcript(await session.currentConversation())
    expect(entries.some((e) => e.endsWith(':hi'))).toBe(true)
    expect(entries.some((e) => e.endsWith(':hello from durable'))).toBe(true)
    expect(storageRefusalOf('A')).toBeUndefined()
    expect(existsSync(join(holder.sessionsDir, 'A.sqlite'))).toBe(true)
  })

  it('P4-02-17 按 (项目, 笔记本路径) 查会话拿到同一行、新格式', async () => {
    seedMatrix()
    await runLegacySwitchover()

    const cases: Array<[string, string, string]> = [
      [P, 'notes/a.md', 'A'],
      [REGISTRY_NOTE_PROJECT_IDS.agent, 'x.md', 'B'],
      [P, MEMORY_PATH, 'C']
    ]
    for (const [projectId, path, id] of cases) {
      const found = sessionRecords.findByProjectAndNotebookPath(projectId, path)
      expect(found?.id).toBe(id)
      expect(found?.storageKind).toBe(CURRENT_SESSION_STORAGE_KIND)
    }
  })

  it('P4-02-18 删 / 清空重置后的会话：.jsonl、.sqlite、-wal、-shm 全没了', async () => {
    seedMatrix()
    await runLegacySwitchover()
    const { host } = realHost()
    await host.open('A')
    await host.close('A')
    for (const suffix of ['-wal', '-shm'])
      writeFileSync(join(holder.sessionsDir, `A.sqlite${suffix}`), 'x')

    await deleteSessionStorage('A')

    expect(listDir().filter((name) => name.startsWith('A.'))).toEqual([])
  })
})

describe('P4-02 启动切换：幂等与不碰结构', () => {
  it('P4-02-19 第二次：{0,0,0}，表与目录一字不差，delete 不再被调', async () => {
    seedMatrix()
    await runLegacySwitchover()
    const table = dumpSessions()
    const files = listDir()
    const deletes = holder.deleted.length

    const second = await runLegacySwitchover()

    expect(second).toEqual({ reset: 0, deleted: 0, failed: 0 })
    expect(dumpSessions()).toEqual(table)
    expect(listDir()).toEqual(files)
    expect(holder.deleted).toHaveLength(deletes)
  })

  it('P4-02-20 user_version 仍是 30、sessions 表结构不变、哪张表都不多一行', async () => {
    seedMatrix()
    const tables = (
      db().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]
    ).map((r) => String(r.name))
    const counts = (): Record<string, number> =>
      Object.fromEntries(
        tables.map((t) => [
          t,
          Number((db().prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as Row).n)
        ])
      )
    const schema = db().prepare('PRAGMA table_info(sessions)').all()
    const before = counts()

    await runLegacySwitchover()

    expect((db().prepare('PRAGMA user_version').get() as Row).user_version).toBe(30)
    expect(db().prepare('PRAGMA table_info(sessions)').all()).toEqual(schema)
    // 只有 sessions 少了 J / J1
    expect(counts()).toEqual({ ...before, sessions: before.sessions - 2 })
  })

  it('P4-02-21 坏 settings JSON（PIN-09）：不抛；A / B / C 照重置、J 照删；坏行不动', async () => {
    seedMatrix()
    insertRow('Z', { settings: 'not json' })

    await expect(runLegacySwitchover()).resolves.toEqual({ reset: 3, deleted: 1, failed: 0 })

    for (const id of ['A', 'B', 'C']) expect(kindOf(id)).toBe(CURRENT_SESSION_STORAGE_KIND)
    expect(holder.deleted).toEqual(['J'])
    expect(rowOf('Z')).toMatchObject({ storageKind: HARNESS_V3_JSONL, settings: 'not json' })
  })

  it('P4-02-22 降级再升级（列还在）：只重置旧版本新建的 Q；A 不再动，旧版本写进 A.jsonl 的不显示', async () => {
    seedMatrix()
    await runLegacySwitchover()
    const aUpdatedAt = rowOf('A').updatedAt
    // 旧版本：新建一条笔记本会话（不点名类型 = 列默认值），往 A 的 .jsonl 里接着写
    insertRow('Q', { projectId: P, settings: { notebookPath: 'q.md' } })
    writeFileSync(join(holder.sessionsDir, 'A.jsonl'), legacyJsonl('A', 'written by old app'))

    const result = await runLegacySwitchover()

    expect(result).toEqual({ reset: 1, deleted: 0, failed: 0 })
    expect(kindOf('Q')).toBe(CURRENT_SESSION_STORAGE_KIND)
    expect(rowOf('A').updatedAt).toBe(aUpdatedAt)
    expect(kindOf('A')).toBe(CURRENT_SESSION_STORAGE_KIND)
    expect(legacyViewOf('A')).toBeUndefined()
  })

  it('P4-02-23 被拨回的库：R 重置回新格式、打开见原内容、镜像不动；T 经 delete；不绑文件的照旧是旧格式', async () => {
    insertRow('R', {
      projectId: P,
      storageKind: DURABLE_SQLITE_1,
      settings: { notebookPath: 'r.md', agentLocked: true }
    })
    insertRow('T', { storageKind: DURABLE_SQLITE_1, settings: { chromeTab: BINDING(9) } })
    insertRow('S', { projectId: P, storageKind: DURABLE_SQLITE_1 })
    const { host, kit } = realHost()
    const r = await host.open('R')
    kit.queue(answer('kept answer'))
    await withTimeout(r.submitUser('kept question'), 10000, 'submit')
    const prior = await transcript(await r.currentConversation())
    await host.close('R')
    expect(prior.length).toBeGreaterThan(0)

    // 拨回 v29（去掉这一列）再跑 v30：每一行都成了旧格式
    db().exec('ALTER TABLE sessions DROP COLUMN storageKind')
    migrations.find((m) => m.version === 30)!.up(db() as unknown as Db)
    for (const id of ['R', 'T', 'S']) expect(kindOf(id)).toBe(HARNESS_V3_JSONL)
    const settingsBefore = rowOf('R').settings

    const result = await runLegacySwitchover()

    expect(result).toEqual({ reset: 1, deleted: 1, failed: 0 })
    expect(kindOf('R')).toBe(CURRENT_SESSION_STORAGE_KIND)
    expect(rowOf('R').settings).toBe(settingsBefore)
    expect(holder.deleted).toEqual(['T'])
    expect(kindOf('S')).toBe(HARNESS_V3_JSONL)

    const reopened = await host.open('R')
    expect(await transcript(await reopened.currentConversation())).toEqual(prior)
  })
})

describe('P4-02 前提：旧格式行打不开（对照）', () => {
  it('切换之前 A 是旧格式：openSessionStorage 拒绝', async () => {
    seedMatrix()
    await expect(openSessionStorage('A')).rejects.toBeInstanceOf(SessionStorageUnavailableError)
  })
})
