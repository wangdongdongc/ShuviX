/**
 * 会话权限表（ACL）—— 一条会话的文件访问权的**唯一来源**。形状与规则见 chat-protocol 的 sessionAcl.ts。
 *
 * 读它的三方用的是同一份：
 *   - 安全策略：desktop provider 的 getVars 交出 `vars.aclRead` / `vars.aclWrite`（路径，出厂的
 *     ask-on-external-path 在这以外询问）与 `vars.aclSessionRead` / `vars.aclSessionWrite`（会话，出厂的
 *     ask-on-session-access 在这以外询问）；
 *   - 命令沙箱：planFor 的可读 / 可写根（sandboxEntries）；
 *   - 设置界面：会话的权限表面板（entries）。
 *
 * 派生行（工作目录、会话目录、知识库、技能）**懒对账**：每次有人读这张表，先按会话此刻的设置算一遍应有
 * 的派生行（与从前每次评估现算会话目录同样的开销），与上次对账的结果一样就不碰存储；不一样（勾了新知识
 * 库、启用了技能、会话挪进了项目、换了界面语言……）就在一个事务里补上缺的、删掉过时的。所以「随设置
 * 联动」不需要每个改设置的地方都来通知，全局的技能开关也不必挨个会话去改。新建会话时立即对账一次
 * （「创建时生成权限表」），之后谁先读谁触发。
 *
 * 授予的行（user / widget）只经这里的 grantPath / grantSession / setAccess / remove 改，每次改都广播
 * `session.configChanged`（界面据此重拉）。会话种类的行指向另一条会话：那条会话被删时，所有表里指向它的行一并
 * 删掉（deleteSession）。
 *
 * 继承：派生 agent 与 hook agent 的工具上下文用所在会话的 id，天然共用这张表；子会话建成时复制父会话的
 * 授予行（copyGranted），fork 复制授予行与工作目录那一行的访问方式（copyForFork）。之后各管各的。
 */
import { isAbsolute } from 'path'
import { v7 as uuidv7 } from 'uuid'
import {
  canChangeAclAccess,
  canRemoveAclEntry,
  isDerivedAclSource,
  needsSandboxRootCheck,
  pathAclView,
  sessionAclView,
  widerPathAccess,
  type AclEntry,
  type AclKind,
  type PathAccess,
  type SessionAccess
} from '@shuvix/chat-protocol/sessionAcl'
import { createLogger } from '../../logger'
import { isSafeSessionId } from '../../utils/paths'
import { broadcastSessionConfigChanged } from '../../utils/sessionConfigBroadcast'
import type { SandboxPathEntry } from '../sandbox'
import { sessionRecords } from '../sessionRecords'
import { derivePathEntries, derivedKey, type DerivedPathEntry } from './derive'
import { aclStoreFor, deleteAclEverywhere, deleteTargetEverywhere, type AclStore } from './store'

export { setAclSkillRoots } from './derive'

const log = createLogger('Acl')

/** 授予行的来源 */
export type GrantSource = 'user' | 'widget'

/** 每条会话上次对账的派生行指纹（进程内；重启后第一次读再对一次） */
const reconciled = new Map<string, string>()

/** 这条会话在不在（持久的或活着的内存会话）。不在的会话没有权限表 —— 删除之后迟到的调用不该补出行来 */
function exists(sessionId: string): boolean {
  return isSafeSessionId(sessionId) && !!sessionRecords.pick(sessionId, ['id'])
}

function fingerprint(derived: readonly DerivedPathEntry[]): string {
  return derived.map((e) => `${derivedKey(e)}\u0000${e.access}`).join('\u0001')
}

/**
 * 派生行对账：表里已有、此刻仍应有的留着（工作目录与笔记本文档那一行保留用户改过的访问方式，其余派生行
 * 的访问方式由来源决定 —— 不一致就改回来）；已有、此刻不该有的删掉；应有、还没有的补上。授予行一概不碰。
 */
function reconcile(store: AclStore, sessionId: string, derived: readonly DerivedPathEntry[]): void {
  store.transaction(() => {
    const expected = new Map(derived.map((e) => [derivedKey(e), e]))
    const now = Date.now()
    for (const row of store.list(sessionId)) {
      if (!isDerivedAclSource(row.source)) continue
      const key = derivedKey({ source: row.source, sourceKey: row.sourceKey, target: row.target })
      const want = expected.get(key)
      if (!want) {
        store.delete(sessionId, row.id)
        continue
      }
      expected.delete(key)
      // 用户能改访问方式的派生行（工作目录、笔记本文档）保留用户的值
      if (!canChangeAclAccess(row) && row.access !== want.access) {
        store.updateAccess(sessionId, row.id, want.access, now)
      }
    }
    for (const e of expected.values()) {
      store.insert({
        id: uuidv7(),
        sessionId,
        kind: 'path',
        target: e.target,
        access: e.access,
        source: e.source,
        sourceKey: e.sourceKey,
        createdAt: now,
        updatedAt: now
      })
    }
  })
}

