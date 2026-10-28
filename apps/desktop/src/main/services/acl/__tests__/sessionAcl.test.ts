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
 * 会话种类的行（XS-27…XS-33）与组件种类的行（WT4-AC-03…WT4-AC-12）见文件末尾的两个 describe 块。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const holder = vi.hoisted(() => ({
  db: null as unknown,
  derived: new Map<string, Array<Record<string, string>>>(),
  /** derivePathEntries 被问到的会话（XS-28：sessionGrants 不对账） */
  deriveCalls: [] as string[],
  /** derivePathEntries 收到的 (会话, 有读写授权的组件) —— 组件源码目录跟着读写授权走（WT4-AC-07/10/11） */
  deriveWidgets: [] as Array<[string, string[]]>,
  /** widgetRegistry.findById 的替身数据：组件 id → 记录（WT4-AC-09 的 targetTitle） */
  widgets: new Map<string, { id: string; name: string; archivedAt: number }>(),
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
  // 与真实的 derive 同形：有读写授权的组件各派生一行可写的源码目录（widgetDir，sourceKey = 组件 id）
  derivePathEntries: (sessionId: string, writableWidgets: readonly string[] = []) => {
    holder.deriveCalls.push(sessionId)
    holder.deriveWidgets.push([sessionId, [...writableWidgets]])
    return [
      ...(holder.derived.get(sessionId) ?? []),
      ...writableWidgets.map((id) => ({
        source: 'widgetDir',
        sourceKey: id,
        target: `/widgets/${id}`,
        access: 'write'
      }))
    ]
  },
  derivedKey: (e: { source: string; sourceKey: string; target: string }) =>
    `${e.source}\u0000${e.sourceKey}\u0000${e.target}`
}))

// 组件名（entriesForDisplay 的 targetTitle）从注册表现查：换成可控的表；id 规范照用真的
vi.mock('../../widget/widgetRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../widget/widgetRegistry')>()
  return {
    ...actual,
    widgetRegistry: { findById: (id: string) => holder.widgets.get(id) }
  }
})

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
  holder.deriveWidgets.length = 0
  holder.widgets.clear()
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
    sessionAcl.grantWidget('parent', 'my-widget', 'read', 'widget')
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
      'widget:my-widget:my-widget:read',
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

/**
 * 组件种类的行（kind: 'widget'，target = 组件 id）—— `widget` 工具经「允许并记住」（来源 user）或会话自己
 * `create` 了它（来源 widget，sourceKey = 组件 id）免询问地只读（read）/ 读写（write）一个组件。读写行派生出它
 * 源码目录的可写行（widgetDir）：derive 收到的第二个参数就是表里有读写授权的组件（这里的 derive 替身与真的同形，
 * 每个给一行 `/widgets/<id>`）。
 *
 *   WT4-AC-03 grantWidget（来源缺省 user）：新行 {widget, id, read, user, ''}、广播一次；再授予 write → 同一行放宽、
 *             updatedAt 刷新、广播；再授予 read → 交回读写那一行，不写库、不广播
 *   WT4-AC-04 create 的授予（来源 widget，sourceKey = 组件 id）与同一组件的 user 只读行并存两行；widgetAccess 取宽的；
 *             删掉 widget 来源那一行剩 read
 *   WT4-AC-05 不合规的组件 id、不在的会话、坏会话 id → null；什么都不写、不广播
 *   WT4-AC-06 widgetGrants / widgetView / widgetAccess：直接读存储、不对账（derive 不调）；组件行不进 pathView /
 *             sessionView / sandboxEntries，路径 / 会话行不进 widgetView；不在的会话 → 空 / none
 *   WT4-AC-07 源码目录跟着读写授权：只读授权 derive 收到 []；读写授权之后收到 [B]、widgetDir 行补上；降成只读 / 删掉
 *             那一行之后又是 []、widgetDir 行删掉
 *   WT4-AC-08 setAccess / remove：组件行 只读 ↔ 读写（true + 广播）、能删，widgetView 跟着变；widgetDir 行改不了、
 *             删不掉
 *   WT4-AC-09 entriesForDisplay：组件行带组件此刻的名字（改名即反映、归档的照样有名字）；认不出的组件没有
 *             targetTitle 键；路径行没有，会话行照旧带标题；entries() 从不带
 *   WT4-AC-10 继承：子会话 / fork 复制两种组件行（新 id、自己的 sessionId、同目标同访问方式同来源）；父会话的
 *             widgetDir 行不复制，子会话自己对账派生出来；之后各管各的
 *   WT4-AC-11 deleteWidget(B)：库里与内存会话里指向 B 的组件行删掉，每个受影响的会话广播一次；别的组件、目标字面为 B
 *             的路径行、会话行不动；受影响会话下一次读表时 widgetDir 行随之消失；按目标删抛错 → 不抛、记一条 warn
 *   WT4-AC-12 旧版本 CLI 写下的组件目录行（kind path、source widget）：会话在本进程里第一次对账就删掉 —— 不再给写权限；
 *             删组件、同 id 的新组件也继承不到它
 */
