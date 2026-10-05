/**
 * sessionStorage —— 桌面会话存储的路由（SessionHost 的 openStorage / storageExists / deleteStorage）。
 *
 * 契约：
 *   SS-1  运行配置存会话设置：没设过 → 三项都是 null；appendModelChange 写 `settings.model`
 *         （`{provider, modelId}`）、appendThinkingLevelChange 写 `settings.thinkingLevel`，
 *         readSessionRunConfig 读回；后写的覆盖先写的；设置里别的键原样留着。
 *         持久会话与内存会话同一口径（都经 sessionRecords）。
 *   SS-3  readLegacyTranscript：没有 `.jsonl` → null；有一份合法的 v3 文本 → 渲染出界面消息。
 *   D10-01 新格式会话：`<sessionsDir>/<id>.sqlite`，关了再开内容还在；目录按调用时现读。
 *   D10-02 内存会话从不碰盘：存在性随打开 / 删除变化，目录始终是空的，删了再开是新的。
 *   D10-03 storageExists 的矩阵（只有 `.sqlite` 算数；旧格式 / 不认识 / 已删的内存会话恒 false）。
 *   D10-04 删新格式会话：`.sqlite` / `-wal` / `-shm` / `.jsonl` 四个都删，别的会话不动，重复删不抛
 *          （原 SS-2 并入）。
 *   D10-05 删内存会话 / 已删的内存会话：内存存储丢掉（再开是新的），盘上同名的杂文件不动。
 *   D10-06 打不开：旧格式（`legacy`）、不认识的格式、没有这一行、已删的内存会话 —— 带原因的拒绝，
 *          什么文件都不建，旧转写的字节不变、照样读得出来。
 *   D10-07 删了再开：全新的存储（没有条目、没有锁、没有待送达通知 —— WAL 不会复活）。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 内存库给 sessions 表，同 sessionRecordsEphemeral.test；会话存储是
 * 临时目录里的真文件）；宿主是真的 createSessionHost（faux 模型）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionHost } from '@shuvix/agent-runtime'
import { SessionStateDoc, backgroundContext } from '@shuvix/agent-runtime'

const holder = vi.hoisted(() => ({ db: null as unknown, sessionsDir: '' }))

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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { migrations } from '../../dao/migrations'
import type { Session } from '../../dao/types'
import { sessionRecords } from '../sessionRecords'
import {
  SessionStorageUnavailableError,
  appendModelChange,
  appendThinkingLevelChange,
  clearMemoryStoragesForTests,
  deleteSessionStorage,
  durableStoragePath,
  openSessionStorage,
  readLegacyTranscript,
  readSessionRunConfig,
  sessionStorageExists
} from '../sessionStorage'
import { makeRealHost, transcript, withTimeout } from './support/realHost'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const STORAGE = {
  openStorage: openSessionStorage,
  storageExists: sessionStorageExists,
  deleteStorage: deleteSessionStorage
}

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: `title ${id}`,
    projectId: null,
    parentId: null,
    storageKind: 'durable-sqlite-1',
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  }
}

const dirs: string[] = []
const hosts: SessionHost[] = []

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shuvix-session-storage-'))
  dirs.push(dir)
  return dir
}

function realHost(): ReturnType<typeof makeRealHost> {
  const made = makeRealHost({
    storage: STORAGE,
    isEphemeral: (id) => sessionRecords.isEphemeral(id)
  })
  hosts.push(made.host)
  return made
}

const touch = (name: string, dir = holder.sessionsDir): void =>
  writeFileSync(join(dir, name), 'x')

/** 一份最小的合法 v3 转写 */
function legacyJsonl(id: string): string {
  const lines = [
    { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/ws' },
    {
      type: 'message',
      id: 'a',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }
    }
  ]
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = newDir()
  sessionRecords.clearEphemeralForTests()
  clearMemoryStoragesForTests()
})

afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await withTimeout(host.closeAll(), 15000, 'closeAll').catch(() => undefined)
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.each([
  ['persisted', undefined],
  ['ephemeral', { ephemeral: true }]
] as const)('SS-1 运行配置存会话设置（%s）', (_side, opt) => {
  it('没设过 → 三项都是 null', async () => {
    sessionRecords.insert(session('s1'), opt)
    await expect(readSessionRunConfig('s1')).resolves.toEqual({
      provider: null,
      model: null,
      thinkingLevel: null
    })
  })

  it('写进 settings.model / settings.thinkingLevel 并读回；后写的覆盖；别的键不动', async () => {
    sessionRecords.insert(session('s1', { settings: { enabledTools: ['mcp:ssh'] } }), opt)

    await appendModelChange('s1', 'prov-a', 'm-a')
    expect(sessionRecords.pickSettings('s1', ['model'])?.model).toEqual({
      provider: 'prov-a',
      modelId: 'm-a'
    })
    await expect(readSessionRunConfig('s1')).resolves.toEqual({
      provider: 'prov-a',
      model: 'm-a',
      thinkingLevel: null
    })

    await appendThinkingLevelChange('s1', 'high')
    await appendModelChange('s1', 'prov-b', 'm-b')
    await expect(readSessionRunConfig('s1')).resolves.toEqual({
      provider: 'prov-b',
      model: 'm-b',
      thinkingLevel: 'high'
    })
    expect(sessionRecords.findById('s1')?.settings.enabledTools).toEqual(['mcp:ssh'])
  })
})