/** 按会话此刻的设置把派生行对齐（指纹没变就什么都不做）。返回这条会话的存储；会话不在返回 null */
function sync(sessionId: string): AclStore | null {
  if (!exists(sessionId)) return null
  const store = aclStoreFor(sessionId)
  const derived = derivePathEntries(sessionId)
  const print = fingerprint(derived)
  if (reconciled.get(sessionId) !== print) {
    try {
      reconcile(store, sessionId, derived)
      reconciled.set(sessionId, print)
    } catch (err) {
      // 对账失败（库被锁之类）：表里保持上一次的样子，下一次读再试 —— 不因此放出更多权限
      log.warn(`acl reconcile failed session=${sessionId}: ${(err as Error).message}`)
    }
  }
  return store
}

/**
 * 授予一行（grantPath / grantSession 共用）：同一来源对同一目标已有一行就合并访问方式（读 + 写 = 写），不另起一行
 */
function grant(
  store: AclStore,
  sessionId: string,
  kind: AclKind,
  target: string,
  access: PathAccess,
  source: GrantSource,
  sourceKey: string
): AclEntry {
  const now = Date.now()
  const existing = store
    .list(sessionId)
    .find(
      (e) =>
        e.kind === kind && e.source === source && e.sourceKey === sourceKey && e.target === target
    )
  if (existing) {
    const merged = widerPathAccess(existing.access, access)
    if (merged === existing.access) return existing
    store.updateAccess(sessionId, existing.id, merged, now)
    log.info(`grant session=${sessionId} ${kind} ${source} ${merged} (widened)`)
    broadcastSessionConfigChanged(sessionId)
    return { ...existing, access: merged, updatedAt: now }
  }
  const entry: AclEntry = {
    id: uuidv7(),
    sessionId,
    kind,
    target,
    access,
    source,
    sourceKey,
    createdAt: now,
    updatedAt: now
  }
  store.insert(entry)
  log.info(`grant session=${sessionId} ${kind} ${source} ${access}`)
  broadcastSessionConfigChanged(sessionId)
  return entry
}

