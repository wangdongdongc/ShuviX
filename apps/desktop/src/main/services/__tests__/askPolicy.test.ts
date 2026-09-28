/**
 * 桌面安全 provider 单测 —— makeDesktopSecurityProvider / getDesktopSecurityContext 的
 * 放行范围与 allowList 语义（经真实 createSecurityContext + 内置策略评估链）。
 *
 * 核心收紧点：工作区写入视图为空时，工作目录只对 read 放行，write 一律落到询问链（免询问 /
 * allowList / 弹窗）。dao / sessionService / paths / skillService / policyService 全部 mock
 * （照 sessionStorage.test.ts 的惯例），allowList 条目语义保持真实 ——
 * Read 条目不得隐含写权限这条语义要真的被验证。
 *
 * 工作区写入视图（ask-on-write 的 vars.workspace*，sandbox.workspaceWriteView 给、与沙箱开没开无关）：
 * sandbox 模块用真实实现 + workspaceWriteView 的透传 spy，electron 的 app.getPath 有替身（USER_DATA）。
 * **旧用例在 beforeEach 里显式拿到空视图**（Windows / 工作区不适合 / 视图算不出来时就是这样）——
 * 它们钉的是询问链本身，「区内写要问」只在空视图下成立；过去这一点靠的是没 mock electron 时
 * app.getPath 抛错被吞掉，现在写明。PERM-W 一组改回真实实现，看视图算得出来 / 算不出来的两面。
 *
 * PERM-C：protect-shuvix-config（force-ask）守 vars.shuvixConfigDirs = 策略 / agent / hook / 默认技能
 * 目录（这里是 POLICIES_DIR / AGENTS_DIR / HOOKS_DIR / DEFAULT_SKILLS）—— 免询问、「允许并记住」与
 * 审查员都答不了它（PERM-C4 真实走一遍 enforcePath，审查者替身经 setPermissionReviewer 注入）。
 *
 * DP-A1：ask-on-write / ask-on-read 对**本会话自己的** artifacts 目录免询问
 * （vars.sessionArtifactsDir = getSessionArtifactsDir(ctx.sessionId)）—— 会话之间互不豁免，
 * 父会话在子会话的目录里也照问。mock 的 `/tmp/shuvix-artifacts/<id>` 盘上不存在，且 macOS 上
 * /tmp 是 /private/tmp 的链接：两侧都经 realPath 解析，比的是同一处。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

const WORKSPACE = join(tmpdir(), 'shuvix-policy-ws')
const TOOL_RESULTS = join(tmpdir(), 'shuvix-policy-tool-results')
const DEFAULT_SKILLS = join(tmpdir(), 'shuvix-policy-skills')
const BUILTIN_SKILLS = join(tmpdir(), 'shuvix-policy-builtin-skills')
const MEMORY_ROOT = join(tmpdir(), 'shuvix-policy-memory')
const EXTERNAL_SKILLS = join(tmpdir(), 'shuvix-policy-external-skills')
const OUTSIDE = join(tmpdir(), 'shuvix-policy-elsewhere')
/** app.getPath('userData') 的替身（工作区写入视图的规格要它；盘上不存在也行） */
const USER_DATA = join(tmpdir(), 'shuvix-policy-userdata')
/** protect-shuvix-config 的另外三个目录（getVars 的 shuvixConfigDirs；第四个是 DEFAULT_SKILLS） */
const POLICIES_DIR = '/tmp/shuvix-policies'
const AGENTS_DIR = '/tmp/shuvix-agents'
const HOOKS_DIR = '/tmp/shuvix-hooks'