describe('sessionAcl —— 组件种类的行', () => {
  /** 原样插一行（绕过服务层） */
  const rawRow = (
    sessionId: string,
    row: { kind: string; target: string; access: string; source?: string; sourceKey?: string }
  ): void => {
    db()
      .prepare(
        `INSERT INTO session_acl (id, sessionId, kind, target, access, source, sourceKey, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
      )
      .run(
        `raw-${sessionId}-${row.kind}-${row.source ?? 'user'}-${row.target}`,
        sessionId,
        row.kind,
        row.target,
        row.access,
        row.source ?? 'user',
        row.sourceKey ?? ''
      )
  }
  /** 一条会话表里的行：`kind:source:sourceKey:target:access`（排好序） */
  const rowsOf = (sessionId: string): string[] =>
    sessionAcl
      .entries(sessionId)
      .map((e) => `${e.kind}:${e.source}:${e.sourceKey}:${e.target}:${e.access}`)
      .sort()
  /** 这条会话表里的 widgetDir 行（先对账） */
  const widgetDirs = (sessionId: string): string[] =>
    sessionAcl
      .entries(sessionId)
      .filter((e) => e.source === 'widgetDir')
      .map((e) => `${e.sourceKey}:${e.target}:${e.access}`)
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

  it('WT4-AC-03 grantWidget：新行、广播一次；读写压过只读（同一行、updatedAt 刷新、广播）；只读不降级读写（原行，不写不广播）', () => {
    addSession('s1')
    sessionAcl.initialize('s1')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const read = sessionAcl.grantWidget('s1', 'reading-list', 'read')
      expect(read).toEqual({
        id: expect.any(String),
        sessionId: 's1',
        kind: 'widget',
        target: 'reading-list',
        access: 'read',
        source: 'user',
        sourceKey: '',
        createdAt: 1_000,
        updatedAt: 1_000
      })
      expect(holder.broadcasts).toEqual(['s1'])
      expect(sessionAcl.widgetGrants('s1')).toEqual([read])

      clock.mockReturnValue(2_000)
      const widened = sessionAcl.grantWidget('s1', 'reading-list', 'write')
      expect(widened).toEqual({ ...read, access: 'write', updatedAt: 2_000 })
      expect(holder.broadcasts).toEqual(['s1', 's1'])
      expect(sessionAcl.widgetGrants('s1')).toEqual([widened])

      // 读写授权派生出源码目录：先让对账把它补上，下面看的只是授予本身写不写库
      expect(widgetDirs('s1')).toEqual(['reading-list:/widgets/reading-list:write'])

      clock.mockReturnValue(3_000)
      const rec = recordWrites()
      let again: AclEntry | null = null
      try {
        again = sessionAcl.grantWidget('s1', 'reading-list', 'read')
      } finally {
        rec.restore()
      }
      expect(again).toEqual(widened)
      expect(rec.writes).toEqual([])
      expect(holder.broadcasts).toEqual(['s1', 's1'])
      expect(sessionAcl.widgetGrants('s1')).toEqual([widened])
    } finally {
      clock.mockRestore()
    }
  })

  it('WT4-AC-04 create 的授予（来源 widget）与 user 只读行并存；widgetAccess 取宽的；删掉 widget 来源那一行剩 read', () => {
    addSession('s1')
    sessionAcl.initialize('s1')
    const created = sessionAcl.grantWidget('s1', 'my-widget', 'write', 'widget')!
    sessionAcl.grantWidget('s1', 'my-widget', 'read')
    expect(
      sessionAcl
        .widgetGrants('s1')
        .map((e) => [e.kind, e.target, e.access, e.source, e.sourceKey])
        .sort()
    ).toEqual([
      ['widget', 'my-widget', 'read', 'user', ''],
      ['widget', 'my-widget', 'write', 'widget', 'my-widget']
    ])
    expect(created).toMatchObject({ source: 'widget', sourceKey: 'my-widget', access: 'write' })
    expect(sessionAcl.widgetAccess('s1', 'my-widget')).toBe('write')
    expect(sessionAcl.widgetView('s1')).toEqual({ read: ['my-widget'], write: ['my-widget'] })

    expect(sessionAcl.remove('s1', created.id)).toBe(true)
    expect(sessionAcl.widgetAccess('s1', 'my-widget')).toBe('read')
    expect(sessionAcl.widgetView('s1')).toEqual({ read: ['my-widget'], write: [] })
  })

  it('WT4-AC-05 不合规的组件 id、不在的会话、坏会话 id → null；什么都不写、不广播', () => {
    addSession('s1')
    // 坏 id 的会话行真的在库里：拦住它的是 id 校验，不是「找不到」
    addSession('../x')
    sessionAcl.initialize('s1')
    const before = rowCount()
    for (const id of ['nodash', 'A-b', '../x-y', '', 'a-', '-a', 'a b-c']) {
      for (const access of ['read', 'write'] as const) {
        expect(sessionAcl.grantWidget('s1', id, access), `${id} ${access}`).toBeNull()
        expect(sessionAcl.grantWidget('s1', id, access, 'widget'), `${id} ${access}`).toBeNull()
      }
    }
    for (const caller of ['nobody', '../x', '', '..']) {
      expect(sessionAcl.grantWidget(caller, 'my-widget', 'write'), caller).toBeNull()
    }
    expect(rowCount()).toBe(before)
    expect(sessionAcl.widgetGrants('s1')).toEqual([])
    expect(holder.broadcasts).toEqual([])
  })

  it('WT4-AC-06 widgetGrants / widgetView / widgetAccess 直接读存储、不对账；组件行与路径 / 会话行各进各的视图', () => {
    addSession('s1')
    addSession('s2')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    sessionAcl.grantWidget('s1', 'w-a', 'read')
    sessionAcl.grantWidget('s1', 'w-b', 'write')
    sessionAcl.grantSession('s1', 's2', 'write')
    sessionAcl.grantPath('s1', '/data', 'write')
    // 路径行的目标字面恰是一个组件 id：照样只是路径
    rawRow('s1', { kind: 'path', target: 'w-c', access: 'write' })

    // 派生输入变了、对账记忆也忘了 —— 任何一次「先对账的读」都会调 derive、写库
    baseDerived('s1', [{ source: 'knowledge', sourceKey: 'k', target: '/kb', access: 'write' }])
    sessionAcl.forgetReconciled('s1')
    holder.deriveCalls.length = 0
    const rec = recordWrites()
    try {
      expect(sessionAcl.widgetAccess('s1', 'w-a')).toBe('read')
      expect(sessionAcl.widgetAccess('s1', 'w-b')).toBe('write')
      expect(sessionAcl.widgetAccess('s1', 'w-c')).toBe('none')
      expect(sessionAcl.widgetView('s1')).toEqual({ read: ['w-a', 'w-b'], write: ['w-b'] })
      expect(sessionAcl.widgetGrants('s1').map((e) => `${e.target}:${e.access}`)).toEqual([
        'w-a:read',
        'w-b:write'
      ])
    } finally {
      rec.restore()
    }
    expect(holder.deriveCalls).toEqual([])
    expect(rec.writes).toEqual([])

    // 别的视图不收组件行（先对账的那几个读这才调 derive）
    const paths = sessionAcl.pathView('s1')
    expect(paths.read).not.toContain('w-a')
    expect(paths.read).not.toContain('w-b')
    expect(paths.write).toContain('w-c')
    expect(sessionAcl.sessionView('s1')).toEqual({ read: ['s2'], write: ['s2'] })
    const sandbox = sessionAcl.sandboxEntries('s1').map((e) => e.path)
    expect(sandbox).not.toContain('w-a')
    expect(sandbox).not.toContain('w-b')
    // 读写授权的组件只以它派生的源码目录进路径那一面
    expect(sandbox).toContain('/widgets/w-b')
    expect(sandbox).not.toContain('/widgets/w-a')

    // 不在的会话：空 / none
    for (const id of ['nobody', '', '..']) {
      expect(sessionAcl.widgetGrants(id), id).toEqual([])
      expect(sessionAcl.widgetView(id), id).toEqual({ read: [], write: [] })
      expect(sessionAcl.widgetAccess(id, 'w-b'), id).toBe('none')
    }
  })

  it('WT4-AC-07 源码目录跟着读写授权：derive 收到的组件随授权变，widgetDir 行补上又删掉', () => {
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    const argsSince = (from: number): string[][] =>
      holder.deriveWidgets.slice(from).map(([sid, widgets]) => {
        expect(sid).toBe('s1')
        return widgets
      })

    let mark = holder.deriveWidgets.length
    sessionAcl.grantWidget('s1', 'w-a', 'read')
    expect(widgetDirs('s1')).toEqual([])
    expect(argsSince(mark).every((w) => w.length === 0)).toBe(true)

    mark = holder.deriveWidgets.length
    const b = sessionAcl.grantWidget('s1', 'w-b', 'write')!
    expect(widgetDirs('s1')).toEqual(['w-b:/widgets/w-b:write'])
    // 授予之前那一次对账还是 []；授予之后的读收到 [w-b]
    expect(argsSince(mark).at(-1)).toEqual(['w-b'])
    const dirRow = sessionAcl.entries('s1').find((e) => e.source === 'widgetDir')!
    expect(dirRow).toMatchObject({ kind: 'path', sourceKey: 'w-b', access: 'write' })

    mark = holder.deriveWidgets.length
    expect(sessionAcl.setAccess('s1', b.id, 'read')).toBe(true)
    expect(widgetDirs('s1')).toEqual([])
    expect(argsSince(mark).at(-1)).toEqual([])
    expect(sessionAcl.entries('s1').some((e) => e.id === dirRow.id)).toBe(false)

    // 再放宽、再删掉那一行：目录行又补上、又删掉
    expect(sessionAcl.setAccess('s1', b.id, 'write')).toBe(true)
    expect(widgetDirs('s1')).toEqual(['w-b:/widgets/w-b:write'])
    mark = holder.deriveWidgets.length
    expect(sessionAcl.remove('s1', b.id)).toBe(true)
    expect(widgetDirs('s1')).toEqual([])
    expect(argsSince(mark).at(-1)).toEqual([])
    // 只读的 w-a 从头到尾没派生过目录
    expect(holder.deriveWidgets.some(([, w]) => w.includes('w-a'))).toBe(false)
  })

  it('WT4-AC-08 setAccess / remove：组件行能改能删、widgetView 跟着变；widgetDir 行改不了、删不掉', () => {
    addSession('s1')
    sessionAcl.initialize('s1')
    const row = sessionAcl.grantWidget('s1', 'w-a', 'read')!
    holder.broadcasts.length = 0

    expect(sessionAcl.setAccess('s1', row.id, 'write')).toBe(true)
    expect(holder.broadcasts).toEqual(['s1'])
    expect(sessionAcl.widgetView('s1')).toEqual({ read: ['w-a'], write: ['w-a'] })

    const dir = sessionAcl.entries('s1').find((e) => e.source === 'widgetDir')!
    expect(dir).toMatchObject({ sourceKey: 'w-a', access: 'write' })
    const before = rowsOf('s1')
    expect(sessionAcl.setAccess('s1', dir.id, 'read')).toBe(false)
    expect(sessionAcl.remove('s1', dir.id)).toBe(false)
    expect(rowsOf('s1')).toEqual(before)
    expect(holder.broadcasts).toEqual(['s1'])

    expect(sessionAcl.setAccess('s1', row.id, 'read')).toBe(true)
    expect(holder.broadcasts).toEqual(['s1', 's1'])
    expect(sessionAcl.widgetView('s1')).toEqual({ read: ['w-a'], write: [] })

    expect(sessionAcl.remove('s1', row.id)).toBe(true)
    expect(holder.broadcasts).toEqual(['s1', 's1', 's1'])
    expect(sessionAcl.widgetView('s1')).toEqual({ read: [], write: [] })
    expect(sessionAcl.remove('s1', row.id)).toBe(false)
    expect(sessionAcl.entries('s1')).toEqual([])
  })

  it('WT4-AC-09 entriesForDisplay：组件行带组件此刻的名字（改名即反映、归档的照样有名字）；认不出的没有 targetTitle；路径行没有、会话行照旧', () => {
    addSession('s1')
    addSession('s2', { title: 'Plan the release' })
    baseDerived('s1')
    sessionAcl.initialize('s1')
    holder.widgets.set('w-a', { id: 'w-a', name: 'Reading list', archivedAt: 0 })
    holder.widgets.set('w-b', { id: 'w-b', name: 'Expenses', archivedAt: 0 })
    sessionAcl.grantWidget('s1', 'w-a', 'read')
    sessionAcl.grantWidget('s1', 'w-b', 'write')
    sessionAcl.grantWidget('s1', 'w-gone', 'read')
    sessionAcl.grantSession('s1', 's2', 'read')
    sessionAcl.grantPath('s1', '/data', 'read')
    const display = (): AclEntry[] => sessionAcl.entriesForDisplay('s1')
    const shown = (kind: string, target: string): AclEntry =>
      display().find((e) => e.kind === kind && e.target === target)!

    expect(shown('widget', 'w-a')).toMatchObject({ targetTitle: 'Reading list', access: 'read' })
    expect(shown('widget', 'w-b')).toMatchObject({ targetTitle: 'Expenses', access: 'write' })
    expect(shown('widget', 'w-gone')).not.toHaveProperty('targetTitle')
    expect(shown('session', 's2')).toMatchObject({ targetTitle: 'Plan the release' })
    const pathRows = display().filter((e) => e.kind === 'path')
    // 派生行（含 w-b 的源码目录）与授予的路径：都没有 targetTitle 键
    expect(pathRows.map((e) => e.target)).toEqual(expect.arrayContaining(['/data', '/widgets/w-b']))
    for (const e of pathRows) expect(e, e.target).not.toHaveProperty('targetTitle')

    // 改名、归档：下一次读就是现在的名字（不落库，现查；归档的组件照样有名字）
    holder.widgets.set('w-a', { id: 'w-a', name: 'Books to read', archivedAt: 0 })
    holder.widgets.set('w-b', { id: 'w-b', name: 'Expenses', archivedAt: 123 })
    expect(shown('widget', 'w-a').targetTitle).toBe('Books to read')
    expect(shown('widget', 'w-b').targetTitle).toBe('Expenses')

    // entries() 从不带；display 除了 targetTitle 与 entries 逐行相同
    const entries = sessionAcl.entries('s1')
    for (const e of entries) expect(e, e.target).not.toHaveProperty('targetTitle')
    expect(
      display().map((e) => {
        const rest: Partial<AclEntry> = { ...e }
        delete rest.targetTitle
        return rest
      })
    ).toEqual(entries)
  })

  it('WT4-AC-10 子会话 / fork 复制两种组件行；父会话的 widgetDir 行不复制、子会话自己派生；之后各管各的', () => {
    addSession('parent')
    sessionAcl.initialize('parent')
    const pa = sessionAcl.grantWidget('parent', 'w-a', 'read')!
    const pb = sessionAcl.grantWidget('parent', 'w-b', 'write', 'widget')!
    expect(widgetDirs('parent')).toEqual(['w-b:/widgets/w-b:write'])
    const parentDir = sessionAcl.entries('parent').find((e) => e.source === 'widgetDir')!

    addSession('child', { parentId: 'parent' })
    addSession('fork')
    holder.deriveWidgets.length = 0
    sessionAcl.initialize('child', { sessionId: 'parent', fork: false })
    sessionAcl.initialize('fork', { sessionId: 'parent', fork: true })

    const copiedIds: string[] = []
    for (const id of ['child', 'fork']) {
      const rows = sessionAcl.widgetGrants(id)
      expect(
        rows
          .map((e) => [e.sessionId, e.kind, e.target, e.access, e.source, e.sourceKey])
          .sort((a, b) => String(a[2]).localeCompare(String(b[2]))),
        id
      ).toEqual([
        [id, 'widget', 'w-a', 'read', 'user', ''],
        [id, 'widget', 'w-b', 'write', 'widget', 'w-b']
      ])
      copiedIds.push(...rows.map((e) => e.id))
      // 自己的对账派生出 w-b 的源码目录（父会话那一行不是复制来的）
      expect(holder.deriveWidgets).toContainEqual([id, ['w-b']])
      const dirs = sessionAcl.entries(id).filter((e) => e.source === 'widgetDir')
      expect(
        dirs.map((e) => `${e.sessionId}:${e.sourceKey}:${e.target}`),
        id
      ).toEqual([`${id}:w-b:/widgets/w-b`])
      expect(dirs[0].id).not.toBe(parentDir.id)
    }
    expect(new Set([pa.id, pb.id, parentDir.id, ...copiedIds]).size).toBe(7)

    // 之后各管各的：父会话降级 / 删行不影响副本
    sessionAcl.setAccess('parent', pb.id, 'read')
    sessionAcl.remove('parent', pa.id)
    expect(sessionAcl.widgetView('parent')).toEqual({ read: ['w-b'], write: [] })
    for (const id of ['child', 'fork']) {
      expect(sessionAcl.widgetView(id), id).toEqual({ read: ['w-a', 'w-b'], write: ['w-b'] })
      expect(widgetDirs(id), id).toEqual(['w-b:/widgets/w-b:write'])
    }
    expect(widgetDirs('parent')).toEqual([])
  })

  it('WT4-AC-11 deleteWidget(B)：库里与内存会话里指向 B 的组件行删掉、每个受影响的会话广播一次；别的行不动；目录行随之消失', () => {
    addSession('A')
    addSession('C')
    addSession('M', { ephemeral: true })
    for (const id of ['A', 'C', 'M']) sessionAcl.initialize(id)
    sessionAcl.grantWidget('A', 'w-b', 'write')
    sessionAcl.grantWidget('A', 'w-b', 'read', 'widget')
    sessionAcl.grantWidget('A', 'w-a', 'write')
    sessionAcl.grantSession('A', 'C', 'read')
    rawRow('A', { kind: 'path', target: 'w-b', access: 'read' })
    sessionAcl.grantWidget('M', 'w-b', 'write')
    sessionAcl.grantWidget('M', 'w-a', 'read')
    sessionAcl.grantWidget('C', 'w-a', 'read')
    // 前提：A 与 M 的表里都有 w-b 的源码目录；M 的行不在库里
    expect(widgetDirs('A').sort()).toEqual(['w-a:/widgets/w-a:write', 'w-b:/widgets/w-b:write'])
    expect(widgetDirs('M')).toEqual(['w-b:/widgets/w-b:write'])
    expect(rowCount('M')).toBe(0)
    holder.broadcasts.length = 0

    sessionAcl.deleteWidget('w-b')

    expect([...holder.broadcasts].sort()).toEqual(['A', 'M'])
    expect(
      (
        db()
          .prepare("SELECT COUNT(*) AS n FROM session_acl WHERE kind = 'widget' AND target = ?")
          .get('w-b') as { n: number }
      ).n
    ).toBe(0)
    expect(sessionAcl.widgetView('A')).toEqual({ read: ['w-a'], write: ['w-a'] })
    expect(sessionAcl.widgetView('M')).toEqual({ read: ['w-a'], write: [] })
    expect(sessionAcl.widgetView('C')).toEqual({ read: ['w-a'], write: [] })

    // 受影响的会话下一次读表：derive 不再收到 w-b，它的源码目录行删掉；别的行照旧
    holder.deriveWidgets.length = 0
    expect(widgetDirs('A')).toEqual(['w-a:/widgets/w-a:write'])
    expect(widgetDirs('M')).toEqual([])
    expect(holder.deriveWidgets).toContainEqual(['A', ['w-a']])
    expect(holder.deriveWidgets).toContainEqual(['M', []])
    expect(rowsOf('A')).toEqual([
      'path:user::w-b:read',
      'path:widgetDir:w-a:/widgets/w-a:write',
      'session:user::C:read',
      'widget:user::w-a:write'
    ])
    expect(holder.warns).toEqual([])
  })

  it('WT4-AC-11 按目标删的语句抛错：deleteWidget 不抛、记一条 warn', () => {
    addSession('A')
    sessionAcl.initialize('A')
    sessionAcl.grantWidget('A', 'w-b', 'write')
    const prepare = db().prepare.bind(db())
    const spy = vi.spyOn(db(), 'prepare').mockImplementation((sql: string) => {
      if (sql.startsWith('DELETE FROM session_acl WHERE kind = ?')) {
        throw new Error('database is locked')
      }
      return prepare(sql)
    })
    try {
      expect(() => sessionAcl.deleteWidget('w-b')).not.toThrow()
    } finally {
      spy.mockRestore()
    }
    expect(holder.warns).toEqual(['acl forget widget failed widget=w-b: database is locked'])
    // 删不掉的那一行只指向一个已不存在的组件：留在表里
    expect(sessionAcl.widgetView('A')).toEqual({ read: ['w-b'], write: ['w-b'] })
  })

  it('WT4-AC-12 旧版本 CLI 的组件目录行（path + source widget）：本进程第一次对账就删掉，不再给写权限；同 id 的新组件也继承不到', () => {
    const LEGACY_DIR = '/Users/u/.shuvix/widgets/w-b'
    addSession('s1')
    baseDerived('s1')
    sessionAcl.initialize('s1')
    // 旧版本写下的行（升级前就在库里）；重启后的第一次读（对账记忆是空的）
    rawRow('s1', {
      kind: 'path',
      target: LEGACY_DIR,
      access: 'write',
      source: 'widget',
      sourceKey: 'w-b'
    })
    sessionAcl.forgetReconciled('s1')

    expect(sessionAcl.pathView('s1').write).not.toContain(LEGACY_DIR)
    expect(sessionAcl.pathView('s1').read).not.toContain(LEGACY_DIR)
    expect(sessionAcl.entries('s1').some((e) => e.kind === 'path' && e.source === 'widget')).toBe(
      false
    )
    expect(
      (
        db().prepare("SELECT COUNT(*) AS n FROM session_acl WHERE source = 'widget'").get() as {
          n: number
        }
      ).n
    ).toBe(0)
    // 不是组件授予：widgetView 里也没有它
    expect(sessionAcl.widgetView('s1')).toEqual({ read: [], write: [] })

    // 删掉组件、同 id 再建一个：这条会话没有任何关于它的授权，源码目录也不派生
    sessionAcl.deleteWidget('w-b')
    expect(sessionAcl.widgetAccess('s1', 'w-b')).toBe('none')
    expect(widgetDirs('s1')).toEqual([])
    expect(sessionAcl.pathView('s1').write).not.toContain(LEGACY_DIR)
    // 组件种类、来源 widget 的行（create 的授予）不受这条清理影响
    sessionAcl.grantWidget('s1', 'w-c', 'write', 'widget')
    sessionAcl.forgetReconciled('s1')
    expect(sessionAcl.widgetView('s1')).toEqual({ read: ['w-c'], write: ['w-c'] })
    expect(widgetDirs('s1')).toEqual(['w-c:/widgets/w-c:write'])
  })

  it('WT4-AC-12 内存会话里的旧行同样在对账时删掉', () => {
    addSession('mem', { ephemeral: true })
    baseDerived('mem')
    sessionAcl.initialize('mem')
    // 内存表不能原样插行：经 grantPath 写一行 path + widget 来源（与旧行同形），再让对账跑
    sessionAcl.grantPath('mem', '/Users/u/.shuvix/widgets/w-b', 'write', {
      source: 'widget',
      sourceKey: 'w-b'
    })
    sessionAcl.forgetReconciled('mem')
    expect(sessionAcl.entries('mem').some((e) => e.source === 'widget')).toBe(false)
    expect(sessionAcl.pathView('mem').write).not.toContain('/Users/u/.shuvix/widgets/w-b')
  })
})
