/**
 * 会话权限表服务（services/acl）—— 派生行懒对账、授予、继承、内存会话。
 *
 * 在**真的 SQLite** 上跑（node:sqlite 内存库，跑全部迁移建表；BaseDao 换成直接在这个库上 prepare），
 * 会话行经真的 sessionRecords 写入。派生行的来源（工作目录、知识库、技能……）由 derive 算 —— 那一层
 * 读文件系统与别的服务，这里换成可控的假实现，测的是对账本身。广播换成记录。
 *
 *   ACL-1  新建会话 initialize：派生行按 derive 写进表；entries 先对账再读
 *   ACL-2  派生行随设置联动：derive 变了（知识库勾上 / 取消、工作目录换了）下一次读就补上 / 删掉；没变不写库
 *   ACL-3  工作目录、笔记本文档那两行保留用户改过的访问方式；其余派生行的访问方式被对账改回来源决定的值
 *   ACL-4  grantPath：新行 source user；同一路径再授予合并访问方式（读 + 写 = 写，写 + 读不降级）；
 *          widget 来源按 sourceKey 区分；相对路径 / 会话不在 → null；每次真改都广播
 *   ACL-5  setAccess：授予行、工作目录行能改；system / knowledge / skill 行不能；未变不写不广播
 *   ACL-6  remove：授予行能删；派生行不能删（删了下一次对账又会长回来）
 *   ACL-7  pathView / sandboxEntries：写隐含读；授予行 granted=true、派生行 false
 *   ACL-8  子会话 initialize：复制父会话的授予行（新 id、新时间），不复制父会话的派生行（自己派生）
 *   ACL-9  fork initialize：复制授予行与工作目录那一行的访问方式（同一个工作目录）
 *   ACL-10 内存会话：表在内存里，从不落库；读写与持久会话同口径；删除后表没了
 *   ACL-11 deleteSession：整张表与对账记忆清掉；删掉的会话读出空表、授予回 null，不会补出行
 *   ACL-12 坏 id / 不存在的会话：空表，不碰存储
 *   ACL-13 对账失败（库抛错）：保持上一次的表，不记指纹，下一次读再试
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  derived: new Map<string, Array<Record<string, string>>>(),
  broadcasts: [] as string[]
}))

vi.mock('../../../dao/database', () => {
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
vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: (id: string) => holder.broadcasts.push(id)
}))
vi.mock('../derive', () => ({
  derivePathEntries: (sessionId: string) => holder.derived.get(sessionId) ?? [],
  derivedKey: (e: { source: string; sourceKey: string; target: string }) =>
    `${e.source}\u0000${e.sourceKey}\u0000${e.target}`
}))

import type { AclEntry } from '@shuvix/chat-protocol/sessionAcl'
import { migrations } from '../../../dao/migrations'
import type { Session } from '../../../dao/types'
import { sessionRecords } from '../../sessionRecords'
import { sessionAcl } from '..'
import { clearMemoryAclForTests } from '../store'

type Db = Parameters<(typeof migrations)[number]['up']>[0]

const db = (): DatabaseSync => holder.db as DatabaseSync
const rowCount = (sessionId?: string): number =>
  (
    (sessionId
      ? db().prepare('SELECT COUNT(*) AS n FROM session_acl WHERE sessionId = ?').get(sessionId)
      : db().prepare('SELECT COUNT(*) AS n FROM session_acl').get()) as { n: number }
  ).n

function addSession(id: string, opts: { ephemeral?: boolean; parentId?: string } = {}): void {
  const session: Session = {
    id,
    title: id,
    projectId: null,
    parentId: opts.parentId ?? null,
    settings: {},
    createdAt: 1,
    updatedAt: 1,
    lastActiveAt: 1
  }
  sessionRecords.insert(session, { ephemeral: opts.ephemeral })
}

const WS = '/Users/u/proj'
function baseDerived(sessionId: string, extra: Array<Record<string, string>> = []): void {
  holder.derived.set(sessionId, [
    { source: 'workdir', sourceKey: '', target: WS, access: 'write' },
    { source: 'system', sourceKey: 'tmp', target: `/private/tmp/x/${sessionId}`, access: 'write' },
    { source: 'skill', sourceKey: '/skills', target: '/skills', access: 'read' },
    ...extra
  ])
}

/** 表的可比视图（去掉 id 与时间） */
const shape = (sessionId: string): string[] =>
  sessionAcl
    .entries(sessionId)
    .map((e) => `${e.source}:${e.sourceKey}:${e.target}:${e.access}`)
    .sort()