const state = vi.hoisted(() => ({
  settings: undefined as { autoAllow?: boolean; allowList?: string[] } | undefined,
  externalDirs: [] as { path: string }[],
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA, isPackaged: false } }))
// 真实模块 + workspaceWriteView 换成透传 spy：旧用例按用例给空视图，PERM-W 回到真实实现
vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  return { ...actual, workspaceWriteView: vi.fn(actual.workspaceWriteView) }
})
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
  policyService: {
    getUserPolicies: () => [],
    // 与 policyService.readBuiltinPolicyMd 同形，只是基准目录直接钉在仓库那份上
    readBuiltinPolicyMd: (fileName: string) => {
      try {
        return readFileSync(join(state.builtinDir, fileName), 'utf-8')
      } catch {
        return null
      }
    }
  }
}))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: () => WORKSPACE,
  getToolResultsBase: () => TOOL_RESULTS,
  getDefaultSkillsDir: () => DEFAULT_SKILLS,
  getBuiltinSkillsDir: () => BUILTIN_SKILLS,
  getMemoryRootDir: () => MEMORY_ROOT,
  getDefaultBotsDir: () => '/tmp/shuvix-bots',
  // protect-shuvix-config 的四个目录（getVars 的 shuvixConfigDirs）
  getDefaultPoliciesDir: () => POLICIES_DIR,
  getDefaultAgentsDir: () => AGENTS_DIR,
  getDefaultHooksDir: () => HOOKS_DIR,
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-builtin-knowledge',
  getSessionArtifactsDir: (id: string) => `/tmp/shuvix-artifacts/${id}`,
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..')
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  getDesktopSecurityContext,
  makeDesktopSecurityProvider,
  setPermissionReviewer,
  type ProjectConfig
} from '../toolContext'
import { workspaceWriteView } from '../sandbox'
import {
  clearReviewState,
  clearSessionDecisions,
  type PermissionRequestEvent,
  type PermissionReviewAnswer,
  type SecurityContext,
  type SecurityDecision,
  type SecurityEffect
} from '@shuvix/agent-runtime'
import type { AskInputRequest, InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

const config: ProjectConfig = { workingDirectory: WORKSPACE }
const context = (sessionId = 's1'): SecurityContext =>
  getDesktopSecurityContext({ sessionId }, () => config)
/** 工作目录不是 WORKSPACE 的会话（PERM-W2 换工作区） */
const contextAt = (workingDirectory: string, sessionId = 's1'): SecurityContext =>
  getDesktopSecurityContext({ sessionId }, () => ({ workingDirectory }))
/** 这一刻的桌面变量表（前提断言用：沙箱那一面与工作区写入视图各是什么） */
const varsAt = (workingDirectory: string, sessionId = 's1'): Record<string, unknown> =>
  makeDesktopSecurityProvider({ sessionId }, () => ({ workingDirectory })).getVars() as Record<
    string,
    unknown
  >

/** 完整评估链（含 force-allow 层）的 effect */
const effectOf = (ctx: SecurityContext, mode: 'read' | 'write', p: string): SecurityEffect =>
  ctx.evaluate(mode, { type: 'path', path: p }).effect

const verdict = (d: SecurityDecision): { effect: string; winning: string } => ({
  effect: d.effect,
  winning: d.winning
})

const workspaceWriteViewSpy = vi.mocked(workspaceWriteView)
/** 空的工作区写入视图（Windows、工作区不适合、规格算不出来时 workspaceWriteView 给的就是它） */
const emptyWorkspaceView = (): ReturnType<typeof workspaceWriteView> => ({
  workspaceWritable: [],
  workspaceWriteDenied: [],
  workspaceProtectedPatterns: []
})
/** 回到真实的 workspaceWriteView（vi.fn(impl) 的 mockReset = 透传原实现） */
const useComputedWorkspaceView = (): void => {
  workspaceWriteViewSpy.mockReset()
}

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: p })
}

beforeEach(() => {
  state.settings = undefined
  state.externalDirs = []
  // 旧用例一律显式拿空视图（见文件头）；要看真实视图的用例自己换回去
  workspaceWriteViewSpy.mockReset()
  workspaceWriteViewSpy.mockImplementation(emptyWorkspaceView)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM)
  setPermissionReviewer(null)
})

