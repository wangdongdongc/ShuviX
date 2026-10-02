/**
 * 桌面安全 provider 单测 —— makeDesktopSecurityProvider / getDesktopSecurityContext 的
 * 放行范围与 allowList 语义（经真实 createSecurityContext + 内置策略评估链）。
 *
 * 出厂的路径策略只有一份：ask-on-external-path（2026-10-01）。文件工具在**会话目录**（vars.sessionDirs，
 * 与命令沙箱同一份清单）与「允许并记住」的路径以外 —— 读家目录里的文件（#0）、往任何地方写（#1）——
 * 询问。凭据位置不另算：它们就是「家目录里、会话目录外」。会话目录由真实的 sandbox.sessionDirsView 算
 * （electron 的 app.getPath 有替身 USER_DATA）：工作目录（适合时）、会话 TMPDIR、~/.shuvix/artifacts/<id>、
 * tool_results/<id>，加上会话设置带来的目录（勾选的知识库可读写；技能目录、只读的内置库只读 ——
 * vars.sessionReadDirs，只免读）。dao / sessionService / paths / skillService / knowledge/sessionBundle /
 * policyService 全部 mock（照 sessionStorage.test.ts 的惯例），allowList 条目语义保持真实 ——
 * Read 条目不得隐含写权限这条语义要真的被验证。
 *
 * 这里的家目录是**真实的** os.homedir()（只做判定，盘上什么都不建）；工作区、tool_results、技能目录
 * 等替身都在 tmpdir 下 —— 在家目录以外，所以那里的读不问，只有写看会话目录。要看「家目录里的读」的用例
 * 用 homedir() 下的路径。
 *
 * PERM-C：出厂的 protect-shuvix-config 已删（2026-10-01：出厂不留硬限制），但它引用的事实变量
 * vars.shuvixConfigDirs = 策略 / agent / hook / 默认技能目录（这里是 POLICIES_DIR / AGENTS_DIR /
 * HOOKS_DIR / DEFAULT_SKILLS）照旧由桌面给出。这一组把退役那份原文当作**用户策略**装回来
 * （state.userPolicies），钉住变量表的接线与 force-ask 的投递：「允许并记住」与审查员都答不了它
 * （PERM-C4 真实走一遍 enforcePath，审查者替身经 setPermissionReviewer 注入）；只有内置时
 * 那里的写只是普通的 ask-on-external-path#1（PERM-C0）。
 *
 * DP-A1：本会话自己的 artifacts 目录（~/.shuvix/artifacts/<id>，getSessionArtifactsDir 的 mock 与生产同形）
 * 是会话目录 —— 会话之间互不豁免：父会话在子会话的目录里写照问，读也问（它在家目录里）。
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { dirname, join } from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import type { UserPolicyFile } from '@shuvix/agent-runtime'
import { retiredPolicy } from '../../../../../../packages/agent-runtime/src/security/__tests__/fixtures/retiredPolicies'

const WORKSPACE = join(tmpdir(), 'shuvix-policy-ws')
const TOOL_RESULTS = join(tmpdir(), 'shuvix-policy-tool-results')
const DEFAULT_SKILLS = join(tmpdir(), 'shuvix-policy-skills')
const BUILTIN_SKILLS = join(tmpdir(), 'shuvix-policy-builtin-skills')
const MEMORY_ROOT = join(tmpdir(), 'shuvix-policy-memory')
const EXTERNAL_SKILLS = join(tmpdir(), 'shuvix-policy-external-skills')
const OUTSIDE = join(tmpdir(), 'shuvix-policy-elsewhere')
/** app.getPath('userData') 的替身（会话目录的规格要它；盘上不存在也行） */
const USER_DATA = join(tmpdir(), 'shuvix-policy-userdata')
/** vars.shuvixConfigDirs 的另外三个目录（第四个是 DEFAULT_SKILLS） */
const POLICIES_DIR = '/tmp/shuvix-policies'
const AGENTS_DIR = '/tmp/shuvix-agents'
const HOOKS_DIR = '/tmp/shuvix-hooks'

type KnowledgeTarget = { name: string; target: { dir: string; readonly?: boolean } }

