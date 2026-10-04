/**
 * sessionStorage —— pi-durable 切换（P1-01）之后的桌面会话存储入口。
 *
 * 契约：
 *   SS-1  运行配置存会话设置：没设过 → 三项都是 null；appendModelChange 写 `settings.model`
 *         （`{provider, modelId}`）、appendThinkingLevelChange 写 `settings.thinkingLevel`，
 *         readSessionRunConfig 读回；后写的覆盖先写的；设置里别的键原样留着。
 *         持久会话与内存会话同一口径（都经 sessionRecords）。
 *   SS-2  deleteSessionFile 删这条会话的全部存储文件：`<id>.sqlite` 与 WAL 的 `-wal` / `-shm`，
 *         以及旧格式的 `<id>.jsonl`；别的会话的文件不动；什么都没有时也不抛（幂等）。
 *   SS-3  readLegacyTranscript：没有 `.jsonl` → null；有一份合法的 v3 文本 → 渲染出界面消息。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 内存库，同 sessionRecordsEphemeral.test）；会话目录是临时目录。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  appendModelChange,
  appendThinkingLevelChange,
  deleteSessionFile,
  readLegacyTranscript,
  readSessionRunConfig
} from '../sessionStorage'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

function session(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: `title ${id}`,
    projectId: null,
    parentId: null,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1,
    ...patch
  }
}

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
  holder.sessionsDir = mkdtempSync(join(tmpdir(), 'shuvix-session-storage-'))
  sessionRecords.clearEphemeralForTests()
})

afterEach(() => {
  rmSync(holder.sessionsDir, { recursive: true, force: true })
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

describe('SS-2 deleteSessionFile', () => {
  const touch = (name: string): void => writeFileSync(join(holder.sessionsDir, name), 'x')

  it('删掉这条会话的 .sqlite / -wal / -shm / .jsonl，别的会话的文件不动', () => {
    for (const suffix of ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.jsonl']) {
      touch(`s1${suffix}`)
      touch(`s2${suffix}`)
    }
    deleteSessionFile('s1')
    expect(readdirSync(holder.sessionsDir).sort()).toEqual(
      ['s2.jsonl', 's2.sqlite', 's2.sqlite-shm', 's2.sqlite-wal'].sort()
    )
  })

  it('什么都没有时不抛；重复删也不抛', () => {
    expect(() => deleteSessionFile('nothing')).not.toThrow()
    touch('s1.sqlite')
    deleteSessionFile('s1')
    expect(() => deleteSessionFile('s1')).not.toThrow()
    expect(existsSync(join(holder.sessionsDir, 's1.sqlite'))).toBe(false)
  })
})

describe('SS-3 readLegacyTranscript', () => {
  it('没有 .jsonl → null', () => {
    expect(readLegacyTranscript('s1')).toBeNull()
  })

  it('一份合法的 v3 文本 → 渲染出界面消息', () => {
    const lines = [
      { type: 'session', version: 3, id: 's1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/ws' },
      {
        type: 'message',
        id: 'a',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }
      }
    ]
    writeFileSync(
      join(holder.sessionsDir, 's1.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
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
