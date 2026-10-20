/**
 * SessionAclDao —— 会话权限表 `session_acl` 的纯数据访问（迁移 v33）。对账、继承、谁能改哪一行归上层
 * （services/acl），这里只守存取与读侧的容错。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 的内存库，同 mdAttrDao.test）：按顺序跑全部迁移建表，
 * BaseDao 换成直接在这个库上 prepare。
 *
 *   SAD-1  insert → findBySession 读回整行；按 createdAt（同时间按插入顺序）排；别的会话的行不在
 *   SAD-2  insert 撞唯一索引（同会话、种类、来源、来源键、目标）抛错，原行不动
 *   SAD-3  updateAccess：改到 → true、updatedAt 刷新；会话不对 / id 不在 → false、什么都不改
 *   SAD-4  deleteById：删到 → true；会话不对 → false；deleteBySession 只删那一条会话、回删掉的行数
 *   SAD-5  读侧跳过认不出的行（更新版本写的 kind、未知来源、未知访问方式），好行照常
 *   SAD-6  transaction：抛错整批回滚；正常整批落下；嵌套调用不再开事务
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import type { AclEntry } from '@shuvix/chat-protocol/sessionAcl'

const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('../database', () => {
  class BaseDao {
    protected get db(): unknown {
      return holder.db
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
import { sessionAclDao } from '../sessionAclDao'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const db = (): DatabaseSync => holder.db as DatabaseSync

function entry(over: Partial<AclEntry> = {}): AclEntry {
  return {
    id: 'e1',
    sessionId: 's1',
    kind: 'path',
    target: '/p',
    access: 'read',
    source: 'user',
    sourceKey: '',
    createdAt: 10,
    updatedAt: 10,
    ...over
  }
}

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
})

describe('SessionAclDao', () => {
  it('SAD-1 insert → findBySession 读回整行，按 createdAt 再按插入顺序；别的会话不在', () => {
    sessionAclDao.insert(entry({ id: 'late', target: '/late', createdAt: 30, updatedAt: 30 }))
    sessionAclDao.insert(entry({ id: 'a', target: '/a', createdAt: 10 }))
    sessionAclDao.insert(entry({ id: 'b', target: '/b', createdAt: 10, access: 'write' }))
    sessionAclDao.insert(entry({ id: 'other', sessionId: 's2', target: '/a' }))

    expect(sessionAclDao.findBySession('s1').map((e) => e.id)).toEqual(['a', 'b', 'late'])
    expect(sessionAclDao.findBySession('s1')[1]).toEqual(
      entry({ id: 'b', target: '/b', createdAt: 10, access: 'write' })
    )
    expect(sessionAclDao.findBySession('s2').map((e) => e.id)).toEqual(['other'])
    expect(sessionAclDao.findBySession('nobody')).toEqual([])
  })

  it('SAD-2 撞唯一索引抛错，原行不动', () => {
    sessionAclDao.insert(entry())
    expect(() => sessionAclDao.insert(entry({ id: 'e2', access: 'write' }))).toThrow(/UNIQUE/)
    expect(sessionAclDao.findBySession('s1')).toEqual([entry()])
    // 来源键或来源不同即可共存
    sessionAclDao.insert(entry({ id: 'e3', source: 'widget', sourceKey: 'w' }))
    expect(sessionAclDao.findBySession('s1')).toHaveLength(2)
  })

  it('SAD-3 updateAccess：改到 → true、updatedAt 刷新；会话不对 / id 不在 → false', () => {
    sessionAclDao.insert(entry())
    expect(sessionAclDao.updateAccess('s2', 'e1', 'write', 99)).toBe(false)
    expect(sessionAclDao.updateAccess('s1', 'nope', 'write', 99)).toBe(false)
    expect(sessionAclDao.findBySession('s1')).toEqual([entry()])

    expect(sessionAclDao.updateAccess('s1', 'e1', 'write', 99)).toBe(true)
    expect(sessionAclDao.findBySession('s1')).toEqual([entry({ access: 'write', updatedAt: 99 })])
  })

  it('SAD-4 deleteById / deleteBySession', () => {
    sessionAclDao.insert(entry())
    sessionAclDao.insert(entry({ id: 'e2', target: '/q' }))
    sessionAclDao.insert(entry({ id: 'x', sessionId: 's2' }))

    expect(sessionAclDao.deleteById('s2', 'e1')).toBe(false)
    expect(sessionAclDao.deleteById('s1', 'e1')).toBe(true)
    expect(sessionAclDao.deleteById('s1', 'e1')).toBe(false)
    expect(sessionAclDao.findBySession('s1').map((e) => e.id)).toEqual(['e2'])

    expect(sessionAclDao.deleteBySession('s1')).toBe(1)
    expect(sessionAclDao.findBySession('s1')).toEqual([])
    expect(sessionAclDao.findBySession('s2').map((e) => e.id)).toEqual(['x'])
  })

  it('SAD-5 读侧跳过认不出的行，好行照常', () => {
    const raw = (id: string, kind: string, source: string, access: string): void => {
      db()
        .prepare(
          `INSERT INTO session_acl (id, sessionId, kind, target, access, source, sourceKey, createdAt, updatedAt)
           VALUES (?, 's1', ?, ?, ?, ?, '', 1, 1)`
        )
        .run(id, kind, `/${id}`, access, source)
    }
    raw('net', 'network', 'user', 'connect')
    raw('src', 'path', 'mystery', 'read')
    raw('acc', 'path', 'user', 'execute')
    sessionAclDao.insert(entry({ id: 'good', target: '/good' }))

    expect(sessionAclDao.findBySession('s1').map((e) => e.id)).toEqual(['good'])
  })

  it('SAD-6 transaction：抛错整批回滚；正常整批落下；嵌套不再开事务', () => {
    expect(() =>
      sessionAclDao.transaction(() => {
        sessionAclDao.insert(entry())
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(sessionAclDao.findBySession('s1')).toEqual([])

    const result = sessionAclDao.transaction(() => {
      sessionAclDao.insert(entry())
      // 嵌套：已在事务里就直接跑，不抛 "cannot start a transaction within a transaction"
      sessionAclDao.transaction(() => sessionAclDao.insert(entry({ id: 'e2', target: '/q' })))
      return 'done'
    })
    expect(result).toBe('done')
    expect(sessionAclDao.findBySession('s1').map((e) => e.id)).toEqual(['e1', 'e2'])
  })
})
