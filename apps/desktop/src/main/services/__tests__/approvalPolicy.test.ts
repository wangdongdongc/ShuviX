/**
 * 桌面 ApprovalPolicy 单测 —— makeDesktopApprovalPolicy 的放行范围与 allowList 语义。
 *
 * 核心收紧点：工作目录只对 read 放行，write 一律落到审批链（免审批 / allowList / 弹窗）。
 * dao / sessionService / paths / skillService 全部 mock（照 sessionStorage.test.ts 的惯例），
 * allowList 工具保持真实 —— Read 条目不得隐含写权限这条语义要真的被验证。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const WORKSPACE = join(tmpdir(), 'shuvix-policy-ws')
const TOOL_RESULTS = join(tmpdir(), 'shuvix-policy-tool-results')
const DEFAULT_SKILLS = join(tmpdir(), 'shuvix-policy-skills')
const BUILTIN_SKILLS = join(tmpdir(), 'shuvix-policy-builtin-skills')
const EXTERNAL_SKILLS = join(tmpdir(), 'shuvix-policy-external-skills')
const OUTSIDE = join(tmpdir(), 'shuvix-policy-elsewhere')

const state = vi.hoisted(() => ({
  settings: undefined as { autoApprove?: boolean; allowList?: string[] } | undefined,
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
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: () => WORKSPACE,
  getToolResultsBase: () => TOOL_RESULTS,
  getDefaultSkillsDir: () => DEFAULT_SKILLS,
  getBuiltinSkillsDir: () => BUILTIN_SKILLS
}))

import { makeDesktopApprovalPolicy, type ProjectConfig } from '../toolContext'

const config: ProjectConfig = { workingDirectory: WORKSPACE }
const policy = (): ReturnType<typeof makeDesktopApprovalPolicy> =>
  makeDesktopApprovalPolicy({ sessionId: 's1' }, () => config)

beforeEach(() => {
  state.settings = undefined
  state.externalDirs = []
})

describe('makeDesktopApprovalPolicy — isAllowedWithoutPrompt', () => {
  it('PERM-1: 工作目录内 read 免审批，write 不免审批', () => {
    const p = join(WORKSPACE, 'src', 'a.ts')
    expect(policy().isAllowedWithoutPrompt('read', p)).toBe(true)
    expect(policy().isAllowedWithoutPrompt('write', p)).toBe(false)
  })

  it('PERM-1: 工作目录本身同样是 read 放行 / write 需审批', () => {
    expect(policy().isAllowedWithoutPrompt('read', WORKSPACE)).toBe(true)
    expect(policy().isAllowedWithoutPrompt('write', WORKSPACE)).toBe(false)
  })

  it('PERM-8: tool_results / 默认 skills / 内置 skills / 外接 skills → read 免审批、write 不免', () => {
    state.externalDirs = [{ path: EXTERNAL_SKILLS }]
    const readOnlyPlaces = [
      join(TOOL_RESULTS, 's1', 'out.txt'),
      join(DEFAULT_SKILLS, 'demo', 'SKILL.md'),
      join(BUILTIN_SKILLS, 'demo', 'SKILL.md'),
      join(EXTERNAL_SKILLS, 'demo', 'SKILL.md')
    ]
    for (const p of readOnlyPlaces) {
      expect({ p, read: policy().isAllowedWithoutPrompt('read', p) }).toEqual({ p, read: true })
      expect({ p, write: policy().isAllowedWithoutPrompt('write', p) }).toEqual({ p, write: false })
    }
  })

  it('PERM-8: 未登记的外部路径 read/write 都不免审批', () => {
    const p = join(OUTSIDE, 'a.txt')
    expect(policy().isAllowedWithoutPrompt('read', p)).toBe(false)
    expect(policy().isAllowedWithoutPrompt('write', p)).toBe(false)
  })
})

describe('makeDesktopApprovalPolicy — allowList 语义', () => {
  const target = join(WORKSPACE, 'a.txt')

  it('PERM-4: Write(abs) 条目同时满足 write 与 read', () => {
    state.settings = { allowList: [`Write(${target})`] }
    expect(policy().isInAllowList('write', target)).toBe(true)
    expect(policy().isInAllowList('read', target)).toBe(true)
  })

  it('PERM-4: 只有 Read(abs) 条目时 write 不命中（读权限不隐含写权限）', () => {
    state.settings = { allowList: [`Read(${target})`] }
    expect(policy().isInAllowList('read', target)).toBe(true)
    expect(policy().isInAllowList('write', target)).toBe(false)
  })

  it('PERM-4: 目录条目按前缀命中，无 allowList 时恒不命中', () => {
    state.settings = { allowList: [`Write(${join(WORKSPACE, 'sub')})`] }
    expect(policy().isInAllowList('write', join(WORKSPACE, 'sub', 'deep', 'b.txt'))).toBe(true)
    expect(policy().isInAllowList('write', join(WORKSPACE, 'subsidiary.txt'))).toBe(false)

    state.settings = undefined
    expect(policy().isInAllowList('write', target)).toBe(false)
  })

  it('PERM-4: buildApprovalCommand 产出的字面值就是 allowList 条目形态', () => {
    expect(policy().buildApprovalCommand('write', target)).toBe(`Write(${target})`)
    expect(policy().buildApprovalCommand('read', target)).toBe(`Read(${target})`)
  })
})

describe('makeDesktopApprovalPolicy — 不缓存 settings 快照', () => {
  const target = join(WORKSPACE, 'a.txt')

  it('同一个 policy 实例在 settings 变化后立即反映新值（会话中途开免审批不该还弹旧快照）', () => {
    // policy 在建会话时创建一次、整会话复用；每次判定都必须现读 SQLite
    const p = policy()

    expect(p.isAutoApprove()).toBe(false)
    expect(p.isInAllowList('write', target)).toBe(false)

    // 会话中途打开「免审批」
    state.settings = { autoApprove: true }
    expect(p.isAutoApprove()).toBe(true)

    // 再关掉，改为对具体路径「允许并记住」
    state.settings = { allowList: [`Write(${target})`] }
    expect(p.isAutoApprove()).toBe(false)
    expect(p.isInAllowList('write', target)).toBe(true)

    // 条目被撤掉后同样立刻失效
    state.settings = { allowList: [] }
    expect(p.isInAllowList('write', target)).toBe(false)
  })
})