export const sessionAcl = {
  /** 一条会话的全部行（先对账）。会话不在 / 坏 id → 空表 */
  entries(sessionId: string): AclEntry[] {
    return sync(sessionId)?.list(sessionId) ?? []
  },

  /**
   * 交给界面的那一份：会话种类的行带上目标会话此刻的标题（`targetTitle`，不落库；会话已删 → 缺省）
   */
  entriesForDisplay(sessionId: string): AclEntry[] {
    return this.entries(sessionId).map((entry) => {
      if (entry.kind !== 'session') return entry
      const title = sessionRecords.pick(entry.target, ['title'])?.title
      return title === undefined ? entry : { ...entry, targetTitle: title }
    })
  },

  /** 路径的可读 / 可写目录表（策略的 `vars.aclRead` / `vars.aclWrite`；写隐含读） */
  pathView(sessionId: string): { read: string[]; write: string[] } {
    return pathAclView(this.entries(sessionId))
  },

  /**
   * 会话种类的行（这条会话免询问查看 / 对话的别的会话）。它们都是授予的，不用先对账派生行 —— 直接读存储
   */
  sessionGrants(sessionId: string): AclEntry[] {
    if (!exists(sessionId)) return []
    return aclStoreFor(sessionId)
      .list(sessionId)
      .filter((e) => e.kind === 'session')
  },

  /** 会话的可查看 / 可对话 id 表（策略的 `vars.aclSessionRead` / `vars.aclSessionWrite`；对话隐含查看） */
  sessionView(sessionId: string): { read: string[]; write: string[] } {
    return sessionAclView(this.sessionGrants(sessionId))
  },

  /** 交给命令沙箱的路径条目（授予的写还要过「适不适合当可写根」，见 sandbox/spec） */
  sandboxEntries(sessionId: string): SandboxPathEntry[] {
    return this.entries(sessionId)
      .filter((e) => e.kind === 'path')
      .map((e) => ({ path: e.target, access: e.access, granted: needsSandboxRootCheck(e) }))
  },

  /**
   * 授予一条路径（询问卡片上的「允许并记住」、权限表里手动添加、widget 目录）。同一来源对同一路径已有
   * 一行就合并访问方式（读 + 写 = 写），不另起一行。返回那一行；会话不在、路径不是绝对路径 → null
   */
  grantPath(
    sessionId: string,
    path: string,
    access: PathAccess,
    opts: { source?: GrantSource; sourceKey?: string } = {}
  ): AclEntry | null {
    const store = sync(sessionId)
    if (!store || !isAbsolute(path)) return null
    return grant(
      store,
      sessionId,
      'path',
      path,
      access,
      opts.source ?? 'user',
      opts.sourceKey ?? ''
    )
  },

  /**
   * 授予这条会话与另一条会话交互（询问卡片上的「允许并记住」）：read = 查看，write = 对话。已有一行就合并访问
   * 方式（查看 + 对话 = 对话）。返回那一行；两条会话有一条不在、或是同一条 → null
   */
  grantSession(sessionId: string, targetId: string, access: SessionAccess): AclEntry | null {
    if (targetId === sessionId || !exists(targetId)) return null
    const store = sync(sessionId)
    if (!store) return null
    return grant(store, sessionId, 'session', targetId, access, 'user', '')
  },

  /** 改一行的访问方式（只有授予的行与工作目录那一行能改）。返回是否改了 */
  setAccess(sessionId: string, id: string, access: PathAccess): boolean {
    const store = sync(sessionId)
    if (!store) return false
    const row = store.list(sessionId).find((e) => e.id === id)
    if (!row || !canChangeAclAccess(row) || row.access === access) return false
    const changed = store.updateAccess(sessionId, id, access, Date.now())
    if (changed) {
      log.info(`set access session=${sessionId} ${row.source} → ${access}`)
      broadcastSessionConfigChanged(sessionId)
    }
    return changed
  },

  /** 删一行（只有授予的行能删 —— 派生的随设置走）。返回是否删了 */
  remove(sessionId: string, id: string): boolean {
    const store = sync(sessionId)
    if (!store) return false
    const row = store.list(sessionId).find((e) => e.id === id)
    if (!row || !canRemoveAclEntry(row)) return false
    const removed = store.delete(sessionId, id)
    if (removed) {
      log.info(`revoke session=${sessionId} ${row.source}`)
      broadcastSessionConfigChanged(sessionId)
    }
    return removed
  },

  /**
   * 新建会话时生成它的表（派生行）；有 `inheritFrom` 时先复制那条会话的授予行（子会话：父会话；
   * fork：源会话 —— fork 还带上工作目录那一行的访问方式，两条会话用的是同一个工作目录）。
   * 复制的是此刻的快照，之后两张表各管各的。
   */
  initialize(sessionId: string, inheritFrom?: { sessionId: string; fork: boolean }): void {
    if (!exists(sessionId)) return
    if (inheritFrom && exists(inheritFrom.sessionId)) {
      const from = sync(inheritFrom.sessionId)!.list(inheritFrom.sessionId)
      const store = aclStoreFor(sessionId)
      const now = Date.now()
      store.transaction(() => {
        for (const row of from) {
          const copy =
            !isDerivedAclSource(row.source) || (inheritFrom.fork && row.source === 'workdir')
          if (!copy) continue
          store.insert({ ...row, id: uuidv7(), sessionId, createdAt: now, updatedAt: now })
        }
      })
    }
    sync(sessionId)
  },

  /**
   * 删会话时调：整张表（两边存储）与对账记忆都清掉，别的会话里授权与它交互的行也一并删掉
   */
  deleteSession(sessionId: string): void {
    reconciled.delete(sessionId)
    deleteAclEverywhere(sessionId)
    try {
      // 那些会话的权限表界面（开着的会话设置）跟着重拉
      for (const affected of deleteTargetEverywhere('session', sessionId)) {
        if (affected !== sessionId) broadcastSessionConfigChanged(affected)
      }
    } catch (err) {
      // 删不掉的行只是指向一条不存在的会话：授权的目标已经没了，不会放出任何权限
      log.warn(`acl forget target failed session=${sessionId}: ${(err as Error).message}`)
    }
  },

  /** 忘掉对账记忆（单测；或确知派生输入变了想立即对一次时） */
  forgetReconciled(sessionId?: string): void {
    if (sessionId === undefined) reconciled.clear()
    else reconciled.delete(sessionId)
  }
}
