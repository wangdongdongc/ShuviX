/**
 * 会话权限表的共享判定（sessionAcl.ts）—— 主进程、设置界面与网络客户端共用。
 *
 *   SA-1  类型守卫：kind / source / access 只认词表里的值
 *   SA-2  谁能删、谁能改访问方式、交给沙箱时要不要过可写根检查：授予的能删能改、要过；工作目录能改不能删、
 *         不过；笔记本文档能改不能删、要过；其余派生的都不能、不过
 *   SA-3  widerPathAccess：读 + 写 = 写，顺序无关
 *   SA-4  pathAclView：写隐含读、去重、保持首次出现的顺序；空目标与别的种类跳过
 *   XS-01 / 02  会话种类（2026-10-20）：词表恰是 path / session；sessionAclView 与 pathAclView 各取各的种类，
 *         互不串（策略的 `vars.aclSessionRead` / `vars.aclSessionWrite` 与 `vars.aclRead` / `vars.aclWrite`）
 *   WT4-AC-01 / 02  组件种类：widget 种类与 widgetDir 来源进词表；widgetDir 是派生行（不能删、不能改、不过可写根
 *         检查）；widgetAclView 只取组件行（策略的 `vars.aclWidgetRead` / `vars.aclWidgetWrite`），与路径 / 会话互不串
 */
import { describe, expect, it } from 'vitest'
import {
  ACL_KINDS,
  canChangeAclAccess,
  canRemoveAclEntry,
  isAclKind,
  isAclSource,
  isDerivedAclSource,
  isPathAccess,
  needsSandboxRootCheck,
  pathAclView,
  sessionAclView,
  widerPathAccess,
  widgetAclView,
  type AclEntry
} from './sessionAcl'

describe('sessionAcl', () => {
  it('SA-1 类型守卫只认词表里的值', () => {
    expect(isAclKind('path')).toBe(true)
    expect(isAclKind('network')).toBe(false)
    for (const s of [
      'workdir',
      'document',
      'system',
      'knowledge',
      'skill',
      'widgetDir',
      'user',
      'widget'
    ]) {
      expect(isAclSource(s), s).toBe(true)
    }
    expect(isAclSource('admin')).toBe(false)
    expect(isPathAccess('read')).toBe(true)
    expect(isPathAccess('write')).toBe(true)
    expect(isPathAccess('execute')).toBe(false)
    expect(isPathAccess(undefined)).toBe(false)
  })

  it('SA-2 谁能删、谁能改', () => {
    const table: Array<[AclEntry['source'], boolean, boolean, boolean]> = [
      ['user', true, true, true],
      ['widget', true, true, true],
      ['workdir', false, true, false],
      ['document', false, true, true],
      ['system', false, false, false],
      ['knowledge', false, false, false],
      ['skill', false, false, false],
      ['widgetDir', false, false, false]
    ]
    for (const [source, remove, change, rootCheck] of table) {
      expect(canRemoveAclEntry({ source }), source).toBe(remove)
      expect(canChangeAclAccess({ source }), source).toBe(change)
      expect(needsSandboxRootCheck({ source }), source).toBe(rootCheck)
      expect(isDerivedAclSource(source), source).toBe(!remove)
    }
  })

  it('SA-3 widerPathAccess', () => {
    expect(widerPathAccess('read', 'read')).toBe('read')
    expect(widerPathAccess('read', 'write')).toBe('write')
    expect(widerPathAccess('write', 'read')).toBe('write')
  })

  it('SA-4 pathAclView：写隐含读、去重、保序，跳过空目标与别的种类', () => {
    const view = pathAclView([
      { kind: 'path', target: '/ws', access: 'write' },
      { kind: 'path', target: '/skills', access: 'read' },
      { kind: 'path', target: '/ws', access: 'read' },
      { kind: 'path', target: '', access: 'write' },
      { kind: 'network' as AclEntry['kind'], target: 'example.com', access: 'write' },
      { kind: 'path', target: '/g', access: 'write' }
    ])
    expect(view).toEqual({ read: ['/ws', '/skills', '/g'], write: ['/ws', '/g'] })
  })
})

/**
 * 会话种类的行（`kind: 'session'`，target = 另一条会话的 id）。
 *   XS-01 词表恰是 ['path', 'session']；isAclKind 认 session、不认别的
 *   XS-02 同一张混着两种客体的表：sessionAclView 只取会话行、pathAclView 只取路径行 —— 同名的 target 也不串
 */
