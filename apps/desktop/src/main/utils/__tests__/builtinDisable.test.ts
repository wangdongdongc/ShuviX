/**
 * BD —— `isKnownDisableableBuiltin(objectId, kind?)`：哪个对象 id 有停用开关（md 扩展元数据，
 * chat-protocol MD_DISABLEABLE_KINDS）。宿主侧比契约层多核对两件事：名字真在随包的 spec 里
 * （BUILTIN_HOOK_SPECS / BUILTIN_POLICY_SPECS），以及给了 `kind` 时 id 的类型段与之一致 ——
 * 写入口、列表与笔记视图共用这一个判定。
 */
import { describe, it, expect } from 'vitest'
import { isKnownDisableableBuiltin } from '../builtinDisable'

const UUID = '0199d3a2-7b3e-7c4d-9a1f-2e5b8c7d6f10'

describe('BD isKnownDisableableBuiltin', () => {
  it.each([
    'hook:builtin:auto-title',
    'hook:builtin:auto-review',
    'policy:builtin:ask-on-command',
    'policy:builtin:ask-on-external-path'
  ])('BD-1 随包发布的内置 hook / 安全策略 → true：%s', (id) => {
    expect(isKnownDisableableBuiltin(id)).toBe(true)
  })

  it.each([
    'hook:builtin:nonexistent',
    // 2026-10-01 下线的内置策略：名字不在 spec 里了
    'policy:builtin:ask-on-write',
    'agent:builtin:explore',
    'bot:builtin:x',
    UUID,
    ''
  ])('BD-2 名字不在 spec 里 / 别的类型 / UUID → false：%j', (id) => {
    expect(isKnownDisableableBuiltin(id)).toBe(false)
  })

  it('BD-3 给了 kind：类型段必须与之一致', () => {
    expect(isKnownDisableableBuiltin('hook:builtin:auto-title', 'policy')).toBe(false)
    expect(isKnownDisableableBuiltin('policy:builtin:ask-on-command', 'policy')).toBe(true)
    expect(isKnownDisableableBuiltin('hook:builtin:auto-title', 'hook')).toBe(true)
    expect(isKnownDisableableBuiltin('policy:builtin:ask-on-command', 'hook')).toBe(false)
    expect(isKnownDisableableBuiltin('agent:builtin:explore', 'agent')).toBe(false)
  })
})
