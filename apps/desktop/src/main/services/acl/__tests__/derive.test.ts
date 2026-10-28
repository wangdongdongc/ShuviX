/**
 * 会话权限表的派生行（acl/derive.ts）—— 按会话此刻的设置算出应有的 workdir / system / knowledge / skill /
 * widgetDir 行。
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
 *   WT4-AC-13 有读写授权的组件（第二个参数）各派生一行可写的源码目录（widgetDir，sourceKey = 组件 id，目标 =
 *         settingDirForAcl(~/.shuvix/widgets/<id>)），排在技能之后、按传入顺序；不传 → 没有 widgetDir 行
 *   WT4-AC-14 不合规的 id 跳过；settingDirForAcl 拒了的那个跳过；取目录抛错 → warn `widget dirs unavailable: …`、
 *         别的来源照常；重复的 id 只留一行；会话目录算不出 → 一行都没有（组件的也没有）；派生不在家目录里建目录
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
  notebookPath: null as string | null,
  /** settingDirForAcl 遇到这些目录就抛错（WT4-AC-14） */
  throwing: new Set<string>(),
  /** widgetDirPath 的实现（缺省：假家目录下拼；WT4-AC-14 换成抛错的、真的） */
  widgetDirPath: (id: string): string => `/Users/u/.shuvix/widgets/${id}`,
  warns: [] as string[]
}))

vi.mock('../../../logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (msg: string) => state.warns.push(msg),
    error: () => {}
  })
}))
vi.mock('../../../utils/paths', () => ({
  getBuiltinSkillsDir: () => '/app/skills/en',
  widgetDirPath: (id: string) => state.widgetDirPath(id)
}))
vi.mock('../workdir', () => ({ sessionWorkingDirectory: () => '/Users/u/proj' }))
vi.mock('../../sessionRecords', () => ({
  sessionRecords: { pickSettings: () => ({ notebookPath: state.notebookPath }) }
}))
vi.mock('../../sandbox', () => ({
  sessionOwnDirsView: () => state.own,
  settingDirForAcl: (dir: string) => {
    if (state.throwing.has(dir)) throw new Error(`cannot resolve ${dir}`)
    return state.rejected.has(dir) ? null : `real:${dir}`
  }
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
  state.throwing = new Set()
  state.widgetDirPath = (id) => `/Users/u/.shuvix/widgets/${id}`
  state.warns = []
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

describe('derivePathEntries —— 组件源码目录（widgetDir）', () => {
  const widgetRows = (widgets?: readonly string[]): string[] =>
    derivePathEntries('s1', widgets)
      .filter((e) => e.source === 'widgetDir')
      .map((e) => `${e.sourceKey}:${e.target}:${e.access}`)

  it('WT4-AC-13 每个有读写授权的组件一行可写的源码目录，排在技能之后、按传入顺序；不传 → 没有', () => {
    const all = derivePathEntries('s1', ['w-a', 'w-b'])
    expect(all.slice(-2)).toEqual([
      {
        source: 'widgetDir',
        sourceKey: 'w-a',
        target: 'real:/Users/u/.shuvix/widgets/w-a',
        access: 'write'
      },
      {
        source: 'widgetDir',
        sourceKey: 'w-b',
        target: 'real:/Users/u/.shuvix/widgets/w-b',
        access: 'write'
      }
    ])
    // 前面照旧是完整的一份（DR-1）
    expect(
      all.slice(0, -2).map((e) => `${e.source}:${e.sourceKey}:${e.target}:${e.access}`)
    ).toEqual(rows())
    expect(widgetRows(['w-b', 'w-a'])).toEqual([
      'w-b:real:/Users/u/.shuvix/widgets/w-b:write',
      'w-a:real:/Users/u/.shuvix/widgets/w-a:write'
    ])
    expect(widgetRows()).toEqual([])
    expect(widgetRows([])).toEqual([])
    expect(state.warns).toEqual([])
  })

  it('WT4-AC-14 不合规的 id 跳过；settingDirForAcl 拒了的跳过；重复的只留一行', () => {
    state.rejected = new Set(['/Users/u/.shuvix/widgets/w-b'])
    expect(widgetRows(['nodash', 'w-a', '../x-y', 'A-b', '', 'w-b', 'w-a', 'w-c'])).toEqual([
      'w-a:real:/Users/u/.shuvix/widgets/w-a:write',
      'w-c:real:/Users/u/.shuvix/widgets/w-c:write'
    ])
    expect(state.warns).toEqual([])
  })

  it('WT4-AC-14 取目录抛错 → warn、组件那一类没有，别的来源照常', () => {
    state.throwing = new Set(['/Users/u/.shuvix/widgets/w-a'])
    const all = derivePathEntries('s1', ['w-a'])
    expect(all.some((e) => e.source === 'widgetDir')).toBe(false)
    expect(all.map((e) => `${e.source}:${e.sourceKey}:${e.target}:${e.access}`)).toEqual(rows())
    expect(state.warns).toEqual([
      'widget dirs unavailable: cannot resolve /Users/u/.shuvix/widgets/w-a'
    ])

    state.throwing = new Set()
    state.warns = []
    state.widgetDirPath = () => {
      throw new Error('no home')
    }
    expect(widgetRows(['w-a'])).toEqual([])
    expect(state.warns).toEqual(['widget dirs unavailable: no home'])
    expect(rows()).toHaveLength(10)
  })

  it('WT4-AC-14 会话目录算不出：一行都不派生，组件的也没有', () => {
    state.own = null
    expect(derivePathEntries('s1', ['w-a', 'w-b'])).toEqual([])
  })

  it('WT4-AC-14 派生只拼路径：用真的 widgetDirPath，家目录里不建任何目录', async () => {
    const actual =
      await vi.importActual<typeof import('../../../utils/paths')>('../../../utils/paths')
    state.widgetDirPath = actual.widgetDirPath
    const id = `wt4-derive-${process.pid}-${Date.now()}`
    const dir = join(homedir(), '.shuvix', 'widgets', id)
    expect(existsSync(dir)).toBe(false)
    expect(widgetRows([id])).toEqual([`${id}:real:${dir}:write`])
    expect(existsSync(dir)).toBe(false)
  })
})
