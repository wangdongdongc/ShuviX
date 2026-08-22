/**
 * 结构化条件字段 —— 规则级字段与策略级 scope 共用的一套语义：
 * 列表内 OR、字段之间 AND、`'*'` = 任意（等价省略）、空交集 = 死代码（由调用方判非法/丢弃）。
 * 键即 CEL 路径，读法必须与 match 里的同名表达式一致（`object.type: [path]` ≡
 * `object.type == 'path'`），否则字段写法与 match 写法会悄悄分叉。
 */
import { describe, it, expect } from 'vitest'
import {
  CONDITION_ANY,
  CONDITION_KEYS,
  compileConditions,
  intersectCondition,
  mergeConditions
} from '../conditions'
import type { MatchContext, PolicyConditions } from '../types'

/** 五个条件键各取一个可区分的值 —— 读法串键时立刻能看出来 */
function makeCtx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    subject: { kind: 'agent', agentKind: 'root', profile: 'default', sessionId: 's1', depth: 0 },
    action: 'read',
    tool: { name: 'read', operation: '' },
    object: { type: 'path', path: '/ws/a.txt' },
    env: { host: 'desktop', platform: 'darwin' },
    vars: {},
    ...overrides
  }
}

/** compileConditions 的便捷调用（无条件时 undefined —— 由调用方处置） */
const hits = (conditions: PolicyConditions, ctx: MatchContext): boolean | undefined =>
  compileConditions(conditions)?.(ctx)

describe('结构化条件 — 键集与编译', () => {
  it('CD-1 CONDITION_KEYS 恰为五个身份标签键（键即 CEL 路径）；通配值为 *', () => {
    expect([...CONDITION_KEYS]).toEqual([
      'subject.kind',
      'action',
      'object.type',
      'env.host',
      'tool.name'
    ])
    expect(CONDITION_ANY).toBe('*')
    // 资源自身的属性不得成为字段（path/command/sql… 一律留在 match）
    for (const attr of ['object.path', 'object.command', 'object.sql', 'subject.profile']) {
      expect(CONDITION_KEYS).not.toContain(attr)
    }
  })

  it('CD-2 单键：列表内 OR（任一值命中即命中）', () => {
    const conditions: PolicyConditions = { action: ['read', 'write'] }
    expect(hits(conditions, makeCtx({ action: 'read' }))).toBe(true)
    expect(hits(conditions, makeCtx({ action: 'write' }))).toBe(true)
    expect(hits(conditions, makeCtx({ action: 'execute' }))).toBe(false)
  })

  it('CD-3 多键：字段之间 AND（任一键不满足即不命中）', () => {
    const conditions: PolicyConditions = {
      'subject.kind': ['agent'],
      action: ['write'],
      'object.type': ['path'],
      'env.host': ['desktop'],
      'tool.name': ['write', 'edit']
    }
    const ok = makeCtx({ action: 'write', tool: { name: 'edit', operation: '' } })
    expect(hits(conditions, ok)).toBe(true)

    // 逐键破坏 —— 每一维都真的参与了 AND
    expect(
      hits(
        conditions,
        makeCtx({
          ...ok,
          subject: { ...ok.subject, kind: 'user' }
        })
      )
    ).toBe(false)
    expect(hits(conditions, makeCtx({ ...ok, action: 'read' }))).toBe(false)
    expect(hits(conditions, makeCtx({ ...ok, object: { type: 'command', command: 'ls' } }))).toBe(
      false
    )
    expect(hits(conditions, makeCtx({ ...ok, env: { host: 'extension', platform: '' } }))).toBe(
      false
    )
    expect(hits(conditions, makeCtx({ ...ok, tool: { name: 'bash', operation: '' } }))).toBe(false)
  })

  it("CD-4 `'*'` = 任意（与省略该键等价；与具体值同列时亦全命中）", () => {
    const anySubject: PolicyConditions = { 'subject.kind': ['*'], action: ['read'] }
    expect(hits(anySubject, makeCtx())).toBe(true)
    expect(
      hits(
        anySubject,
        makeCtx({
          subject: { kind: 'user', agentKind: '', profile: '', sessionId: 's1', depth: 0 }
        })
      )
    ).toBe(true)
    // 省略该键的等价形态
    expect(hits({ action: ['read'] }, makeCtx())).toBe(true)

    // '*' 与具体值同列：仍是全集
    const mixed: PolicyConditions = { 'object.type': ['*', 'path'] }
    expect(hits(mixed, makeCtx({ object: { type: 'database', sql: 'select 1' } }))).toBe(true)
  })

  it('CD-5 一个条件都没有 → compileConditions 返回 undefined（恒命中，由调用方处置）', () => {
    expect(compileConditions({})).toBeUndefined()
  })

  it('CD-6 五个键的读法与 match 里的同名表达式一致；object.type 缺失读作空串而非报错', () => {
    const ctx = makeCtx({
      subject: { kind: 'user', agentKind: 'spawned', profile: 'widget', sessionId: 's9', depth: 1 },
      action: 'execute',
      object: { type: 'command', command: 'ls' },
      env: { host: 'extension', platform: 'linux' },
      tool: { name: 'bash', operation: 'exec' }
    })
    expect(hits({ 'subject.kind': ['user'] }, ctx)).toBe(true)
    expect(hits({ action: ['execute'] }, ctx)).toBe(true)
    expect(hits({ 'object.type': ['command'] }, ctx)).toBe(true)
    expect(hits({ 'env.host': ['extension'] }, ctx)).toBe(true)
    expect(hits({ 'tool.name': ['bash'] }, ctx)).toBe(true)
    // 邻键不串（subject.kind 读的不是 profile / agentKind，tool.name 读的不是 operation）
    expect(hits({ 'subject.kind': ['widget'] }, ctx)).toBe(false)
    expect(hits({ 'subject.kind': ['spawned'] }, ctx)).toBe(false)
    expect(hits({ 'tool.name': ['exec'] }, ctx)).toBe(false)

    // 无 type 的客体（不该发生，但条件求值不得炸）：读作空串 → 具体值不命中、'*' 命中
    const typeless = makeCtx({ object: {} })
    expect(() => hits({ 'object.type': ['path'] }, typeless)).not.toThrow()
    expect(hits({ 'object.type': ['path'] }, typeless)).toBe(false)
    expect(hits({ 'object.type': ['*'] }, typeless)).toBe(true)
  })

  it('CD-10 条件值是精确整串匹配：区分大小写、无前缀/子串/通配符语义', () => {
    expect(hits({ action: ['Read'] }, makeCtx({ action: 'read' }))).toBe(false)
    expect(hits({ 'object.type': ['pat'] }, makeCtx())).toBe(false)
    expect(hits({ 'object.type': ['path*'] }, makeCtx())).toBe(false)
    expect(hits({ 'tool.name': [''] }, makeCtx({ tool: { name: '', operation: '' } }))).toBe(true)
  })
})