describe('桌面安全 provider — 默认放行 + 内置写入门（ask-on-write）', () => {
  it('PERM-1: 工作区写入视图为空时 —— 读取默认放行（无策略即自由），write 落询问链（ask）', () => {
    // 前提写明：这条会话的工作区写入视图是空的（beforeEach 给的）；视图算得出来时区内写放行，见 PERM-W1
    expect(varsAt(WORKSPACE)).toMatchObject(emptyWorkspaceView())
    const p = join(WORKSPACE, 'src', 'a.ts')
    expect(effectOf(context(), 'read', p)).toBe('allow')
    expect(effectOf(context(), 'write', p)).toBe('ask')
  })

  it('PERM-1: 工作区写入视图为空时 —— 工作目录本身同样是 read 放行 / write 需询问', () => {
    expect(varsAt(WORKSPACE)).toMatchObject(emptyWorkspaceView())
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

describe('桌面安全 provider — allowList 语义（force-allow 层）', () => {
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

  it('PERM-4: 询问材料的字面值就是 allowList 条目形态（路径是真实去处 —— macOS 的临时目录在 /private/var 下）', () => {
    const decision = context().evaluate('write', { type: 'path', path: target })
    const realTarget = join(realpathSync.native(tmpdir()), 'shuvix-policy-ws', 'a.txt')
    expect(decision.effect).toBe('ask')
    expect(decision.ask?.command).toBe(`Write(${realTarget})`)
    expect(decision.ask?.rememberEntry).toBe(`Write(${realTarget})`)

    // read 的 ask 只剩凭据目录（其余默认放行无询问材料）
    const credential = join(homedir(), '.ssh', 'config')
    const readDecision = context().evaluate('read', { type: 'path', path: credential })
    expect(readDecision.ask?.command).toBe(`Read(${credential})`)
  })
})

describe('桌面安全 provider — evaluateReadOnly（被动 UI 判定）', () => {
  it('缺省不含 force-allow 层：allowList/autoAllow 不放宽 UI 范围（凭据目录 ask 门仍生效）', () => {
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
    expect(ctx.evaluate('write', { type: 'path', path: target }).winning).toBe('session-grants#0')

    // 再关掉，改为对具体路径「允许并记住」
    state.settings = { allowList: [`Write(${target})`] }
    expect(effectOf(ctx, 'write', target)).toBe('allow')

    // 条目被撤掉后同样立刻失效
    state.settings = { allowList: [] }
    expect(effectOf(ctx, 'write', target)).toBe('ask')
  })
})

describe('桌面安全 provider — deny 层压制 force-allow（protect-credentials 策略）', () => {
  it('凭据目录写入即使开了免询问也 deny', () => {
    state.settings = { autoAllow: true }
    const sshKey = join(homedir(), '.ssh', 'id_rsa')
    const decision = context().evaluate('write', { type: 'path', path: sshKey })
    expect(decision.effect).toBe('deny')
    expect(decision.winning).toContain('protect-credentials')
  })
})

describe('桌面安全 provider — 本会话 artifacts 免询问（ask-on-write / ask-on-read）', () => {
  const ART = '/tmp/shuvix-artifacts'

  it('DP-A1 会话之间互不豁免：各自目录里读写放行；在对方（含父 → 子）的目录里读写照问', () => {
    const matrix: Array<[string, string, SecurityEffect]> = [
      ['s1', `${ART}/s1/chart.svg`, 'allow'],
      ['child', `${ART}/child/chart.svg`, 'allow'],
      // 父会话在子会话的目录里不豁免（子会话有自己的目录，不是父会话的一部分）
      ['s1', `${ART}/child/chart.svg`, 'ask'],
      ['child', `${ART}/s1/chart.svg`, 'ask']
    ]
    for (const [sessionId, path, expected] of matrix) {
      const ctx = context(sessionId)
      for (const mode of ['read', 'write'] as const) {
        expect({ sessionId, path, mode, effect: effectOf(ctx, mode, path) }).toEqual({
          sessionId,
          path,
          mode,
          effect: expected
        })
      }
      if (expected === 'ask') {
        expect(ctx.evaluate('read', { type: 'path', path }).winning, `${sessionId} ${path}`).toBe(
          'ask-on-read#0'
        )
        expect(ctx.evaluate('write', { type: 'path', path }).winning, `${sessionId} ${path}`).toBe(
          'ask-on-write#0'
        )
      } else {
        // 自己目录里的写是真的没命中任何门（不是被哪条授权压过）
        expect(ctx.evaluate('write', { type: 'path', path }).winning, `${sessionId} ${path}`).toBe(
          'default:path'
        )
      }
    }
  })
})

/**
 * 工作区写入视图 —— ask-on-write 的工作区豁免与沙箱脱钩（沙箱没固定、INACTIVE 也照样给）。
 * 规格与沙箱同一份：工作区是 `/`、覆盖家目录、是 ShuviX 自己的配置时一样不给；受保护位置（git 元数据、
 * 项目根的 .vscode 等）照旧问；Windows 恒空（受保护模式是按 `/` 写的正则）。
 * 真实平台是 Windows 时整组跳过：那里视图恒空，「算得出来」的一面无从谈起。
 */
describe.skipIf(process.platform === 'win32')(
  '桌面安全 provider — 工作区写入视图（ask-on-write 的工作区豁免与沙箱无关）',
  () => {
    const realWorkspace = (): string => join(realpathSync.native(tmpdir()), 'shuvix-policy-ws')

    it('PERM-W1 视图算得出来（app.getPath 有替身、沙箱没固定）：区内写放行；.git/hooks、.vscode 照旧 ask-on-write#0；工作区外照问', () => {
      useComputedWorkspaceView()
      // 前提：沙箱那一面没启用（会话没固定），工作区写入视图却算出来了 —— 两者无关
      const vars = varsAt(WORKSPACE)
      expect(vars.sandboxActive).toBe(false)
      expect(vars.workspaceWritable).toEqual([realWorkspace()])
      expect(vars.workspaceWriteDenied).toContain(join(realWorkspace(), '.vscode'))
      expect(vars.workspaceProtectedPatterns).not.toEqual([])

      expect(
        verdict(context().evaluate('write', { type: 'path', path: join(WORKSPACE, 'src', 'a.ts') }))
      ).toEqual({
        effect: 'allow',
        winning: 'default:path'
      })
      for (const p of [
        join(WORKSPACE, '.git', 'hooks', 'pre-commit'),
        join(WORKSPACE, '.vscode', 'settings.json')
      ]) {
        expect({ p, ...verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual({
          p,
          effect: 'ask',
          winning: 'ask-on-write#0'
        })
      }
      expect(
        verdict(context().evaluate('write', { type: 'path', path: join(OUTSIDE, 'a.txt') }))
      ).toEqual({
        effect: 'ask',
        winning: 'ask-on-write#0'
      })
    })

    it.each<[string, () => string, () => string]>([
      [
        '家目录（覆盖 $HOME）',
        () => homedir(),
        () => join(homedir(), 'shuvix-policy-perm-w2', 'a.txt')
      ],
      ['/', () => '/', () => join(OUTSIDE, 'a.txt')],
      [
        '~/.shuvix/agents（ShuviX 自己的配置）',
        () => join(homedir(), '.shuvix', 'agents'),
        () => join(homedir(), '.shuvix', 'agents', 'x.md')
      ]
    ])(
      'PERM-W2 工作区不适合（%s）→ 工作区写入视图为空，区内的写照问（ask-on-write#0）',
      (_label, wsOf, targetOf) => {
        useComputedWorkspaceView()
        const ws = wsOf()
        expect(varsAt(ws)).toMatchObject(emptyWorkspaceView())
        // 这里 shuvixConfigDirs 是替身目录（/tmp/shuvix-*），真实的 ~/.shuvix/agents 不归 protect-shuvix-config：
        // 问它的是 ask-on-write —— 恰好说明工作区豁免没给出去
        expect(
          verdict(contextAt(ws).evaluate('write', { type: 'path', path: targetOf() }))
        ).toEqual({
          effect: 'ask',
          winning: 'ask-on-write#0'
        })
      }
    )

    it('PERM-W3 Windows：工作区写入视图恒空（受保护模式按 `/` 写，在 `\\` 路径上会静默不匹配），区内写照问；换回真实平台同一条写放行', () => {
      useComputedWorkspaceView()
      const p = join(WORKSPACE, 'src', 'a.ts')

      setPlatform('win32')
      expect(varsAt(WORKSPACE)).toMatchObject(emptyWorkspaceView())
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual({
        effect: 'ask',
        winning: 'ask-on-write#0'
      })

      Object.defineProperty(process, 'platform', REAL_PLATFORM)
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual({
        effect: 'allow',
        winning: 'default:path'
      })
    })
  }
)

/**
 * protect-shuvix-config（force-ask）：策略、agent、hook、默认技能目录（~/.shuvix/{policies,agents,hooks,skills}）
 * 里的写入恒问人 —— 免询问、「允许并记住」、自动审查都答不了（审查员与触发它的 hook 本身就是那里的 md）。
 * 外部技能目录与随包的内置技能目录不在其中，照常走 ask-on-write。
 */
describe('桌面安全 provider — ShuviX 自己的配置（protect-shuvix-config）', () => {
  const usedSessions = new Set<string>()
  afterEach(() => {
    for (const id of usedSessions) {
      clearReviewState(id)
      clearSessionDecisions(id)
    }
    usedSessions.clear()
  })

  it('PERM-C1 写 agents / policies / hooks 目录与 DEFAULT_SKILLS → protect-shuvix-config#0（force-ask），卡片不给「允许并记住」；只管写、按路径段边界判', () => {
    for (const p of [
      join(AGENTS_DIR, 'permission-reviewer.md'),
      join(POLICIES_DIR, 'ask-on-write.md'),
      join(HOOKS_DIR, 'auto-review.md'),
      join(DEFAULT_SKILLS, 'demo', 'SKILL.md')
    ]) {
      const d = context().evaluate('write', { type: 'path', path: p })
      expect({ p, effect: d.effect, tier: d.tier, winning: d.winning }).toEqual({
        p,
        effect: 'ask',
        tier: 'force-ask',
        winning: 'protect-shuvix-config#0'
      })
      expect(d.ask?.command, p).toMatch(/^Write\(/)
      // 那条授权落在 force-allow 层、压不过这道门：给出「记住」按钮就是一个点了不生效的假承诺
      expect(d.ask?.rememberEntry, p).toBeUndefined()
      // 读不归它
      expect(context().evaluate('read', { type: 'path', path: p }).matched, p).not.toContain(
        'protect-shuvix-config#0'
      )
    }
    // 同前缀的兄弟目录不是它守的地方：普通的 ask-on-write
    const sibling = context().evaluate('write', { type: 'path', path: `${AGENTS_DIR}-old/x.md` })
    expect(verdict(sibling)).toEqual({ effect: 'ask', winning: 'ask-on-write#0' })
    expect(sibling.matched).not.toContain('protect-shuvix-config#0')
  })

  it('PERM-C2 免询问开着、或 allowList 里有 Write(<agents 目录>) / Write(<那个文件>) —— 照样问：授权命中了，但压不过 force-ask', () => {
    const p = join(AGENTS_DIR, 'x.md')
    const cases: Array<[{ autoAllow?: boolean; allowList?: string[] }, string]> = [
      [{ autoAllow: true }, 'session-grants#0'],
      [{ allowList: [`Write(${AGENTS_DIR})`] }, 'session-grants#2'],
      [{ allowList: [`Write(${p})`] }, 'session-grants#2']
    ]
    for (const [settings, grantRule] of cases) {
      state.settings = settings
      const d = context().evaluate('write', { type: 'path', path: p })
      expect({ settings, ...verdict(d) }).toEqual({
        settings,
        effect: 'ask',
        winning: 'protect-shuvix-config#0'
      })
      expect(d.matched, JSON.stringify(settings)).toContain(grantRule)
    }
    // 对照：同样的授权对普通的区外文件是放行
    state.settings = { autoAllow: true }
    expect(effectOf(context(), 'write', join(OUTSIDE, 'a.txt'))).toBe('allow')
  })

  it('PERM-C3 只守 ~/.shuvix/skills：外部技能目录、随包的内置技能目录里的写是普通的 ask-on-write#0（可以记住）', () => {
    state.externalDirs = [{ path: EXTERNAL_SKILLS }]
    for (const p of [
      join(EXTERNAL_SKILLS, 'demo', 'SKILL.md'),
      join(BUILTIN_SKILLS, 'demo', 'SKILL.md')
    ]) {
      const d = context().evaluate('write', { type: 'path', path: p })
      expect({ p, effect: d.effect, tier: d.tier, winning: d.winning }).toEqual({
        p,
        effect: 'ask',
        tier: 'ask',
        winning: 'ask-on-write#0'
      })
      expect(d.matched, p).not.toContain('protect-shuvix-config#0')
      expect(d.ask?.rememberEntry, p).toBe(d.ask?.command)
    }
  })

  it('PERM-C4 真实 enforcePath + 审查者替身：写 agents 目录 → 审查者 0 次、弹卡 1 次（卡上没有审查意见）；写工作区外的普通文件 → 审查者 1 次（它答不出 → 照旧弹卡）', async () => {
    const sessionId = 'perm-c4'
    usedSessions.add(sessionId)
    const reviewer = vi.fn(
      async (
        _event: PermissionRequestEvent,
        _signal?: AbortSignal
      ): Promise<PermissionReviewAnswer | null> => null
    )
    setPermissionReviewer(reviewer)
    const asks: InputRequest[] = []
    const ctx = getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req)
          return { kind: 'ask', allowed: true }
        }
      },
      () => config
    )

    await ctx.enforcePath('write', join(AGENTS_DIR, 'x.md'), {
      toolCallId: 'c4-agents',
      toolName: 'write'
    })
    expect(reviewer).not.toHaveBeenCalled()
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'ask', id: 'c4-agents', toolName: 'write' })
    expect((asks[0] as AskInputRequest).review).toBeUndefined()

    await ctx.enforcePath('write', join(OUTSIDE, 'a.txt'), {
      toolCallId: 'c4-outside',
      toolName: 'write'
    })
    expect(reviewer).toHaveBeenCalledTimes(1)
    const [event] = reviewer.mock.calls[0]
    expect(event.toolCallId).toBe('c4-outside')
    expect(event.decision).toMatchObject({ effect: 'ask', tier: 'ask', winning: 'ask-on-write#0' })
    expect(asks).toHaveLength(2)
    expect(asks[1]).toMatchObject({ kind: 'ask', id: 'c4-outside' })
  })
})