describe('SS-3 readLegacyTranscript', () => {
  it('没有 .jsonl → null', () => {
    expect(readLegacyTranscript('s1')).toBeNull()
  })

  it('一份合法的 v3 文本 → 渲染出界面消息', () => {
    writeFileSync(join(holder.sessionsDir, 's1.jsonl'), legacyJsonl('s1'))
    const view = readLegacyTranscript('s1')
    expect(view?.messages).toHaveLength(1)
    expect(view?.messages[0]).toMatchObject({
      id: 'a',
      sessionId: 's1',
      role: 'user',
      content: 'hi'
    })
  })
})

describe('D10-01 新格式会话的打开与落盘', () => {
  it('D10-01 `<dir>/<id>.sqlite`；关了再开通知还在；目录按调用时现读', async () => {
    const dirA = holder.sessionsDir
    sessionRecords.insert(session('d1'))
    sessionRecords.insert(session('d2'))
    const { host } = realHost()

    const s1 = await host.open('d1')
    expect((await s1.writeNotice({ text: 'remember me', kind: 'background' })).status).toBe(
      'submitted'
    )
    await host.close('d1')
    expect(existsSync(join(dirA, 'd1.sqlite'))).toBe(true)

    const reopened = await host.open('d1')
    expect(await transcript(await reopened.currentConversation())).toEqual([
      'shuvix.notice:remember me'
    ])

    const dirB = newDir()
    holder.sessionsDir = dirB
    await host.open('d2')
    expect(existsSync(join(dirB, 'd2.sqlite'))).toBe(true)
    expect(readdirSync(dirA).some((name) => name.startsWith('d2'))).toBe(false)
  })
})

describe('D10-02 内存会话从不碰盘', () => {
  it('D10-02 存在性：打开前 false、打开后 true、删除后 false；目录始终为空；删了再开是新的', async () => {
    sessionRecords.insert(session('e1'), { ephemeral: true })
    const { host } = realHost()

    expect(sessionStorageExists('e1')).toBe(false)
    const s1 = await host.open('e1')
    await s1.writeNotice({ text: 'in memory', kind: 'background' })
    expect(sessionStorageExists('e1')).toBe(true)
    expect(readdirSync(holder.sessionsDir)).toEqual([])

    await host.delete('e1')
    expect(sessionStorageExists('e1')).toBe(false)
    expect(readdirSync(holder.sessionsDir)).toEqual([])

    const fresh = await host.open('e1')
    expect(await transcript(await fresh.currentConversation())).toEqual([])
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })

  it('D10-02 被关掉（closeAll 之外的 close）再打开：还是原来那份内容', async () => {
    sessionRecords.insert(session('e2'), { ephemeral: true })
    const { host } = realHost()
    const s1 = await host.open('e2')
    await s1.writeNotice({ text: 'kept', kind: 'background' })
    await host.close('e2')
    const again = await host.open('e2')
    expect(await transcript(await again.currentConversation())).toEqual(['shuvix.notice:kept'])
  })
})

describe('D10-03 storageExists 的矩阵', () => {
  it('D10-03 只有 .sqlite 算数；旧格式 / 不认识的格式 / 已删的内存会话恒 false', () => {
    sessionRecords.insert(session('none'))
    expect(sessionStorageExists('none')).toBe(false)

    sessionRecords.insert(session('walonly'))
    touch('walonly.sqlite-wal')
    touch('walonly.sqlite-shm')
    expect(sessionStorageExists('walonly')).toBe(false)

    sessionRecords.insert(session('has'))
    touch('has.sqlite')
    expect(sessionStorageExists('has')).toBe(true)

    sessionRecords.insert(session('old', { storageKind: 'harness-v3-jsonl' }))
    touch('old.jsonl')
    touch('old.sqlite')
    expect(sessionStorageExists('old')).toBe(false)

    sessionRecords.insert(session('future', { storageKind: 'future-x' as never }))
    touch('future.sqlite')
    expect(sessionStorageExists('future')).toBe(false)

    sessionRecords.insert(session('gone'), { ephemeral: true })
    sessionRecords.deleteById('gone')
    expect(sessionStorageExists('gone')).toBe(false)
  })
})

