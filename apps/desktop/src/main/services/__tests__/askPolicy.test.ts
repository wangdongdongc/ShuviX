/**
 * 桌面安全 provider 单测 —— makeDesktopSecurityProvider / getDesktopSecurityContext 的
 * 放行范围与 allowList 语义（经真实 createSecurityContext + 内置策略评估链）。
 *
 * 核心收紧点：工作目录只对 read 放行，write 一律落到询问链（免询问 / allowList / 弹窗）。
 * dao / sessionService / paths / skillService / policyService 全部 mock
 * （照 sessionStorage.test.ts 的惯例），allowList 条目语义保持真实 ——
 * Read 条目不得隐含写权限这条语义要真的被验证。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

const WORKSPACE = join(tmpdir(), 'shuvix-policy-ws')
const TOOL_RESULTS = join(tmpdir(), 'shuvix-policy-tool-results')
const DEFAULT_SKILLS = join(tmpdir(), 'shuvix-policy-skills')
const BUILTIN_SKILLS = join(tmpdir(), 'shuvix-policy-builtin-skills')
const EXTERNAL_SKILLS = join(tmpdir(), 'shuvix-policy-external-skills')
const OUTSIDE = join(tmpdir(), 'shuvix-policy-elsewhere')

const state = vi.hoisted(() => ({
  settings: undefined as { autoAllow?: boolean; allowList?: string[] } | undefined,
  externalDirs: [] as { path: string }[]
}))

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: () => state.settings }
}))
vi.mock('../sessionService', () => ({
  sessionService: { getById: () => undefined, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({
  skillService: { listExternalDirs: () => state.externalDirs }
}))
vi.mock('../policyService', () => ({
  policyService: { getUserPolicies: () => [] }
}))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: () => WORKSPACE,
  getToolResultsBase: () => TOOL_RESULTS,
  getDefaultSkillsDir: () => DEFAULT_SKILLS,
  getBuiltinSkillsDir: () => BUILTIN_SKILLS
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { getDesktopSecurityContext, type ProjectConfig } from '../toolContext'
import type { SecurityContext, SecurityEffect } from '@shuvix/agent-runtime'

const config: ProjectConfig = { workingDirectory: WORKSPACE }
const context = (): SecurityContext => getDesktopSecurityContext({ sessionId: 's1' }, () => config)

/** 完整评估链（含 consent 层）的 effect */
const effectOf = (ctx: SecurityContext, mode: 'read' | 'write', p: string): SecurityEffect =>
  ctx.evaluate(mode, { type: 'path', path: p }).effect

beforeEach(() => {
  state.settings = undefined
  state.externalDirs = []
})

describe('桌面安全 provider — 默认放行 + 内置写入门（ask-on-write）', () => {
  it('PERM-1: 读取默认放行（无策略即自由），write 落询问链（ask）', () => {
    const p = join(WORKSPACE, 'src', 'a.ts')
    expect(effectOf(context(), 'read', p)).toBe('allow')
    expect(effectOf(context(), 'write', p)).toBe('ask')
  })

  it('PERM-1: 工作目录本身同样是 read 放行 / write 需询问', () => {
    expect(effectOf(context(), 'read', WORKSPACE)).toBe('allow')
    expect(effectOf(context(), 'write', WORKSPACE)).toBe('ask')
  })

  it('PERM-8: tool_results / skills 目录 read 放行（ask-on-read 的 when 放过）、write 一律 ask', () => {
    state.externalDirs = [{ path: EXTERNAL_SKILLS }]
    const readFreePlaces = [
      join(TOOL_RESULTS, 's1', 'out.txt'),
      join(DEFAULT_SKILLS, 'demo', 'SKILL.md'),
      join(BUILTIN_SKILLS, 'demo', 'SKILL.md'),
      join(EXTERNAL_SKILLS, 'demo', 'SKILL.md')
    ]
    for (const p of readFreePlaces) {
      expect({ p, read: effectOf(context(), 'read', p) }).toEqual({ p, read: 'allow' })
      expect({ p, write: effectOf(context(), 'write', p) }).toEqual({ p, write: 'ask' })
    }
  })

  it('PERM-8b: 未登记外部路径 read 经内置 ask-on-read 门 ask（迁移前读取围栏恢复）', () => {
    const p = join(OUTSIDE, 'a.txt')
    const decision = context().evaluate('read', { type: 'path', path: p })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toBe('ask-on-read#0')
    expect(effectOf(context(), 'write', p)).toBe('ask')
  })

  it('PERM-8c: 凭据目录读取 ask 且归因到 protect-credentials（装配序在 ask-on-read 之前）', () => {
    const key = join(homedir(), '.ssh', 'id_rsa')
    const decision = context().evaluate('read', { type: 'path', path: key })
    expect(decision.effect).toBe('ask')
    expect(decision.winning).toContain('protect-credentials')
  })
})