const state = vi.hoisted(() => ({
  settings: undefined as { allowList?: string[] } | undefined,
  externalDirs: [] as { path: string }[],
  /** skillService.enabledSkillRoots（默认技能目录 + 没被停用的外部目录）—— 会话的只读目录 */
  skillRoots: [] as string[],
  /** knowledge/sessionBundle.enabledTargets（本会话勾选的知识库）；broken = 扫描抛错 */
  knowledgeTargets: [] as KnowledgeTarget[],
  knowledgeBroken: false,
  /** ~/.shuvix/policies 的替身（policyService.getUserPolicies 现扫的结果） */
  userPolicies: [] as UserPolicyFile[],
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA, isPackaged: false } }))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pickSettings: () => state.settings }
}))
vi.mock('../sessionService', () => ({
  sessionService: { getById: () => undefined, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({
  skillService: {
    listExternalDirs: () => state.externalDirs,
    enabledSkillRoots: () => state.skillRoots
  }
}))
vi.mock('../knowledge/sessionBundle', () => ({
  enabledTargets: () => {
    if (state.knowledgeBroken) throw new Error('knowledge scan failed')
    return state.knowledgeTargets
  }
}))
vi.mock('../policyService', () => ({
  policyService: {
    getUserPolicies: () => state.userPolicies,
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
  // vars.shuvixConfigDirs 的四个目录（退役的 protect-shuvix-config 引用它们）
  getDefaultPoliciesDir: () => POLICIES_DIR,
  getDefaultAgentsDir: () => AGENTS_DIR,
  getDefaultHooksDir: () => HOOKS_DIR,
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-builtin-knowledge',
  // 与生产同形：会话目录里的 artifacts 那一项按 os.homedir() 算，两边得是同一处
  getSessionArtifactsDir: (id: string) => join(homedir(), '.shuvix', 'artifacts', id),
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
/** 这一刻的桌面变量表（前提断言用：会话目录是哪一组） */
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

const ALLOW = { effect: 'allow', winning: 'default:path' }
/** 家目录里、会话目录外的读 */
const ASK_READ = { effect: 'ask', winning: 'ask-on-external-path#0' }
/** 会话目录外的写 */
const ASK_WRITE = { effect: 'ask', winning: 'ask-on-external-path#1' }

/** 盘上的真实去处（不存在的部分按最近的已存在祖先拼回 —— macOS 的 tmpdir 在 /private/var 下） */
const realOf = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    const parent = join(p, '..')
    return parent === p ? p : join(realOf(parent), p.slice(parent.length + 1))
  }
}

/** 家目录里一处会话目录以外的位置（只做判定，盘上不建） */
const HOME_PLACE = join(homedir(), 'shuvix-policy-home-place')

const REAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...REAL_PLATFORM, value: p })
}

beforeEach(() => {
  state.settings = undefined
  state.externalDirs = []
  state.skillRoots = []
  state.knowledgeTargets = []
  state.knowledgeBroken = false
  state.userPolicies = []
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM)
  setPermissionReviewer(null)
})

describe('桌面安全 provider — 出厂的外部目录访问策略（ask-on-external-path）', () => {
  it('PERM-0 前提：会话目录 = 解析过的工作区、~/.shuvix/artifacts/s1、tool_results/s1、会话 TMPDIR；只读目录里有随包的内置技能目录', () => {
    const vars = varsAt(WORKSPACE)
    expect(vars.sessionDirs).toEqual([
      realOf(WORKSPACE),
      expect.stringMatching(/^\/private\/tmp\/shuvix-\d+\/[0-9a-f]{8}$/),
      join(realOf(homedir()), '.shuvix', 'artifacts', 's1'),
      join(realOf(TOOL_RESULTS), 's1')
    ])
    expect(vars.sessionReadDirs).toEqual([realOf(BUILTIN_SKILLS)])
    // 家目录是事实变量：读规则看它
    expect(vars.home).toBe(homedir())
  })

  it('PERM-1: 工作区是会话目录 —— 区内与工作目录本身读写都不问', () => {
    for (const p of [join(WORKSPACE, 'src', 'a.ts'), WORKSPACE]) {
      expect({ p, read: verdict(context().evaluate('read', { type: 'path', path: p })) }).toEqual({
        p,
        read: ALLOW
      })
      expect({ p, write: verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual(
        { p, write: ALLOW }
      )
    }
  })

  it('PERM-8: 本会话的 tool_results 读写都不问；技能目录（默认 / 随包 / 外部，都在家目录外）读不问、写问 #1', () => {
    state.externalDirs = [{ path: EXTERNAL_SKILLS }]
    const own = join(TOOL_RESULTS, 's1', 'out.txt')
    expect(effectOf(context(), 'read', own)).toBe('allow')
    expect(effectOf(context(), 'write', own)).toBe('allow')
    for (const p of [
      join(DEFAULT_SKILLS, 'demo', 'SKILL.md'),
      join(BUILTIN_SKILLS, 'demo', 'SKILL.md'),
      join(EXTERNAL_SKILLS, 'demo', 'SKILL.md'),
      // 别的会话的 tool_results 不是本会话的目录
      join(TOOL_RESULTS, 's2', 'out.txt')
    ]) {
      expect({ p, read: effectOf(context(), 'read', p) }).toEqual({ p, read: 'allow' })
      expect({ p, write: verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual(
        { p, write: ASK_WRITE }
      )
    }
  })

  it('PERM-8b: 家目录外的未登记路径 read 放行、零命中；write 问 #1（系统位置也一样，没有更硬的门）', () => {
    for (const p of [join(OUTSIDE, 'a.txt'), '/etc/hosts']) {
      const decision = context().evaluate('read', { type: 'path', path: p })
      expect({ p, ...verdict(decision) }).toEqual({ p, ...ALLOW })
      expect(decision.matched, p).toEqual([])
      expect({ p, write: verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual(
        { p, write: ASK_WRITE }
      )
    }
  })

  it('PERM-8c: 家目录里、会话目录外的读问 #0 —— 凭据位置与普通文件同一问（凭据不另算）；写问 #1', () => {
    for (const p of [
      join(homedir(), '.ssh', 'id_rsa'),
      join(homedir(), '.shuvix', '.session-state'),
      join(HOME_PLACE, 'notes.txt')
    ]) {
      const read = context().evaluate('read', { type: 'path', path: p })
      expect({ p, ...verdict(read) }).toEqual({ p, ...ASK_READ })
      expect(read.matched, p).toEqual(['ask-on-external-path#0'])
      expect({ p, write: verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual(
        { p, write: ASK_WRITE }
      )
    }
  })
})

describe('桌面安全 provider — allowList 语义（「允许并记住」写进 ask-on-external-path 的 match）', () => {
  const target = join(HOME_PLACE, 'a.txt')

  it('PERM-4: Write(abs) 条目同时满足 write 与 read', () => {
    expect(effectOf(context(), 'write', target)).toBe('ask')
    expect(effectOf(context(), 'read', target)).toBe('ask')
    state.settings = { allowList: [`Write(${target})`] }
    expect(effectOf(context(), 'write', target)).toBe('allow')
    expect(effectOf(context(), 'read', target)).toBe('allow')
  })

  it('PERM-4: 只有 Read(abs) 条目时 write 不命中（读权限不隐含写权限）', () => {
    state.settings = { allowList: [`Read(${target})`] }
    expect(effectOf(context(), 'read', target)).toBe('allow')
    expect(verdict(context().evaluate('write', { type: 'path', path: target }))).toEqual(ASK_WRITE)
  })

  it('PERM-4: 目录条目按前缀命中，无 allowList 时恒不命中', () => {
    state.settings = { allowList: [`Write(${join(HOME_PLACE, 'sub')})`] }
    expect(effectOf(context(), 'write', join(HOME_PLACE, 'sub', 'deep', 'b.txt'))).toBe('allow')
    expect(effectOf(context(), 'read', join(HOME_PLACE, 'sub', 'deep', 'b.txt'))).toBe('allow')
    expect(effectOf(context(), 'write', join(HOME_PLACE, 'subsidiary.txt'))).toBe('ask')

    state.settings = undefined
    expect(effectOf(context(), 'write', target)).toBe('ask')
  })

  it('PERM-4: 询问材料的字面值就是 allowList 条目形态（路径是真实去处 —— macOS 的临时目录在 /private/var 下）', () => {
    const outside = join(OUTSIDE, 'a.txt')
    const decision = context().evaluate('write', { type: 'path', path: outside })
    const realTarget = join(realpathSync.native(tmpdir()), 'shuvix-policy-elsewhere', 'a.txt')
    expect(decision.effect).toBe('ask')
    expect(decision.ask?.command).toBe(`Write(${realTarget})`)
    expect(decision.ask?.rememberEntry).toBe(`Write(${realTarget})`)

    // read 的 ask 在家目录里（会话目录外）：同样给出「记住」
    const credential = join(homedir(), '.ssh', 'config')
    const readDecision = context().evaluate('read', { type: 'path', path: credential })
    expect(readDecision.ask?.command).toBe(`Read(${credential})`)
    expect(readDecision.ask?.rememberEntry).toBe(`Read(${credential})`)
  })
})

describe('桌面安全 provider — evaluateReadOnly（被动 UI 判定）', () => {
  it('与 evaluate 同一条线：家目录里会话目录外的读 false，工作区内、家目录外 true；授权写在策略 match 里（不是 force-allow 层），Read 授权同样算数', () => {
    const credential = join(homedir(), '.ssh', 'known_hosts')
    expect(context().evaluateReadOnly('read', { type: 'path', path: credential })).toBe(false)
    expect(context().evaluateReadOnly('read', { type: 'path', path: join(WORKSPACE, 'b') })).toBe(
      true
    )
    expect(context().evaluateReadOnly('read', { type: 'path', path: join(OUTSIDE, 'c') })).toBe(
      true
    )
    // includeForceAllow 缺省 false 只滤掉 force-allow 档的规则；会话授权已经不在那一档了
    state.settings = { allowList: [`Read(${credential})`] }
    expect(context().evaluateReadOnly('read', { type: 'path', path: credential })).toBe(true)
  })
})

describe('桌面安全 provider — 不缓存 settings 快照', () => {
  const target = join(OUTSIDE, 'a.txt')

  it('同一个 context 实例在 settings 变化后立即反映新值（会话中途「允许并记住」不该还弹旧快照）', () => {
    // context 在建会话时创建一次、整会话复用；每次判定都必须现读 SQLite
    const ctx = context()

    expect(verdict(ctx.evaluate('write', { type: 'path', path: target }))).toEqual(ASK_WRITE)

    // 会话中途对具体路径「允许并记住」：外部目录那一问不再命中
    state.settings = { allowList: [`Write(${target})`] }
    const granted = ctx.evaluate('write', { type: 'path', path: target })
    expect(verdict(granted)).toEqual(ALLOW)
    expect(granted.matched).toEqual([])

    // 条目被撤掉后同样立刻失效
    state.settings = { allowList: [] }
    expect(effectOf(ctx, 'write', target)).toBe('ask')
  })
})

describe('桌面安全 provider — 凭据位置不再另算（就是家目录里、会话目录外）', () => {
  it.each([
    ['~/.ssh/id_rsa', () => join(homedir(), '.ssh', 'id_rsa')],
    [
      '~/.shuvix/.session-state（加密 API key 的那把密钥）',
      () => join(homedir(), '.shuvix', '.session-state')
    ],
    ['~/.aws/credentials', () => join(homedir(), '.aws', 'credentials')]
  ])(
    'PERM-S1 %s：读问 #0、写问 #1，卡片都给「记住」；Write 授权之后读写都放行，Read 授权只放读',
    (_label, pathOf) => {
      const p = pathOf()
      const read = context().evaluate('read', { type: 'path', path: p })
      const write = context().evaluate('write', { type: 'path', path: p })
      expect(verdict(read)).toEqual(ASK_READ)
      expect(verdict(write)).toEqual(ASK_WRITE)
      // 不再有 force-ask / deny：卡片的「记住」是一个点了真的生效的按钮
      expect(read.tier).toBe('ask')
      expect(write.tier).toBe('ask')
      expect(read.ask?.rememberEntry).toBe(read.ask?.command)
      expect(write.ask?.rememberEntry).toBe(write.ask?.command)

      state.settings = { allowList: [`Write(${p})`] }
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual(ALLOW)
      expect(verdict(context().evaluate('read', { type: 'path', path: p }))).toEqual(ALLOW)

      state.settings = { allowList: [`Read(${p})`] }
      expect(verdict(context().evaluate('read', { type: 'path', path: p }))).toEqual(ALLOW)
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual(ASK_WRITE)
    }
  )
})

describe('桌面安全 provider — 本会话 artifacts 是会话目录', () => {
  const ART = join(homedir(), '.shuvix', 'artifacts')

  it('DP-A1 会话之间互不豁免：各自目录里读写放行；在对方（含父 → 子）的目录里写问 #1、读问 #0（它在家目录里）', () => {
    const matrix: Array<[string, string, boolean]> = [
      ['s1', `${ART}/s1/chart.svg`, true],
      ['child', `${ART}/child/chart.svg`, true],
      // 父会话在子会话的目录里不豁免（子会话有自己的目录，不是父会话的一部分）
      ['s1', `${ART}/child/chart.svg`, false],
      ['child', `${ART}/s1/chart.svg`, false]
    ]
    for (const [sessionId, path, own] of matrix) {
      const ctx = context(sessionId)
      const write = ctx.evaluate('write', { type: 'path', path })
      const read = ctx.evaluate('read', { type: 'path', path })
      expect({ sessionId, path, write: verdict(write), read: verdict(read) }).toEqual({
        sessionId,
        path,
        write: own ? ALLOW : ASK_WRITE,
        read: own ? ALLOW : ASK_READ
      })
      // 自己目录里的读写是真的没命中任何门（不是被哪条授权压过）
      if (own) expect(write.matched, `${sessionId} ${path}`).toEqual([])
    }
  })
})

/**
 * 会话设置带来的会话目录（toolContext.sessionDirExtras → sessionDirsView）：本会话勾选的知识库可读写
 * （vars.sessionDirs）；技能目录与只读的内置知识库只读（vars.sessionReadDirs —— 读规则免、写规则不免）。
 * 用家目录里的路径，读规则的豁免才看得出来。
 */
describe('桌面安全 provider — 勾选的知识库与技能目录', () => {
  const KB = join(homedir(), '.shuvix', 'knowledge', 'shuvix-policy-kb')
  const KB_UNTICKED = join(homedir(), '.shuvix', 'knowledge', 'shuvix-policy-kb-unticked')
  const KB_READONLY = join(homedir(), 'shuvix-policy-readonly-kb')
  const SKILLS_HOME = join(homedir(), '.shuvix', 'skills')

  it('PERM-K1 勾选的库在会话目录里：读写都不问；没勾的库照常问（读 #0、写 #1）', () => {
    state.knowledgeTargets = [{ name: 'shuvix-policy-kb', target: { dir: KB } }]
    expect(varsAt(WORKSPACE).sessionDirs).toContain(realOf(KB))

    const entry = join(KB, 'notes', 'entry.md')
    expect(verdict(context().evaluate('read', { type: 'path', path: entry }))).toEqual(ALLOW)
    expect(verdict(context().evaluate('write', { type: 'path', path: entry }))).toEqual(ALLOW)

    const other = join(KB_UNTICKED, 'entry.md')
    expect(verdict(context().evaluate('read', { type: 'path', path: other }))).toEqual(ASK_READ)
    expect(verdict(context().evaluate('write', { type: 'path', path: other }))).toEqual(ASK_WRITE)
  })

  it('PERM-K2 只读的库与启用的技能目录只免读：读不问、写问 #1（技能是 agent 自己要遵守的指令）', () => {
    state.knowledgeTargets = [{ name: 'shuvix', target: { dir: KB_READONLY, readonly: true } }]
    state.skillRoots = [SKILLS_HOME]
    const vars = varsAt(WORKSPACE)
    expect(vars.sessionReadDirs).toEqual(
      expect.arrayContaining([realOf(KB_READONLY), realOf(SKILLS_HOME)])
    )
    expect(vars.sessionDirs).not.toContain(realOf(KB_READONLY))
    expect(vars.sessionDirs).not.toContain(realOf(SKILLS_HOME))

    for (const p of [join(KB_READONLY, 'guide.md'), join(SKILLS_HOME, 'demo', 'SKILL.md')]) {
      expect({ p, read: verdict(context().evaluate('read', { type: 'path', path: p })) }).toEqual({
        p,
        read: ALLOW
      })
      expect({ p, write: verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual(
        { p, write: ASK_WRITE }
      )
    }
  })

  it('PERM-K3 知识库扫描抛错 → 少给（多问），评估不抛；技能目录照给', () => {
    state.knowledgeTargets = [{ name: 'shuvix-policy-kb', target: { dir: KB } }]
    state.knowledgeBroken = true
    state.skillRoots = [SKILLS_HOME]
    const entry = join(KB, 'entry.md')
    expect(verdict(context().evaluate('read', { type: 'path', path: entry }))).toEqual(ASK_READ)
    expect(verdict(context().evaluate('write', { type: 'path', path: entry }))).toEqual(ASK_WRITE)
    expect(
      verdict(context().evaluate('read', { type: 'path', path: join(SKILLS_HOME, 'x.md') }))
    ).toEqual(ALLOW)
  })
})

/**
 * 工作目录什么时候**不**算会话目录（sandbox/spec 的 workingDirectoryUnsuitable，策略与沙箱同一条理由）：
 * 是 `/` 或覆盖家目录、落在 ~/.shuvix 里内容目录（knowledge / knowledge-shuvix / widgets / artifacts）以外、
 * 落在应用数据里本会话临时工作区以外。不算时区内的写照问（#1）。真实平台是 Windows 时整组跳过：
 * 那里的路径写法与这里的 POSIX 期望对不上。
 */
describe.skipIf(process.platform === 'win32')(
  '桌面安全 provider — 工作目录与会话目录（与沙箱同一份清单）',
  () => {
    it('PERM-W1 区内写都不问 —— .vscode、git 的 hooks 也一样（.git 不再另算）；工作区外照问', () => {
      for (const p of [
        join(WORKSPACE, 'src', 'a.ts'),
        join(WORKSPACE, '.vscode', 'settings.json'),
        join(WORKSPACE, '.git', 'hooks', 'pre-commit'),
        join(WORKSPACE, '.git', 'config')
      ]) {
        expect({ p, ...verdict(context().evaluate('write', { type: 'path', path: p })) }).toEqual({
          p,
          ...ALLOW
        })
      }
      expect(
        verdict(context().evaluate('write', { type: 'path', path: join(OUTSIDE, 'a.txt') }))
      ).toEqual(ASK_WRITE)
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
      ],
      [
        '应用数据里（本会话临时工作区以外）',
        () => join(USER_DATA, 'sessions'),
        () => join(USER_DATA, 'sessions', 'a.txt')
      ],
      [
        '包含应用数据（userData 的上一级，如 ~/Library）',
        () => dirname(USER_DATA),
        () => join(USER_DATA, 'settings.db')
      ]
    ])(
      'PERM-W2 工作目录不适合（%s）→ 不在会话目录里，区内的写照问（#1）',
      (_label, wsOf, targetOf) => {
        const ws = wsOf()
        const dirs = varsAt(ws).sessionDirs as string[]
        expect(dirs).not.toContain(realOf(ws))
        // 其余几项照给：只是工作目录不算
        expect(dirs).toContain(join(realOf(homedir()), '.shuvix', 'artifacts', 's1'))
        expect(
          verdict(contextAt(ws).evaluate('write', { type: 'path', path: targetOf() }))
        ).toEqual(ASK_WRITE)
      }
    )

    it.each<[string, () => string]>([
      ['应用数据里本会话的临时工作区', () => join(USER_DATA, 'temp_workspace', 's1')],
      ['~/.shuvix/knowledge 里（内容目录）', () => join(homedir(), '.shuvix', 'knowledge', 'notes')]
    ])('PERM-W2b 工作目录在 %s → 算会话目录，区内读写不问', (_label, wsOf) => {
      const ws = wsOf()
      expect(varsAt(ws).sessionDirs).toContain(realOf(ws))
      const p = join(ws, 'a.md')
      expect(verdict(contextAt(ws).evaluate('write', { type: 'path', path: p }))).toEqual(ALLOW)
      expect(verdict(contextAt(ws).evaluate('read', { type: 'path', path: p }))).toEqual(ALLOW)
    })

    it('PERM-W3 会话目录与平台、沙箱开关无关：Windows 上（没有沙箱后端）工作区照样是会话目录，区内写不问', () => {
      const p = join(WORKSPACE, 'src', 'a.ts')
      setPlatform('win32')
      expect(varsAt(WORKSPACE).sessionDirs).toContain(realOf(WORKSPACE))
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual(ALLOW)
    })
  }
)

/**
 * vars.shuvixConfigDirs + 退役的 protect-shuvix-config（作为用户策略装回）：策略、agent、hook、默认技能目录
 * （~/.shuvix/{policies,agents,hooks,skills}）里的写入恒问人 ——「允许并记住」、自动审查都答不了（审查员与
 * 触发它的 hook 本身就是那里的 md）。外部技能目录与随包的内置技能目录不在变量里，照常走 ask-on-external-path。
 * 出厂（只有内置）时这些目录里的写只是普通的 ask-on-external-path#1（PERM-C0）。
 */
describe('桌面安全 provider — ShuviX 自己的配置（vars.shuvixConfigDirs）', () => {
  const usedSessions = new Set<string>()
  const withConfigGuard = (): void => {
    state.userPolicies = [retiredPolicy('protect-shuvix-config')]
  }
  afterEach(() => {
    for (const id of usedSessions) {
      clearReviewState(id)
      clearSessionDecisions(id)
    }
    usedSessions.clear()
  })

  it('PERM-C0 出厂（只有内置）：这四个目录里的写是普通的 ask-on-external-path#1，可以记住；读不问（它们在家目录外）', () => {
    for (const p of [
      join(AGENTS_DIR, 'permission-reviewer.md'),
      join(POLICIES_DIR, 'ask-on-external-path.md'),
      join(HOOKS_DIR, 'auto-review.md'),
      join(DEFAULT_SKILLS, 'demo', 'SKILL.md')
    ]) {
      const d = context().evaluate('write', { type: 'path', path: p })
      expect({ p, effect: d.effect, tier: d.tier, winning: d.winning }).toEqual({
        p,
        effect: 'ask',
        tier: 'ask',
        winning: 'ask-on-external-path#1'
      })
      expect(d.ask?.rememberEntry, p).toBe(d.ask?.command)
      expect(context().evaluate('read', { type: 'path', path: p }).winning, p).toBe('default:path')
    }
  })

  it('PERM-C1 装回 protect-shuvix-config：写 agents / policies / hooks 目录与 DEFAULT_SKILLS → protect-shuvix-config#0（force-ask），卡片不给「允许并记住」；只管写、按路径段边界判', () => {
    withConfigGuard()
    for (const p of [
      join(AGENTS_DIR, 'permission-reviewer.md'),
      join(POLICIES_DIR, 'ask-on-external-path.md'),
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
      // 那条授权压不过这道门：给出「记住」按钮就是一个点了不生效的假承诺
      expect(d.ask?.rememberEntry, p).toBeUndefined()
      // 读不归它
      expect(context().evaluate('read', { type: 'path', path: p }).matched, p).not.toContain(
        'protect-shuvix-config#0'
      )
    }
    // 同前缀的兄弟目录不是它守的地方：普通的会话目录外的写
    const sibling = context().evaluate('write', { type: 'path', path: `${AGENTS_DIR}-old/x.md` })
    expect(verdict(sibling)).toEqual(ASK_WRITE)
    expect(sibling.matched).not.toContain('protect-shuvix-config#0')
  })

  it('PERM-C2 装回 protect-shuvix-config：allowList 里有 Write(<agents 目录>) / Write(<那个文件>) —— 照样问：授权让外部目录那一问不再命中，但压不过 force-ask', () => {
    withConfigGuard()
    const p = join(AGENTS_DIR, 'x.md')
    for (const settings of [
      { allowList: [`Write(${AGENTS_DIR})`] },
      { allowList: [`Write(${p})`] }
    ]) {
      state.settings = settings
      const d = context().evaluate('write', { type: 'path', path: p })
      expect({ settings, ...verdict(d) }).toEqual({
        settings,
        effect: 'ask',
        winning: 'protect-shuvix-config#0'
      })
      expect(d.matched, JSON.stringify(settings)).not.toContain('ask-on-external-path#1')
    }
    // 对照：同样形状的授权对普通的区外文件是放行
    const outside = join(OUTSIDE, 'a.txt')
    state.settings = { allowList: [`Write(${outside})`] }
    expect(effectOf(context(), 'write', outside)).toBe('allow')
  })

  it('PERM-C3 装回 protect-shuvix-config 也只守 ~/.shuvix/skills：外部技能目录、随包的内置技能目录里的写是普通的 ask-on-external-path#1（可以记住）', () => {
    withConfigGuard()
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
        winning: 'ask-on-external-path#1'
      })
      expect(d.matched, p).not.toContain('protect-shuvix-config#0')
      expect(d.ask?.rememberEntry, p).toBe(d.ask?.command)
    }
  })

  it('PERM-C4 装回 protect-shuvix-config + 真实 enforcePath + 审查者替身：写 agents 目录 → 审查者 0 次、弹卡 1 次（卡上没有审查意见）；写会话目录外的普通文件 → 审查者 1 次（它答不出 → 照旧弹卡）', async () => {
    withConfigGuard()
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
    expect(event.decision).toMatchObject({
      effect: 'ask',
      tier: 'ask',
      winning: 'ask-on-external-path#1'
    })
    expect(asks).toHaveLength(2)
    expect(asks[1]).toMatchObject({ kind: 'ask', id: 'c4-outside' })
  })
})