describe('intersectCondition', () => {
  it("CD-7 `'*'` 视为全集；普通交集取公共项；空交集返回 null", () => {
    // '*' 侧被另一侧完全决定（含 '*' 与具体值混写）
    expect(intersectCondition(['*'], ['y'])).toEqual(['y'])
    expect(intersectCondition(['x'], ['*'])).toEqual(['x'])
    expect(intersectCondition(['*', 'x'], ['y'])).toEqual(['y'])
    expect(intersectCondition(['*'], ['*'])).toEqual(['*'])

    // 普通交集：保留 a 侧顺序
    expect(intersectCondition(['read', 'write', 'execute'], ['write', 'read'])).toEqual([
      'read',
      'write'
    ])
    expect(intersectCondition(['read'], ['read'])).toEqual(['read'])

    // 空交集 = 该规则永远不可能命中（死代码）
    expect(intersectCondition(['read'], ['write'])).toBeNull()
    expect(intersectCondition(['path'], ['command', 'database'])).toBeNull()
  })
})

describe('mergeConditions', () => {
  it('CD-8 scope ⊕ 规则字段：同键取交、异键取并、缺省透传、矛盾 null；恒返回新对象与新列表', () => {
    // 缺省组合
    expect(mergeConditions(undefined, undefined)).toEqual({})
    expect(mergeConditions(undefined, { action: ['read'] })).toEqual({ action: ['read'] })
    expect(mergeConditions({ 'subject.kind': ['agent'] }, undefined)).toEqual({
      'subject.kind': ['agent']
    })

    // 异键取并（scope 的身份标签 + 规则的动作维度）
    expect(
      mergeConditions(
        { 'subject.kind': ['agent'], 'object.type': ['path'] },
        { action: ['write'], 'tool.name': ['write', 'edit'] }
      )
    ).toEqual({
      'subject.kind': ['agent'],
      'object.type': ['path'],
      action: ['write'],
      'tool.name': ['write', 'edit']
    })

    // 同键取交（含 '*' 全集侧）
    expect(mergeConditions({ action: ['read', 'write'] }, { action: ['write'] })).toEqual({
      action: ['write']
    })
    expect(mergeConditions({ 'subject.kind': ['*'] }, { 'subject.kind': ['agent'] })).toEqual({
      'subject.kind': ['agent']
    })

    // 矛盾（空交集）→ null，调用方判非法/丢弃
    expect(mergeConditions({ action: ['read'] }, { action: ['write'] })).toBeNull()
    expect(mergeConditions({ 'object.type': ['path'] }, { 'object.type': ['command'] })).toBeNull()

    // 别名隔离：入参可能是内置策略的模块级缓存产物，产物会流向 IPC/UI —— 共享引用会跨会话污染
    const scope: PolicyConditions = { 'subject.kind': ['agent'], 'object.type': ['path'] }
    const rule: PolicyConditions = { action: ['read', 'write'] }
    for (const merged of [
      mergeConditions(scope, rule)!,
      mergeConditions(scope, undefined)!,
      mergeConditions(undefined, rule)!,
      mergeConditions({ action: ['read', 'write'] }, { action: ['read'] })!
    ]) {
      expect(merged).not.toBe(scope)
      expect(merged).not.toBe(rule)
      for (const key of CONDITION_KEYS) {
        const list = merged[key]
        if (!list) continue
        expect(list).not.toBe(scope[key])
        expect(list).not.toBe(rule[key])
      }
    }

    // 就地改动产物不回写入参
    const merged = mergeConditions(scope, rule)!
    merged['subject.kind']!.push('user')
    merged.action!.pop()
    expect(scope['subject.kind']).toEqual(['agent'])
    expect(rule.action).toEqual(['read', 'write'])
  })
})