describe('桌面安全 provider — allowList 语义（consent 层）', () => {
  const target = join(WORKSPACE, 'a.txt')

  it('PERM-4: Write(abs) 条目同时满足 write 与 read', () => {
    state.settings = { allowList: [`Write(${OUTSIDE}/x.txt)`] }
    expect(effectOf(context(), 'write', `${OUTSIDE}/x.txt`)).toBe('allow')
    expect(effectOf(context(), 'read', `${OUTSIDE}/x.txt`)).toBe('allow')
  })

  it('PERM-4: 只有 Read(abs) 条目时 write 不命中（读权限不隐含写权限）', () => {
    state.settings = { allowList: [`Read(${target})`] }
    expect(effectOf(context(), 'read', target)).toBe('allow')
    expect(effectOf(context(), 'write', target)).toBe('ask')
  })

  it('PERM-4: 目录条目按前缀命中，无 allowList 时恒不命中', () => {
    state.settings = { allowList: [`Write(${join(WORKSPACE, 'sub')})`] }
    expect(effectOf(context(), 'write', join(WORKSPACE, 'sub', 'deep', 'b.txt'))).toBe('allow')
    expect(effectOf(context(), 'write', join(WORKSPACE, 'subsidiary.txt'))).toBe('ask')

    state.settings = undefined
    expect(effectOf(context(), 'write', target)).toBe('ask')
  })

  it('PERM-4: 询问材料的字面值就是 allowList 条目形态', () => {
    const decision = context().evaluate('write', { type: 'path', path: target })
    expect(decision.effect).toBe('ask')
    expect(decision.ask?.command).toBe(`Write(${target})`)
    expect(decision.ask?.rememberEntry).toBe(`Write(${target})`)

    // read 的 ask 只剩凭据目录（其余默认放行无询问材料）
    const credential = join(homedir(), '.ssh', 'config')
    const readDecision = context().evaluate('read', { type: 'path', path: credential })
    expect(readDecision.ask?.command).toBe(`Read(${credential})`)
  })
})

describe('桌面安全 provider — evaluateReadOnly（被动 UI 判定）', () => {
  it('缺省不含 consent 层：allowList/autoAllow 不放宽 UI 范围（凭据目录 ask 门仍生效）', () => {
    const credential = join(homedir(), '.ssh', 'known_hosts')
    state.settings = { autoAllow: true, allowList: [`Read(${credential})`] }
    expect(context().evaluateReadOnly('read', { type: 'path', path: credential })).toBe(false)
    // 工作区内自由；工作区外被内置 ask-on-read 门拦下（被动 UI 面随之收窄）
    expect(context().evaluateReadOnly('read', { type: 'path', path: join(WORKSPACE, 'b') })).toBe(
      true
    )
    expect(context().evaluateReadOnly('read', { type: 'path', path: join(OUTSIDE, 'c') })).toBe(
      false
    )
  })
})

describe('桌面安全 provider — 不缓存 settings 快照', () => {
  const target = join(WORKSPACE, 'a.txt')

  it('同一个 context 实例在 settings 变化后立即反映新值（会话中途开免询问不该还弹旧快照）', () => {
    // context 在建会话时创建一次、整会话复用；每次判定都必须现读 SQLite
    const ctx = context()

    expect(effectOf(ctx, 'write', target)).toBe('ask')

    // 会话中途打开「免询问」
    state.settings = { autoAllow: true }
    expect(effectOf(ctx, 'write', target)).toBe('allow')
    expect(ctx.evaluate('write', { type: 'path', path: target }).winning).toBe(
      'session-auto-allow#0'
    )

    // 再关掉，改为对具体路径「允许并记住」
    state.settings = { allowList: [`Write(${target})`] }
    expect(effectOf(ctx, 'write', target)).toBe('allow')

    // 条目被撤掉后同样立刻失效
    state.settings = { allowList: [] }
    expect(effectOf(ctx, 'write', target)).toBe('ask')
  })
})

describe('桌面安全 provider — deny 层压制 consent（protect-credentials 策略）', () => {
  it('凭据目录写入即使开了免询问也 deny', () => {
    state.settings = { autoAllow: true }
    const sshKey = join(homedir(), '.ssh', 'id_rsa')
    const decision = context().evaluate('write', { type: 'path', path: sshKey })
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toContain('protect-credentials')
  })
})
