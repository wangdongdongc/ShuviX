/**
 * 标签页会话落在**真的会话表**上（node:sqlite 内存库 + 全部迁移 + 真的 sessionDao）：
 * 侧边栏开出来的会话，这条连接之后得认得出是自己的。
 *
 * tabSessions.test.ts 用的是按 DAO 声明形状回值的内存表；这里换成真表，验的是存进去的绑定
 * 走两条读路（findAll 解析整份 settings / pickSettings 按键 json_extract）读回来都还能被
 * `chromeTabOf` 认出 —— 侧边栏的每一次对话调用都先过 `connectionOwnsSession`。
 *
 * sessionService.create / delete 换成直接落这张表（create 写的就是 sessionService 给标签页会话
 * 写的那一行形状，见 sessionServiceChromeTab.test.ts 的 SCT-1）。
 *
 *   TSR-1  开了再开 → 同一条（findAll 读路）；
 *   TSR-2  开出来的会话归这条连接（pickSettings 读路）；别的运行的连接不拥有它；
 *   TSR-3  标签页关了 → 那一行从表里删掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { BridgeConnection } from '../../../services/chromeBridge'

const holder = vi.hoisted(() => ({ db: null as unknown, seq: 0 }))

vi.mock('../../../dao/database', () => {
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
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../../services/sessionService', async () => {
  const { sessionDao } = await import('../../../dao/sessionDao')
  return {
    sessionService: {
      create: (params: { title: string; chromeTab: unknown }) => {
        holder.seq += 1
        const session = {
          id: `tab-${holder.seq}`,
          title: params.title,
          projectId: null,
          parentId: null,
          settings: { chromeTab: params.chromeTab, enabledTools: [] },
          createdAt: 1,
          updatedAt: 1,
          lastActiveAt: 1
        }
        sessionDao.insert(session as Parameters<typeof sessionDao.insert>[0])
        return session
      },
      delete: async (id: string) => sessionDao.deleteById(id)
    }
  }
})
vi.mock('../../../services/chromeBridge', () => ({ existingChromeBrowserState: () => undefined }))

import { migrations } from '../../../dao/migrations'
import { sessionDao } from '../../../dao/sessionDao'
import { closeTabSession, connectionOwnsSession, openTabSession } from '../tabSessions'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const conn = (runId = 'r1'): BridgeConnection =>
  ({
    id: `conn-${runId}`,
    info: { installId: 'i1', runId, browser: 'Chrome', extensionVersion: '0.1.0', connectedAt: 1 }
  }) as unknown as BridgeConnection

beforeEach(() => {
  const db = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(db as unknown as Db)
  holder.db = db
})

describe('TSR 标签页会话在真的会话表上', () => {
  it('TSR-1 开了再开 → 同一条会话，表里只有一行', async () => {
    const first = await openTabSession(conn(), { tabId: 5, title: 'Inbox' })
    const second = await openTabSession(conn(), { tabId: 5, title: 'Inbox' })
    expect(second).toBe(first)
    expect(sessionDao.findAll().map((s) => s.id)).toEqual([first])
    expect(sessionDao.findById(first)?.title).toBe('Chrome · Inbox')
  })

  it('TSR-2 开出来的会话归这条连接；同一浏览器别的运行的连接不拥有它', async () => {
    const sid = await openTabSession(conn(), { tabId: 5, title: 'Inbox' })
    expect(connectionOwnsSession(conn(), sid)).toBe(true)
    expect(connectionOwnsSession(conn('r0'), sid)).toBe(false)
  })

  it('TSR-3 标签页关了 → 那一行删掉', async () => {
    const sid = await openTabSession(conn(), { tabId: 5, title: 'Inbox' })
    await closeTabSession(conn(), 5)
    expect(sessionDao.findById(sid)).toBeUndefined()
  })
})
