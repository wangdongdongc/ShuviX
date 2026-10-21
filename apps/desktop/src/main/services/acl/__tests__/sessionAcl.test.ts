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
 *
 * 会话种类的行（XS-27…XS-33）见文件末尾的 describe 块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  derived: new Map<string, Array<Record<string, string>>>(),
  /** derivePathEntries 被问到的会话（XS-28：sessionGrants 不对账） */
  deriveCalls: [] as string[],
  broadcasts: [] as string[],
  /** logger.warn 收到的文案（XS-33：按目标删失败只记一条 warn） */
  warns: [] as string[]
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
  createLogger: () => ({
    info: () => {},
    warn: (msg: string) => holder.warns.push(msg),
    error: () => {}
  })
}))
vi.mock('../../../utils/sessionConfigBroadcast', () => ({
  broadcastSessionConfigChanged: (id: string) => holder.broadcasts.push(id)
}))
vi.mock('../derive', () => ({
  derivePathEntries: (sessionId: string) => {
    holder.deriveCalls.push(sessionId)
    return holder.derived.get(sessionId) ?? []
  },
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

function addSession(
  id: string,
  opts: { ephemeral?: boolean; parentId?: string; title?: string } = {}
): void {
  const session: Session = {
    id,
    title: opts.title ?? id,
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
  holder.deriveCalls.length = 0
  holder.broadcasts.length = 0
  holder.warns.length = 0
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

/**
 * 会话种类的行（kind: 'session'，target = 另一条会话的 id）—— `session` 工具经「允许并记住」免询问地查看（read）/
 * 对话（write）一条别的会话。来源恒为 user，没有派生的会话行。
 *
 *   XS-27 grantSession：新行 {kind session, target, access, source user, sourceKey ''}，广播调用方一次；对话压过查看
 *         （同一行、updatedAt 刷新、广播）；查看不降级对话（交回原行，不写库不广播）；自己、目标不在、调用方不在、
 *         坏 id → null，什么都不写、不广播
 *   XS-28 sessionView：对话隐含查看；sessionGrants / sessionView 直接读存储、不对账（derive 不调，派生行不动）；
 *         会话行不进 pathView / sandboxEntries，路径行（哪怕目标字面是一条会话的 id）不进 sessionView；
 *         不在的会话 → 空（存储里的残留行也不交出）
 *   XS-29 对账（派生输入变了）不碰会话行：同 id、同访问方式
 *   XS-30 setAccess：会话行 查看 ↔ 对话（true + 广播）；remove true；sessionView 跟着变
 *   XS-31 entriesForDisplay：会话行带目标此刻的标题（改名即反映）；路径行没有 targetTitle 键；目标已删 → 没有；
 *         entries() 从不带
 *   XS-32 继承：子会话 / fork 复制源会话的会话行（新 id、自己的 sessionId、同目标同访问方式）；之后各管各的；
 *         别的表里指向源会话的行不复制
 *   XS-33 deleteSession(B)：库里的 A、内存会话 M 里指向 B 的会话行删掉；指向 C 的、目标字面恰为 'B' 的路径行不动；
 *         B 自己的表清空；按目标删的语句抛错 → 不抛、记一条 warn、B 自己的表照样清空
 */
describe('sessionAcl —— 会话种类的行', () => {
  /** 原样插一行（绕过服务层：路径行的目标可以不是绝对路径、会话可以不在） */
  const rawRow = (sessionId: string, kind: string, target: string, access: string): void => {
    db()
      .prepare(
        `INSERT INTO session_acl (id, sessionId, kind, target, access, source, sourceKey, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, 'user', '', 1, 1)`
      )
      .run(`raw-${sessionId}-${kind}-${target}`, sessionId, kind, target, access)
  }
  /** 库里所有指向 target 的某种行属于哪些会话（排好序） */
  const holdersOf = (target: string, kind = 'session'): string[] =>
    (
      db()
        .prepare(
          'SELECT sessionId FROM session_acl WHERE kind = ? AND target = ? ORDER BY sessionId'
        )
        .all(kind, target) as Array<{ sessionId: string }>
    ).map((r) => r.sessionId)
  /** 一条会话表里的行：`kind:target:access`（排好序） */
  const kinds = (sessionId: string): string[] =>
    sessionAcl
      .entries(sessionId)
      .map((e) => `${e.kind}:${e.target}:${e.access}`)
      .sort()
  /** 记下这期间 prepare 过的写语句 */
  function recordWrites(): { writes: string[]; restore: () => void } {
    const prepare = db().prepare.bind(db())
    const writes: string[] = []
    const spy = vi.spyOn(db(), 'prepare').mockImplementation((sql: string) => {
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) writes.push(sql)
      return prepare(sql)
    })
    return { writes, restore: () => spy.mockRestore() }
  }

  it('XS-27 grantSession：新行、广播调用方一次；对话压过查看（同一行、updatedAt 刷新、广播）；查看不降级对话（原行，不写不广播）', () => {
    addSession('A')
    addSession('B')
    sessionAcl.initialize('A')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const read = sessionAcl.grantSession('A', 'B', 'read')
      expect(read).toEqual({
        id: expect.any(String),
        sessionId: 'A',
        kind: 'session',
        target: 'B',
        access: 'read',
        source: 'user',
        sourceKey: '',
        createdAt: 1_000,
        updatedAt: 1_000
      })
      expect(holder.broadcasts).toEqual(['A'])
      // 落库的就是交回的那一行；目标会话自己的表不动
      expect(sessionAcl.entries('A')).toEqual([read])
      expect(rowCount('B')).toBe(0)

      clock.mockReturnValue(2_000)
      const widened = sessionAcl.grantSession('A', 'B', 'write')
      expect(widened).toEqual({ ...read, access: 'write', updatedAt: 2_000 })
      expect(holder.broadcasts).toEqual(['A', 'A'])
      expect(sessionAcl.entries('A')).toEqual([widened])

      // 对话之后再授予查看：交回原行，不写库、不广播
      clock.mockReturnValue(3_000)
      const rec = recordWrites()
      let again: AclEntry | null = null
      try {
        again = sessionAcl.grantSession('A', 'B', 'read')
      } finally {
        rec.restore()
      }
      expect(again).toEqual(widened)
      expect(rec.writes).toEqual([])
      expect(holder.broadcasts).toEqual(['A', 'A'])
      expect(sessionAcl.entries('A')).toEqual([widened])
    } finally {
      clock.mockRestore()
    }
  })

  it('XS-27 自己、目标不在（含已删）、调用方不在、坏 id（哪怕有那条会话行）→ null；什么都不写、不广播', () => {
    addSession('A')
    addSession('B')
    addSession('gone')
    sessionRecords.deleteById('gone')
    // 坏 id 的会话行真的在库里：拦住它的是 id 校验，不是「找不到」
    addSession('../x')
    sessionAcl.initialize('A')
    const cases: Array<[string, string]> = [
      ['A', 'A'],
      ['A', 'nobody'],
      ['A', 'gone'],
      ['nobody', 'B'],
      ['gone', 'B'],
      ['A', '../x'],
      ['../x', 'B'],
      ['A', '']
    ]
    for (const [caller, target] of cases) {
      for (const access of ['read', 'write'] as const) {
        expect(
          sessionAcl.grantSession(caller, target, access),
          `${caller}→${target} ${access}`
        ).toBe(null)
      }
    }
    expect(rowCount()).toBe(0)
    expect(holder.broadcasts).toEqual([])
  })

  it('XS-28 sessionView：对话隐含查看；会话行不进 pathView / sandboxEntries，路径行不进 sessionView', () => {
    addSession('A')
    addSession('B')
    addSession('C')
    addSession('D')
    baseDerived('A')
    sessionAcl.initialize('A')
    sessionAcl.grantSession('A', 'B', 'write')
    sessionAcl.grantSession('A', 'C', 'read')
    sessionAcl.grantPath('A', '/data', 'write')

    expect(sessionAcl.sessionView('A')).toEqual({ read: ['B', 'C'], write: ['B'] })
    expect(sessionAcl.sessionGrants('A').map((e) => `${e.kind}:${e.target}:${e.access}`)).toEqual([
      'session:B:write',
      'session:C:read'
    ])

    const paths = sessionAcl.pathView('A')
    expect(paths.read.sort()).toEqual([WS, '/data', '/private/tmp/x/A', '/skills'].sort())
    expect(paths.write.sort()).toEqual([WS, '/data', '/private/tmp/x/A'].sort())
    expect(
      sessionAcl
        .sandboxEntries('A')
        .map((e) => e.path)
        .sort()
    ).toEqual([WS, '/data', '/private/tmp/x/A', '/skills'].sort())

    // 一行路径的目标字面恰是一条会话的 id：照样只是路径，不进 sessionView / sessionGrants
    rawRow('A', 'path', 'D', 'write')
    expect(sessionAcl.pathView('A').write).toContain('D')
    expect(sessionAcl.sessionView('A')).toEqual({ read: ['B', 'C'], write: ['B'] })
    expect(sessionAcl.sessionGrants('A').every((e) => e.kind === 'session')).toBe(true)
    expect(sessionAcl.sessionGrants('A')).toHaveLength(2)
  })

  it('XS-28 sessionGrants / sessionView 直接读存储、不对账：derive 不调，派生行不动；entries 才对账', () => {
    addSession('A')
    addSession('B')
    baseDerived('A')
    sessionAcl.initialize('A')
    const granted = sessionAcl.grantSession('A', 'B', 'read')!
    // 派生输入变了、对账记忆也忘了 —— 任何一次「先对账的读」都会写库
    baseDerived('A', [{ source: 'knowledge', sourceKey: 'k', target: '/kb', access: 'write' }])
    sessionAcl.forgetReconciled('A')
    holder.deriveCalls.length = 0
    const before = rowCount('A')

    const rec = recordWrites()
    try {
      expect(sessionAcl.sessionGrants('A')).toEqual([granted])
      expect(sessionAcl.sessionView('A')).toEqual({ read: ['B'], write: [] })
    } finally {
      rec.restore()
    }
    expect(holder.deriveCalls).toEqual([])
    expect(rec.writes).toEqual([])
    expect(rowCount('A')).toBe(before)
    expect(holdersOf('/kb', 'path')).toEqual([])

    // 对照：entries 先对账，派生的知识库行这才补上
    expect(shape('A')).toContain('knowledge:k:/kb:write')
    expect(holder.deriveCalls).toEqual(['A'])
  })

  it('XS-28 不在的会话（没有会话行 / 坏 id）→ 空；存储里的残留行也不交出、不动', () => {
    rawRow('ghost', 'session', 'B', 'write')
    for (const id of ['ghost', 'nobody', '', '..', 'a/b']) {
      expect(sessionAcl.sessionGrants(id), id).toEqual([])
      expect(sessionAcl.sessionView(id), id).toEqual({ read: [], write: [] })
    }
    expect(rowCount('ghost')).toBe(1)
    expect(holder.deriveCalls).toEqual([])
  })

  it('XS-29 对账（派生输入变了）不碰会话行：同 id、同访问方式', () => {
    addSession('A')
    addSession('B')
    addSession('C')
    baseDerived('A')
    sessionAcl.initialize('A')
    const b = sessionAcl.grantSession('A', 'B', 'write')!
    const c = sessionAcl.grantSession('A', 'C', 'read')!

    // 工作目录换了、技能目录没了、勾上一个知识库
    holder.derived.set('A', [
      { source: 'workdir', sourceKey: '', target: '/other', access: 'write' },
      { source: 'system', sourceKey: 'tmp', target: '/private/tmp/x/A', access: 'write' },
      { source: 'knowledge', sourceKey: 'k', target: '/kb', access: 'read' }
    ])
    expect(shape('A')).toEqual([
      'knowledge:k:/kb:read',
      'system:tmp:/private/tmp/x/A:write',
      'user::B:write',
      'user::C:read',
      'workdir::/other:write'
    ])
    expect(sessionAcl.sessionGrants('A')).toEqual([b, c])

    // 派生行全没了（会话的设置什么都不给）：会话行照旧
    holder.derived.set('A', [])
    expect(sessionAcl.entries('A')).toEqual([b, c])
    // 重启后（对账记忆清空）再对一次：同样
    sessionAcl.forgetReconciled('A')
    expect(sessionAcl.entries('A')).toEqual([b, c])
  })

  it('XS-30 setAccess：会话行查看 ↔ 对话（true + 广播）；remove true；sessionView 跟着变', () => {
    addSession('A')
    addSession('B')
    sessionAcl.initialize('A')
    const row = sessionAcl.grantSession('A', 'B', 'read')!
    holder.broadcasts.length = 0

    expect(sessionAcl.setAccess('A', row.id, 'write')).toBe(true)
    expect(holder.broadcasts).toEqual(['A'])
    expect(sessionAcl.sessionView('A')).toEqual({ read: ['B'], write: ['B'] })
    // 没变不写、不广播；别的会话按 id 改不到这一行
    expect(sessionAcl.setAccess('A', row.id, 'write')).toBe(false)
    expect(sessionAcl.setAccess('B', row.id, 'read')).toBe(false)
    expect(sessionAcl.remove('B', row.id)).toBe(false)
    expect(holder.broadcasts).toEqual(['A'])

    expect(sessionAcl.setAccess('A', row.id, 'read')).toBe(true)
    expect(holder.broadcasts).toEqual(['A', 'A'])
    expect(sessionAcl.sessionView('A')).toEqual({ read: ['B'], write: [] })

    expect(sessionAcl.remove('A', row.id)).toBe(true)
    expect(holder.broadcasts).toEqual(['A', 'A', 'A'])
    expect(sessionAcl.sessionView('A')).toEqual({ read: [], write: [] })
    expect(sessionAcl.remove('A', row.id)).toBe(false)
    expect(rowCount('A')).toBe(0)
  })

  it('XS-31 entriesForDisplay：会话行带目标此刻的标题（改名即反映）；路径行没有 targetTitle 键；目标已删 → 没有；entries 从不带', () => {
    addSession('A')
    addSession('B', { title: 'Plan the release' })
    addSession('C', { title: 'Soon gone' })
    baseDerived('A')
    sessionAcl.initialize('A')
    sessionAcl.grantSession('A', 'B', 'write')
    sessionAcl.grantSession('A', 'C', 'read')
    sessionAcl.grantPath('A', '/data', 'read')
    const display = (): AclEntry[] => sessionAcl.entriesForDisplay('A')
    const shown = (target: string): AclEntry => display().find((e) => e.target === target)!

    expect(shown('B')).toMatchObject({ kind: 'session', targetTitle: 'Plan the release' })
    expect(shown('C')).toMatchObject({ kind: 'session', targetTitle: 'Soon gone' })
    const pathRows = display().filter((e) => e.kind === 'path')
    expect(pathRows).toHaveLength(4)
    for (const e of pathRows) expect(e, e.target).not.toHaveProperty('targetTitle')

    // 改名：下一次读就是新标题（不落库，现查）
    sessionRecords.updateTitle('B', 'Release v2')
    expect(shown('B').targetTitle).toBe('Release v2')

    // 目标会话没了（行还在）：没有 targetTitle 键，其余照旧
    sessionRecords.deleteById('C')
    expect(shown('C')).toMatchObject({ kind: 'session', target: 'C', access: 'read' })
    expect(shown('C')).not.toHaveProperty('targetTitle')

    // entries() 从不带；display 除了 targetTitle 与 entries 逐行相同
    const entries = sessionAcl.entries('A')
    for (const e of entries) expect(e, e.target).not.toHaveProperty('targetTitle')
    expect(
      display().map((e) => {
        const rest: Partial<AclEntry> = { ...e }
        delete rest.targetTitle
        return rest
      })
    ).toEqual(entries)
  })

  it('XS-32 子会话 / fork 复制源会话的会话行（新 id、自己的 sessionId、同目标同访问方式）；之后各管各的；别处指向源会话的行不复制', () => {
    for (const id of ['P', 'T', 'U', 'X']) addSession(id)
    sessionAcl.initialize('P')
    sessionAcl.initialize('X')
    const pt = sessionAcl.grantSession('P', 'T', 'write')!
    const pu = sessionAcl.grantSession('P', 'U', 'read')!
    // 别的会话里授权与 P 交互的那一行
    sessionAcl.grantSession('X', 'P', 'write')

    addSession('child', { parentId: 'P' })
    sessionAcl.initialize('child', { sessionId: 'P', fork: false })
    addSession('fork')
    sessionAcl.initialize('fork', { sessionId: 'P', fork: true })

    const copiedIds: string[] = []
    for (const id of ['child', 'fork']) {
      const rows = sessionAcl.sessionGrants(id)
      expect(
        rows.map((e) => [e.sessionId, e.kind, e.target, e.access, e.source, e.sourceKey]),
        id
      ).toEqual([
        [id, 'session', 'T', 'write', 'user', ''],
        [id, 'session', 'U', 'read', 'user', '']
      ])
      copiedIds.push(...rows.map((e) => e.id))
    }
    // 每一行都是新 id（与源会话的、彼此的都不同）
    expect(new Set([pt.id, pu.id, ...copiedIds]).size).toBe(6)
    // X → P 那一行不被复制成 X → child / X → fork；源会话的行也没有被改指向
    expect(holdersOf('child')).toEqual([])
    expect(holdersOf('fork')).toEqual([])
    expect(holdersOf('P')).toEqual(['X'])
    expect(sessionAcl.sessionView('X')).toEqual({ read: ['P'], write: ['P'] })

    // 之后各管各的：源会话改 / 删不影响副本，副本删也不影响源会话
    sessionAcl.setAccess('P', pt.id, 'read')
    sessionAcl.remove('P', pu.id)
    const both = { read: ['T', 'U'], write: ['T'] }
    expect(sessionAcl.sessionView('child')).toEqual(both)
    expect(sessionAcl.sessionView('fork')).toEqual(both)
    const childT = sessionAcl.sessionGrants('child').find((e) => e.target === 'T')!
    sessionAcl.remove('child', childT.id)
    expect(sessionAcl.sessionView('child')).toEqual({ read: ['U'], write: [] })
    expect(sessionAcl.sessionView('fork')).toEqual(both)
    expect(sessionAcl.sessionView('P')).toEqual({ read: ['T'], write: [] })
  })

  it("XS-33 deleteSession(B)：库里 A 与内存会话 M 里指向 B 的会话行删掉；指向 C 的、目标字面为 'B' 的路径行不动；B 自己的表清空", () => {
    addSession('A')
    addSession('B')
    addSession('C')
    addSession('M', { ephemeral: true })
    baseDerived('B')
    for (const id of ['A', 'B', 'C', 'M']) sessionAcl.initialize(id)
    sessionAcl.grantSession('A', 'B', 'write')
    sessionAcl.grantSession('A', 'C', 'read')
    sessionAcl.grantSession('M', 'B', 'read')
    sessionAcl.grantSession('M', 'C', 'write')
    sessionAcl.grantSession('B', 'C', 'write')
    sessionAcl.grantSession('C', 'B', 'read')
    rawRow('A', 'path', 'B', 'read')
    // 前提：B 自己的表有派生行与一行会话行；内存会话 M 的行不在库里
    expect(rowCount('B')).toBe(4)
    expect(rowCount('M')).toBe(0)
    expect(kinds('M')).toEqual(['session:B:read', 'session:C:write'])

    sessionAcl.deleteSession('B')
    sessionRecords.deleteById('B')

    expect(rowCount('B')).toBe(0)
    expect(sessionAcl.entries('B')).toEqual([])
    expect(holdersOf('B')).toEqual([])
    expect(kinds('A')).toEqual(['path:B:read', 'session:C:read'])
    expect(kinds('C')).toEqual([])
    expect(kinds('M')).toEqual(['session:C:write'])
    expect(sessionAcl.sessionView('M')).toEqual({ read: ['C'], write: ['C'] })
    expect(holder.warns).toEqual([])
  })

  it('XS-33 按目标删的语句抛错：deleteSession 不抛、记一条 warn，B 自己的表照样清空', () => {
    addSession('A')
    addSession('B')
    addSession('C')
    baseDerived('B')
    sessionAcl.initialize('A')
    sessionAcl.initialize('B')
    sessionAcl.grantSession('A', 'B', 'write')
    sessionAcl.grantSession('B', 'C', 'read')
    expect(rowCount('B')).toBe(4)

    const prepare = db().prepare.bind(db())
    const spy = vi.spyOn(db(), 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('DELETE FROM session_acl WHERE kind = ?')) {
        throw new Error('database is locked')
      }
      return prepare(sql)
    })
    try {
      expect(() => sessionAcl.deleteSession('B')).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(holder.warns).toEqual(['acl forget target failed session=B: database is locked'])
    expect(rowCount('B')).toBe(0)
    // 删不掉的那一行只指向一条已不存在的会话（不放出任何权限）：留在 A 的表里
    expect(holdersOf('B')).toEqual(['A'])
  })
})