describe('D10-04 删新格式会话（原 SS-2）', () => {
  it('D10-04 删掉这条会话的 .sqlite / -wal / -shm / .jsonl，别的会话的文件不动；重复删不抛', async () => {
    for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.jsonl']) {
      touch(`x${suffix}`)
      touch(`y${suffix}`)
    }
    await deleteSessionStorage('x')
    expect(readdirSync(holder.sessionsDir).sort()).toEqual(
      ['y.jsonl', 'y.sqlite', 'y.sqlite-shm', 'y.sqlite-wal'].sort()
    )
    await expect(deleteSessionStorage('x')).resolves.toBeUndefined()
    await expect(deleteSessionStorage('nothing')).resolves.toBeUndefined()
  })
})

describe('D10-05 删内存会话', () => {
  it('D10-05 内存存储丢掉（再开是新的），盘上同名的杂文件不动；已删的内存会话同样', async () => {
    sessionRecords.insert(session('e1'), { ephemeral: true })
    const { host } = realHost()
    const s1 = await host.open('e1')
    await s1.writeNotice({ text: 'n', kind: 'background' })
    touch('e1.sqlite')

    await host.close('e1')
    await deleteSessionStorage('e1')
    // 内存会话从来没有盘上的文件：同名的杂文件不归它，不动
    expect(existsSync(join(holder.sessionsDir, 'e1.sqlite'))).toBe(true)
    const fresh = await host.open('e1')
    expect(await transcript(await fresh.currentConversation())).toEqual([])

    // 已删的内存会话（wasEphemeral）：内存存储丢掉，盘上照样不动，之后什么都打不开
    await fresh.writeNotice({ text: 'again', kind: 'background' })
    await host.close('e1')
    sessionRecords.deleteById('e1')
    await deleteSessionStorage('e1')
    expect(sessionStorageExists('e1')).toBe(false)
    expect(existsSync(join(holder.sessionsDir, 'e1.sqlite'))).toBe(true)
    await expect(openSessionStorage('e1')).rejects.toBeInstanceOf(SessionStorageUnavailableError)
  })
})

describe('D10-06 打不开的会话', () => {
  it('D10-06 旧格式：带原因的拒绝；宿主 open 拒绝、peek undefined；不建 .sqlite，旧转写不变、照样读得出', async () => {
    sessionRecords.insert(session('old', { storageKind: 'harness-v3-jsonl' }))
    const text = legacyJsonl('old')
    writeFileSync(join(holder.sessionsDir, 'old.jsonl'), text)
    const { host } = realHost()

    const refusal = await openSessionStorage('old').catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SessionStorageUnavailableError)
    expect((refusal as SessionStorageUnavailableError).reason).toBe('legacy')
    await expect(host.open('old')).rejects.toBeInstanceOf(SessionStorageUnavailableError)
    expect(await host.peek('old')).toBeUndefined()

    expect(existsSync(durableStoragePath('old'))).toBe(false)
    expect(readFileSync(join(holder.sessionsDir, 'old.jsonl'), 'utf8')).toBe(text)
    expect(readLegacyTranscript('old')?.messages).toHaveLength(1)
  })

  it.each([
    ['unknown_kind', (): void => sessionRecords.insert(session('k', { storageKind: 'future-x' as never }))],
    ['no_row', (): void => {}],
    [
      'retired_ephemeral',
      (): void => {
        sessionRecords.insert(session('k'), { ephemeral: true })
        sessionRecords.deleteById('k')
      }
    ]
  ] as const)('D10-06 %s：同样拒绝、什么文件都不建', async (reason, arrange) => {
    arrange()
    const { host } = realHost()
    const refusal = await openSessionStorage('k').catch((error: unknown) => error)
    expect((refusal as SessionStorageUnavailableError).reason).toBe(reason)
    await expect(host.open('k')).rejects.toBeInstanceOf(SessionStorageUnavailableError)
    expect(await host.peek('k')).toBeUndefined()
    expect(readdirSync(holder.sessionsDir)).toEqual([])
  })
})

describe('D10-07 删了再开', () => {
  it('D10-07 全新的存储：没有条目、没有锁、没有待送达通知（WAL 不复活）', async () => {
    sessionRecords.insert(session('d1'))
    const { host } = realHost()
    const s1 = await host.open('d1')
    for (const text of ['a', 'b', 'c']) await s1.writeNotice({ text, kind: 'background' })
    await host.close('d1')

    await host.delete('d1')
    expect(readdirSync(holder.sessionsDir)).toEqual([])

    const fresh = await host.open('d1')
    expect(await transcript(await fresh.currentConversation())).toEqual([])
    expect(fresh.lock).toBeUndefined()
    const state = await fresh.harness.snapshot(SessionStateDoc, backgroundContext)
    expect(state?.deferredNotices ?? []).toEqual([])
  })
})
