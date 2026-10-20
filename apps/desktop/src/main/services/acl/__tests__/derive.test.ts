/**
 * 会话权限表的派生行（acl/derive.ts）—— 按会话此刻的设置算出应有的 workdir / system / knowledge / skill 行。
 * 来源（会话目录、知识库、技能目录）都换成可控的假实现。
 *
 *   DR-1  完整的一份：工作目录（写）、三个会话目录（写）、知识库（写 / 内置库读）、技能目录（读），顺序固定
 *   DR-2  工作目录不适合（sessionOwnDirs 给 workdir null）：没有 workdir 行，其余照常
 *   DR-3  会话目录算不出（坏 id，sessionOwnDirsView 回 null）：一行都不派生
 *   DR-4  知识库 / 技能目录进表前过 settingDirForAcl：被拒的（覆盖家目录之类）不进表；路径取它给的写法
 *   DR-5  知识库扫描或技能配置读失败：那一类少给，其余照常（多问，不放行）
 *   DR-6  同一来源的重复行只留一份（技能目录与内置目录重名之类）
 *   DR-7  笔记本会话：多一行 document（可写，紧跟工作目录），路径按工作目录解析相对的 notebookPath、绝对的原样；
 *         settingDirForAcl 拒了就没有这一行
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  own: null as null | {
    workdir: string | null
    workspaceUnsuitable: string | null
    tmp: string
    artifacts: string
    toolResults: string
  },
  targets: [] as Array<{ name: string; target: { dir: string; readonly?: boolean } }>,
  targetsThrow: false,
  skillRoots: [] as string[],
  skillsThrow: false,
  rejected: new Set<string>(),
  notebookPath: null as string | null
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../../../utils/paths', () => ({ getBuiltinSkillsDir: () => '/app/skills/en' }))
vi.mock('../workdir', () => ({ sessionWorkingDirectory: () => '/Users/u/proj' }))
vi.mock('../../sessionRecords', () => ({
  sessionRecords: { pickSettings: () => ({ notebookPath: state.notebookPath }) }
}))
vi.mock('../../sandbox', () => ({
  sessionOwnDirsView: () => state.own,
  settingDirForAcl: (dir: string) => (state.rejected.has(dir) ? null : `real:${dir}`)
}))
vi.mock('../../knowledge/sessionBundle', () => ({
  enabledTargets: () => {
    if (state.targetsThrow) throw new Error('scan failed')
    return state.targets
  }
}))

import { derivePathEntries, setAclSkillRoots } from '../derive'

// 用户启用的技能目录由主进程注入（acl 不反向依赖 skillService）
setAclSkillRoots(() => {
  if (state.skillsThrow) throw new Error('config unreadable')
  return state.skillRoots
})

const OWN = {
  workdir: '/Users/u/proj',
  workspaceUnsuitable: null,
  tmp: '/private/tmp/shuvix-501/abcd1234',
  artifacts: '/Users/u/.shuvix/artifacts/s1',
  toolResults: '/Users/u/Library/Application Support/ShuviX/tool_results/s1'
}

beforeEach(() => {
  state.own = { ...OWN }
  state.targets = [
    { name: 'project', target: { dir: '/kb/project' } },
    { name: 'notes', target: { dir: '/kb/notes' } },
    { name: 'shuvix', target: { dir: '/app/kb/shuvix', readonly: true } }
  ]
  state.targetsThrow = false
  state.skillRoots = ['/Users/u/.shuvix/skills', '/ext/skills']
  state.skillsThrow = false
  state.rejected = new Set()
  state.notebookPath = null
})

const rows = (): string[] =>
  derivePathEntries('s1').map((e) => `${e.source}:${e.sourceKey}:${e.target}:${e.access}`)

describe('derivePathEntries', () => {
  it('DR-1 完整的一份，顺序固定', () => {
    expect(rows()).toEqual([
      'workdir::/Users/u/proj:write',
      `system:tmp:${OWN.tmp}:write`,
      `system:artifacts:${OWN.artifacts}:write`,
      `system:toolResults:${OWN.toolResults}:write`,
      'knowledge:project:real:/kb/project:write',
      'knowledge:notes:real:/kb/notes:write',
      'knowledge:shuvix:real:/app/kb/shuvix:read',
      'skill:real:/app/skills/en:real:/app/skills/en:read',
      'skill:real:/Users/u/.shuvix/skills:real:/Users/u/.shuvix/skills:read',
      'skill:real:/ext/skills:real:/ext/skills:read'
    ])
  })

  it('DR-2 工作目录不适合：没有 workdir 行', () => {
    state.own = {
      ...OWN,
      workdir: null,
      workspaceUnsuitable: 'working directory covers the home folder'
    }
    expect(rows().some((r) => r.startsWith('workdir:'))).toBe(false)
    expect(rows()).toContain(`system:tmp:${OWN.tmp}:write`)
  })

  it('DR-3 会话目录算不出：一行都不派生', () => {
    state.own = null
    expect(derivePathEntries('s1')).toEqual([])
  })

  it('DR-4 被 settingDirForAcl 拒的目录不进表', () => {
    state.rejected = new Set(['/kb/notes', '/ext/skills'])
    expect(rows().join('\n')).not.toMatch(/notes|\/ext\/skills/)
    expect(rows()).toContain('knowledge:project:real:/kb/project:write')
  })

  it('DR-5 知识库或技能读失败：那一类少给，其余照常', () => {
    state.targetsThrow = true
    expect(rows().some((r) => r.startsWith('knowledge:'))).toBe(false)
    expect(rows().filter((r) => r.startsWith('skill:'))).toHaveLength(3)

    state.targetsThrow = false
    state.skillsThrow = true
    expect(rows().some((r) => r.startsWith('skill:'))).toBe(false)
    expect(rows().filter((r) => r.startsWith('knowledge:'))).toHaveLength(3)
  })

  it('DR-6 同一来源的重复行只留一份', () => {
    state.skillRoots = ['/app/skills/en', '/ext/skills', '/ext/skills']
    expect(rows().filter((r) => r.startsWith('skill:'))).toEqual([
      'skill:real:/app/skills/en:real:/app/skills/en:read',
      'skill:real:/ext/skills:real:/ext/skills:read'
    ])
  })

  it('DR-7 笔记本会话多一行 document', () => {
    state.notebookPath = 'notes/plan.md'
    expect(rows().slice(0, 2)).toEqual([
      'workdir::/Users/u/proj:write',
      'document::real:/Users/u/proj/notes/plan.md:write'
    ])

    state.notebookPath = '/Users/u/.shuvix/agents/coding.md'
    expect(rows()[1]).toBe('document::real:/Users/u/.shuvix/agents/coding.md:write')

    state.rejected = new Set(['/Users/u/.shuvix/agents/coding.md'])
    expect(rows().some((r) => r.startsWith('document:'))).toBe(false)
  })
})