beforeEach(() => {
  const fresh = new DatabaseSync(':memory:')
  for (const m of migrations) m.up(fresh as unknown as Db)
  holder.db = fresh
  holder.derived.clear()
  holder.broadcasts.length = 0
  sessionRecords.clearEphemeralForTests()
  clearMemoryAclForTests()
  sessionAcl.forgetReconciled()
})

describe('sessionAcl', () => {
  it('ACL-1 initialize 写派生行；entries 先对账再读', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    expect(rowCount('s1')).toBe(3)
    expect(shape('s1')).toEqual([
      'skill:/skills:/skills:read',
      'system:tmp:/private/tmp/x/s1:write',
      `workdir::${WS}:write`
    ])
    // 对账不广播（派生行跟着设置走，改设置的地方自己广播）
    expect(holder.broadcasts).toEqual([])
  })

  it('ACL-2 派生行随设置联动；没变不写库', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    const ids = sessionAcl.entries('s1').map((e) => e.id)

    // 勾上一个知识库
    baseDerived('s1', [
      { source: 'knowledge', sourceKey: 'notes', target: '/kb/notes', access: 'write' }
    ])
    expect(shape('s1')).toContain('knowledge:notes:/kb/notes:write')
    // 原有的行没被重建（id 不变）
    expect(sessionAcl.entries('s1').map((e) => e.id)).toEqual(expect.arrayContaining(ids))

    // 取消勾选 + 工作目录换了（会话挪进项目）
    holder.derived.set('s1', [
      { source: 'workdir', sourceKey: '', target: '/other', access: 'write' },
      { source: 'system', sourceKey: 'tmp', target: '/private/tmp/x/s1', access: 'write' },
      { source: 'skill', sourceKey: '/skills', target: '/skills', access: 'read' }
    ])
    expect(shape('s1')).toEqual([
      'skill:/skills:/skills:read',
      'system:tmp:/private/tmp/x/s1:write',
      'workdir::/other:write'
    ])

    // 派生输入没变：不再碰库（拿一行手改过的数据验证没被对账覆盖）
    db().prepare("UPDATE session_acl SET target = '/tampered' WHERE source = 'skill'").run()
    expect(shape('s1')).toContain('skill:/skills:/tampered:read')
    // 指纹忘掉后（重启）再读：对账把它改回来
    sessionAcl.forgetReconciled('s1')
    expect(shape('s1')).toContain('skill:/skills:/skills:read')
    expect(shape('s1')).not.toContain('skill:/skills:/tampered:read')
  })

  it('ACL-3 工作目录、笔记本文档行保留用户改的访问方式；其余派生行改回来源决定的值', () => {
    addSession('s1')
    baseDerived('s1', [{ source: 'document', sourceKey: '', target: '/doc.md', access: 'write' }])
    sessionAcl.initialize('s1')
    const workdir = sessionAcl.entries('s1').find((e) => e.source === 'workdir')!
    expect(sessionAcl.setAccess('s1', workdir.id, 'read')).toBe(true)
    const doc = sessionAcl.entries('s1').find((e) => e.source === 'document')!
    expect(sessionAcl.setAccess('s1', doc.id, 'read')).toBe(true)

    // 手改 skill 行的访问方式，再让对账跑（派生输入变一点）
    db().prepare("UPDATE session_acl SET access = 'write' WHERE source = 'skill'").run()
    baseDerived('s1', [
      { source: 'document', sourceKey: '', target: '/doc.md', access: 'write' },
      { source: 'knowledge', sourceKey: 'k', target: '/kb/k', access: 'read' }
    ])
    expect(shape('s1')).toEqual([
      'document::/doc.md:read',
      'knowledge:k:/kb/k:read',
      'skill:/skills:/skills:read',
      'system:tmp:/private/tmp/x/s1:write',
      `workdir::${WS}:read`
    ])
  })

  it('ACL-4 grantPath：合并访问方式、按来源键区分、坏输入回 null、真改才广播', () => {
    addSession('s1')
    sessionAcl.initialize('s1')

    const read = sessionAcl.grantPath('s1', '/data', 'read')
    expect(read).toMatchObject({
      source: 'user',
      sourceKey: '',
      target: '/data',
      access: 'read',
      kind: 'path'
    })
    expect(holder.broadcasts).toEqual(['s1'])

    const widened = sessionAcl.grantPath('s1', '/data', 'write')
    expect(widened).toMatchObject({ id: read!.id, access: 'write' })
    expect(holder.broadcasts).toEqual(['s1', 's1'])

    // 写之后再授予读：不降级、不广播
    expect(sessionAcl.grantPath('s1', '/data', 'read')).toMatchObject({ access: 'write' })
    expect(holder.broadcasts).toHaveLength(2)

    // widget 来源按 sourceKey 区分，与 user 行共存
    sessionAcl.grantPath('s1', '/data', 'write', { source: 'widget', sourceKey: 'w1' })
    sessionAcl.grantPath('s1', '/data', 'write', { source: 'widget', sourceKey: 'w1' })
    expect(sessionAcl.entries('s1').filter((e) => e.target === '/data')).toHaveLength(2)

    expect(sessionAcl.grantPath('s1', 'relative/path', 'read')).toBeNull()
    expect(sessionAcl.grantPath('nobody', '/x', 'read')).toBeNull()
    expect(rowCount('nobody')).toBe(0)
  })

  it('ACL-5 setAccess：授予行与工作目录行能改；其余派生行不能；未变不写', () => {
    addSession('s1')
    baseDerived('s1', [{ source: 'knowledge', sourceKey: 'k', target: '/kb', access: 'write' }])
    sessionAcl.initialize('s1')
    const granted = sessionAcl.grantPath('s1', '/g', 'write')!
    holder.broadcasts.length = 0
    const bySource = (s: string): AclEntry => sessionAcl.entries('s1').find((e) => e.source === s)!

    expect(sessionAcl.setAccess('s1', granted.id, 'read')).toBe(true)
    expect(sessionAcl.setAccess('s1', granted.id, 'read')).toBe(false)
    expect(sessionAcl.setAccess('s1', bySource('workdir').id, 'read')).toBe(true)
    for (const source of ['system', 'knowledge', 'skill']) {
      expect(sessionAcl.setAccess('s1', bySource(source).id, 'read'), source).toBe(false)
    }
    expect(sessionAcl.setAccess('s1', 'missing', 'read')).toBe(false)
    expect(holder.broadcasts).toEqual(['s1', 's1'])
  })

  it('ACL-6 remove：授予行能删，派生行不能', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    const granted = sessionAcl.grantPath('s1', '/g', 'read')!
    const widget = sessionAcl.grantPath('s1', '/w', 'write', { source: 'widget', sourceKey: 'w' })!

    for (const e of sessionAcl
      .entries('s1')
      .filter((e) => !['user', 'widget'].includes(e.source))) {
      expect(sessionAcl.remove('s1', e.id), e.source).toBe(false)
    }
    expect(sessionAcl.remove('s1', granted.id)).toBe(true)
    expect(sessionAcl.remove('s1', widget.id)).toBe(true)
    expect(sessionAcl.remove('s1', granted.id)).toBe(false)
    expect(shape('s1')).toHaveLength(3)
  })

  it('ACL-7 pathView 写隐含读；sandboxEntries 标出授予行', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    sessionAcl.grantPath('s1', '/granted-read', 'read')
    sessionAcl.grantPath('s1', '/granted-write', 'write')

    const view = sessionAcl.pathView('s1')
    expect(view.write.sort()).toEqual([WS, '/granted-write', '/private/tmp/x/s1'].sort())
    expect(view.read.sort()).toEqual(
      [WS, '/granted-read', '/granted-write', '/private/tmp/x/s1', '/skills'].sort()
    )

    const sandbox = sessionAcl.sandboxEntries('s1')
    expect(sandbox).toEqual(
      expect.arrayContaining([
        { path: WS, access: 'write', granted: false },
        { path: '/skills', access: 'read', granted: false },
        { path: '/granted-read', access: 'read', granted: true },
        { path: '/granted-write', access: 'write', granted: true }
      ])
    )
    // 笔记本文档也要过沙箱的可写根检查（它可能指向任何地方）
    baseDerived('s1', [{ source: 'document', sourceKey: '', target: '/doc.md', access: 'write' }])
    expect(sessionAcl.sandboxEntries('s1')).toContainEqual({
      path: '/doc.md',
      access: 'write',
      granted: true
    })
  })

  it('ACL-8 子会话复制父会话的授予行，派生行自己派生', () => {
    addSession('parent')
    baseDerived('parent', [{ source: 'knowledge', sourceKey: 'k', target: '/kb', access: 'write' }])
    sessionAcl.initialize('parent')
    const parentGrant = sessionAcl.grantPath('parent', '/shared', 'write')!
    sessionAcl.grantPath('parent', '/w', 'write', { source: 'widget', sourceKey: 'w' })
    const parentWorkdir = sessionAcl.entries('parent').find((e) => e.source === 'workdir')!
    sessionAcl.setAccess('parent', parentWorkdir.id, 'read')

    addSession('child', { parentId: 'parent' })
    holder.derived.set('child', [
      { source: 'workdir', sourceKey: '', target: WS, access: 'write' },
      { source: 'system', sourceKey: 'tmp', target: '/private/tmp/x/child', access: 'write' }
    ])
    sessionAcl.initialize('child', { sessionId: 'parent', fork: false })

    expect(shape('child')).toEqual([
      'system:tmp:/private/tmp/x/child:write',
      'user::/shared:write',
      'widget:w:/w:write',
      // 工作目录的访问方式不随子会话继承：子会话按自己的派生给默认
      `workdir::${WS}:write`
    ])
    const copied = sessionAcl.entries('child').find((e) => e.target === '/shared')!
    expect(copied.id).not.toBe(parentGrant.id)
    expect(copied.sessionId).toBe('child')

    // 之后各管各的
    sessionAcl.grantPath('parent', '/later', 'read')
    expect(shape('child')).not.toContain('user::/later:read')
  })

  it('ACL-9 fork 复制授予行与工作目录行的访问方式', () => {
    addSession('src')
    baseDerived('src')
    sessionAcl.initialize('src')
    sessionAcl.grantPath('src', '/g', 'read')
    const workdir = sessionAcl.entries('src').find((e) => e.source === 'workdir')!
    sessionAcl.setAccess('src', workdir.id, 'read')

    addSession('fork')
    baseDerived('fork')
    sessionAcl.initialize('fork', { sessionId: 'src', fork: true })
    expect(shape('fork')).toEqual([
      'skill:/skills:/skills:read',
      'system:tmp:/private/tmp/x/fork:write',
      'user::/g:read',
      `workdir::${WS}:read`
    ])
  })

  it('ACL-10 内存会话的表在内存里，从不落库；删除后没了', () => {
    addSession('mem', { ephemeral: true })
    baseDerived('mem')
    sessionAcl.initialize('mem')
    sessionAcl.grantPath('mem', '/g', 'write')
    expect(shape('mem')).toContain('user::/g:write')
    expect(rowCount()).toBe(0)

    // 内存会话的子会话同为内存会话，继承照样走内存
    addSession('mem-child', { ephemeral: true, parentId: 'mem' })
    sessionAcl.initialize('mem-child', { sessionId: 'mem', fork: false })
    expect(shape('mem-child')).toContain('user::/g:write')
    expect(rowCount()).toBe(0)

    sessionAcl.deleteSession('mem')
    sessionRecords.deleteById('mem')
    expect(sessionAcl.entries('mem')).toEqual([])
    expect(sessionAcl.grantPath('mem', '/x', 'read')).toBeNull()
    expect(rowCount()).toBe(0)
  })

  it('ACL-11 deleteSession 清表；删掉的会话读出空表、不补行', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    sessionAcl.grantPath('s1', '/g', 'read')
    addSession('s2')
    sessionAcl.initialize('s2')
    sessionAcl.grantPath('s2', '/g', 'read')

    sessionAcl.deleteSession('s1')
    sessionRecords.deleteById('s1')
    expect(rowCount('s1')).toBe(0)
    expect(sessionAcl.entries('s1')).toEqual([])
    expect(sessionAcl.pathView('s1')).toEqual({ read: [], write: [] })
    expect(rowCount('s1')).toBe(0)
    expect(rowCount('s2')).toBe(1)
  })

  it('ACL-12 坏 id / 不存在的会话：空表，不碰存储', () => {
    for (const id of ['', '..', 'a/b', 'nobody']) {
      holder.derived.set(id, [
        { source: 'system', sourceKey: 'tmp', target: '/t', access: 'write' }
      ])
      expect(sessionAcl.entries(id), id).toEqual([])
      sessionAcl.initialize(id)
    }
    expect(rowCount()).toBe(0)
  })

  it('ACL-13 对账失败：保持上一次的表，下一次读再试', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    const before = shape('s1')

    baseDerived('s1', [{ source: 'knowledge', sourceKey: 'k', target: '/kb', access: 'write' }])
    const prepare = db().prepare.bind(db())
    const spy = vi.spyOn(db(), 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('INSERT INTO session_acl')) throw new Error('database is locked')
      return prepare(sql)
    })
    expect(shape('s1')).toEqual(before)
    spy.mockRestore()

    expect(shape('s1')).toContain('knowledge:k:/kb:write')
  })
})
