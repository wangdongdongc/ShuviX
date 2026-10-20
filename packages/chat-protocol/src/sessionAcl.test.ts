/**
 * 会话权限表的共享判定（sessionAcl.ts）—— 主进程、设置界面与网络客户端共用。
 *
 *   SA-1  类型守卫：kind / source / access 只认词表里的值
 *   SA-2  谁能删、谁能改访问方式、交给沙箱时要不要过可写根检查：授予的能删能改、要过；工作目录能改不能删、
 *         不过；笔记本文档能改不能删、要过；其余派生的都不能、不过
 *   SA-3  widerPathAccess：读 + 写 = 写，顺序无关
 *   SA-4  pathAclView：写隐含读、去重、保持首次出现的顺序；空目标与别的种类跳过
 */
import { describe, expect, it } from 'vitest'
import {
  canChangeAclAccess,
  canRemoveAclEntry,
  isAclKind,
  isAclSource,
  isDerivedAclSource,
  isPathAccess,
  needsSandboxRootCheck,
  pathAclView,
  widerPathAccess,
  type AclEntry
} from './sessionAcl'

describe('sessionAcl', () => {
  it('SA-1 类型守卫只认词表里的值', () => {
    expect(isAclKind('path')).toBe(true)
    expect(isAclKind('network')).toBe(false)
    for (const s of ['workdir', 'document', 'system', 'knowledge', 'skill', 'user', 'widget']) {
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
      ['skill', false, false, false]
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