describe('sessionAcl —— 会话种类', () => {
  it('XS-01 ACL_KINDS 恰是 path / session / widget；isAclKind 认 session，不认 network', () => {
    expect(ACL_KINDS).toEqual(['path', 'session', 'widget'])
    expect(isAclKind('session')).toBe(true)
    expect(isAclKind('path')).toBe(true)
    expect(isAclKind('network')).toBe(false)
    expect(isAclKind('Session')).toBe(false)
    expect(isAclKind(undefined)).toBe(false)
  })

  it('XS-02 混合表：sessionAclView 写隐含读、去重保序、跳过空目标；pathAclView 只看路径行 —— 两种客体互不串', () => {
    const rows: Array<Pick<AclEntry, 'kind' | 'target' | 'access'>> = [
      { kind: 'session', target: 'X', access: 'read' },
      { kind: 'path', target: '/ws', access: 'write' },
      { kind: 'session', target: 'Y', access: 'write' },
      { kind: 'session', target: 'X', access: 'write' },
      { kind: 'session', target: '', access: 'write' },
      // 路径行的 target 恰好与会话 id 同名：也只进路径的视图
      { kind: 'path', target: 'X', access: 'read' }
    ]
    expect(sessionAclView(rows)).toEqual({ read: ['X', 'Y'], write: ['Y', 'X'] })
    expect(pathAclView(rows)).toEqual({ read: ['/ws', 'X'], write: ['/ws'] })
    // 只有会话行 / 只有路径行：另一侧的视图是空表
    expect(pathAclView(rows.filter((r) => r.kind === 'session'))).toEqual({ read: [], write: [] })
    expect(sessionAclView(rows.filter((r) => r.kind === 'path'))).toEqual({ read: [], write: [] })
    expect(sessionAclView([])).toEqual({ read: [], write: [] })
  })
})

/**
 * 组件种类的行（`kind: 'widget'`，target = 组件 id）与它派生出的源码目录行（`source: 'widgetDir'`）。
 *   WT4-AC-01 isAclKind 认 widget、isAclSource 认 widgetDir；widgetDir 是派生的：不能删、不能改访问方式、交给沙箱时
 *             不过可写根检查（目录由宿主按授权算出）
 *   WT4-AC-02 混合表：widgetAclView 写隐含读、去重保序、跳过空目标，路径 / 会话行（哪怕目标字面是组件 id）不进；
 *             pathAclView / sessionAclView 也不收组件行
 */
describe('sessionAcl —— 组件种类', () => {
  it('WT4-AC-01 类型守卫认 widget / widgetDir；widgetDir 不能删、不能改、不过可写根检查，是派生来源', () => {
    expect(isAclKind('widget')).toBe(true)
    expect(isAclKind('Widget')).toBe(false)
    expect(isAclSource('widgetDir')).toBe(true)
    expect(isAclSource('widgetdir')).toBe(false)
    expect(canRemoveAclEntry({ source: 'widgetDir' })).toBe(false)
    expect(canChangeAclAccess({ source: 'widgetDir' })).toBe(false)
    expect(needsSandboxRootCheck({ source: 'widgetDir' })).toBe(false)
    expect(isDerivedAclSource('widgetDir')).toBe(true)
  })

  it('WT4-AC-02 混合表：widgetAclView 写隐含读、去重保序、跳过空目标；路径 / 会话行不进，另两张视图也不收组件行', () => {
    const rows: Array<Pick<AclEntry, 'kind' | 'target' | 'access'>> = [
      { kind: 'widget', target: 'X', access: 'read' },
      { kind: 'path', target: '/ws', access: 'write' },
      { kind: 'widget', target: 'Y', access: 'write' },
      { kind: 'widget', target: 'X', access: 'write' },
      { kind: 'widget', target: '', access: 'write' },
      // 路径行、会话行的目标字面恰是组件 id：只进各自的视图
      { kind: 'path', target: 'X', access: 'read' },
      { kind: 'session', target: 'X', access: 'write' }
    ]
    expect(widgetAclView(rows)).toEqual({ read: ['X', 'Y'], write: ['Y', 'X'] })
    expect(pathAclView(rows)).toEqual({ read: ['/ws', 'X'], write: ['/ws'] })
    expect(sessionAclView(rows)).toEqual({ read: ['X'], write: ['X'] })
    // 只有组件行：另两张视图是空表；没有组件行：组件视图是空表
    const widgetsOnly = rows.filter((r) => r.kind === 'widget')
    expect(pathAclView(widgetsOnly)).toEqual({ read: [], write: [] })
    expect(sessionAclView(widgetsOnly)).toEqual({ read: [], write: [] })
    expect(widgetAclView(rows.filter((r) => r.kind !== 'widget'))).toEqual({ read: [], write: [] })
    expect(widgetAclView([])).toEqual({ read: [], write: [] })
  })
})
