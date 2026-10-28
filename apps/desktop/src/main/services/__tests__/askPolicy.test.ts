/**
 * 桌面安全 provider 单测 —— makeDesktopSecurityProvider / getDesktopSecurityContext 的
 * 放行范围与会话授权语义（经真实 createSecurityContext + 内置策略评估链）。
 *
 * 出厂的路径策略只有一份：ask-on-external-path（2026-10-01）。文件工具在**会话权限表**（vars.aclRead /
 * vars.aclWrite，与命令沙箱同一张表）以外 —— 读家目录里的文件（#0）、往任何地方写（#1）—— 询问。凭据位置
 * 不另算：它们就是「家目录里、权限表外」。权限表是真的（services/acl：派生行由真实的 acl/derive 按会话的
 * 设置算，会话自己的目录由真实的 sandbox.sessionOwnDirsView 算，electron 的 app.getPath 有替身 USER_DATA）：
 * 工作目录（适合时）、会话 TMPDIR、~/.shuvix/artifacts/<id>、tool_results/<id> 可写，勾选的知识库可写，
 * 技能目录与只读的内置库只读（只在 aclRead 里，只免读），加上「允许并记住」授予的路径。这里的会话都是
 * **内存会话**（sessionRecords 的 ephemeral 行，工作目录写在 settings 里）—— 权限表随之只在内存里，不碰库。
 * dao / sessionService / paths / skillService / knowledge/sessionBundle / policyService 全部 mock（照
 * sessionStorage.test.ts 的惯例），授权语义保持真实（sessionAcl.grantPath → pathAclView）—— 读授权不得隐含
 * 写权限这条语义要真的被验证。
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
 * PERM-D：内置安全策略的停用开关接到 SecurityHostProvider.isPolicyDisabled（policyService.isDisabled 的替身按
 * state.disabled 答）—— 停用 ask-on-external-path，读家目录、往外写都不再问；停用 ask-on-command，沙箱外命令
 * 不再问而路径门照问。
 *
 * DP-A1：本会话自己的 artifacts 目录（~/.shuvix/artifacts/<id>，getSessionArtifactsDir 的 mock 与生产同形）
 * 是会话目录 —— 会话之间互不豁免：父会话在子会话的目录里写照问，读也问（它在家目录里）。
 *
 * XS-37…XS-40：`session` 工具与别的会话交互（enforceSession，出厂的 ask-on-session-access）——「允许并记住」
 * 经真实的 sessionAcl.grantSession 写进权限表的会话行（vars.aclSessionRead / aclSessionWrite），见文件末尾。
 *
 * WT4-AC-18…22：`widget` 工具用组件（enforceWidget，出厂的 ask-on-widget-access）——「允许并记住」经真实的
 * sessionAcl.grantWidget 写进权限表的组件行（vars.aclWidgetRead / aclWidgetWrite）；读写行派生出组件源码目录的
 * 可写行（真实的 derive，目录 = ~/.shuvix/widgets/<id>）。见文件末尾。
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
  externalDirs: [] as { path: string }[],
  /** skillService.enabledSkillRoots（默认技能目录 + 没被停用的外部目录）—— 会话的只读目录 */
  skillRoots: [] as string[],
  /** knowledge/sessionBundle.enabledTargets（本会话勾选的知识库）；broken = 扫描抛错 */
  knowledgeTargets: [] as KnowledgeTarget[],
  knowledgeBroken: false,
  /** ~/.shuvix/policies 的替身（policyService.getUserPolicies 现扫的结果） */
  userPolicies: [] as UserPolicyFile[],
  /** 被停用的对象 id（policyService.isDisabled 的替身按它答：内置安全策略的停用开关） */
  disabled: new Set<string>(),
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('electron', () => ({ app: { getPath: () => USER_DATA, isPackaged: false } }))
vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
// 会话行都是内存会话（见 ensureSession）：库里一条都没有
vi.mock('../../dao/sessionDao', () => ({
  sessionDao: { pick: () => undefined, pickSettings: () => undefined }
}))
// 内存会话的权限表不落库：碰到这里就是分流错了
vi.mock('../../dao/sessionAclDao', () => {
  const never = (): never => {
    throw new Error('askPolicy.test: in-memory sessions must not reach session_acl')
  }
  return {
    sessionAclDao: {
      findBySession: never,
      insert: never,
      updateAccess: never,
      deleteById: never,
      deleteBySession: never,
      transaction: never
    }
  }
})
vi.mock('../../utils/sessionConfigBroadcast', () => ({ broadcastSessionConfigChanged: () => {} }))
vi.mock('../sessionService', () => ({
  sessionService: { getById: () => undefined }
}))
vi.mock('../skillService', () => ({
  skillService: {
    listExternalDirs: () => state.externalDirs,
    listSharedDirs: () => [],
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
    // 内置安全策略的停用开关（ShuviX 扩展元数据）：按 state.disabled 答（缺省都不停用，见 PERM-D）
    isDisabled: (policy: { objectId?: string }) =>
      !!policy.objectId && state.disabled.has(policy.objectId),
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
  getSharedSkillsDirs: () => ({
    claude: '/nonexistent/shuvix-ask/.claude/skills',
    agents: '/nonexistent/shuvix-ask/.agents/skills'
  }),
  getDefaultBotsDir: () => '/tmp/shuvix-bots',
  getDefaultDailyDir: () => '/tmp/shuvix-daily',
  getDefaultTrackingDir: () => '/tmp/shuvix-tracking',
  // vars.shuvixConfigDirs 的四个目录（退役的 protect-shuvix-config 引用它们）
  getDefaultPoliciesDir: () => POLICIES_DIR,
  getDefaultAgentsDir: () => AGENTS_DIR,
  getDefaultHooksDir: () => HOOKS_DIR,
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-builtin-knowledge',
  // 与生产同形：会话目录里的 artifacts 那一项按 os.homedir() 算，两边得是同一处
  getSessionArtifactsDir: (id: string) => join(homedir(), '.shuvix', 'artifacts', id),
  // 与生产同形：组件源码目录（读写授权派生出它的可写行，WT4-AC-20）
  widgetDirPath: (id: string) => join(homedir(), '.shuvix', 'widgets', id),
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
  type SecurityEffect,
  type SessionObjectInput,
  type WidgetObjectInput
} from '@shuvix/agent-runtime'
import type {
  AskInputRequest,
  InputRequest,
  InputResponse
} from '@shuvix/chat-protocol/types/inputRequest'
import type { PathAccess } from '@shuvix/chat-protocol/sessionAcl'
import { sessionRecords } from '../sessionRecords'
import { sessionAcl, setAclSkillRoots } from '../acl'

// 用户启用的技能目录由主进程注入（acl 不反向依赖 skillService）：与上面 skillService 替身同一份
setAclSkillRoots(() => state.skillRoots)
import { clearMemoryAclForTests } from '../acl/store'

/**
 * 这组用例的会话行：内存会话，工作目录写在 settings 里（权限表的工作目录行由它派生 —— 与工具看到的
 * getConfig() 是同一个目录，生产里两边都从会话行来）。行不在就建；给了 workingDirectory 就改成它
 */
function ensureSession(sessionId: string, workingDirectory?: string): void {
  if (!sessionRecords.pick(sessionId, ['id'])) {
    sessionRecords.insert(
      {
        id: sessionId,
        title: sessionId,
        projectId: null,
        parentId: null,
        settings: { workingDirectory: workingDirectory ?? WORKSPACE },
        createdAt: 1,
        updatedAt: 1,
        lastActiveAt: 1
      },
      { ephemeral: true }
    )
  } else if (workingDirectory !== undefined) {
    sessionRecords.updateSettings(sessionId, { workingDirectory })
  }
}

/** 「允许并记住」：写进这条会话的权限表（来源 user） */
function grant(path: string, access: PathAccess, sessionId = 's1'): void {
  ensureSession(sessionId)
  expect(sessionAcl.grantPath(sessionId, path, access), path).not.toBeNull()
}

/** 撤掉这条会话授予的全部路径（权限表里的 user 行） */
function revokeGrants(sessionId = 's1'): void {
  for (const e of sessionAcl.entries(sessionId)) {
    if (e.source === 'user') sessionAcl.remove(sessionId, e.id)
  }
}

const config: ProjectConfig = { workingDirectory: WORKSPACE }
const context = (sessionId = 's1'): SecurityContext => {
  ensureSession(sessionId, WORKSPACE)
  return getDesktopSecurityContext({ sessionId }, () => config)
}
/** 工作目录不是 WORKSPACE 的会话（PERM-W2 换工作区） */
const contextAt = (workingDirectory: string, sessionId = 's1'): SecurityContext => {
  ensureSession(sessionId, workingDirectory)
  return getDesktopSecurityContext({ sessionId }, () => ({ workingDirectory }))
}
/** 这一刻的桌面变量表（前提断言用：权限表里是哪一组） */
const varsAt = (workingDirectory: string, sessionId = 's1'): Record<string, unknown> => {
  ensureSession(sessionId, workingDirectory)
  return makeDesktopSecurityProvider({ sessionId }, () => ({
    workingDirectory
  })).getVars() as Record<string, unknown>
}

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
  // 会话行与权限表都是进程级的内存表：每条用例从空表开始
  sessionRecords.clearEphemeralForTests()
  clearMemoryAclForTests()
  sessionAcl.forgetReconciled()
  state.externalDirs = []
  state.skillRoots = []
  state.knowledgeTargets = []
  state.knowledgeBroken = false
  state.userPolicies = []
  state.disabled = new Set()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', REAL_PLATFORM)
  setPermissionReviewer(null)
})

describe('桌面安全 provider — 出厂的外部目录访问策略（ask-on-external-path）', () => {
  it('PERM-0 前提：权限表的可写目录 = 解析过的工作区、会话 TMPDIR、~/.shuvix/artifacts/s1、tool_results/s1；可读目录另有随包的内置技能目录（只读）', () => {
    const vars = varsAt(WORKSPACE)
    const writable = [
      realOf(WORKSPACE),
      expect.stringMatching(/^\/private\/tmp\/shuvix-\d+\/[0-9a-f]{8}$/),
      join(realOf(homedir()), '.shuvix', 'artifacts', 's1'),
      join(realOf(TOOL_RESULTS), 's1')
    ]
    expect(vars.aclWrite).toEqual(writable)
    // 写隐含读：可写的也在可读表里
    expect(vars.aclRead).toEqual([...writable, realOf(BUILTIN_SKILLS)])
    // 家目录是事实变量：读规则看它
    expect(vars.home).toBe(homedir())
  })

  it('PERM-1: 工作区在权限表里（可写）—— 区内与工作目录本身读写都不问', () => {
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

describe('桌面安全 provider — 会话授权语义（「允许并记住」写进权限表，ask-on-external-path 在表外才问）', () => {
  const target = join(HOME_PLACE, 'a.txt')

  it('PERM-4: 写授权同时满足 write 与 read', () => {
    expect(effectOf(context(), 'write', target)).toBe('ask')
    expect(effectOf(context(), 'read', target)).toBe('ask')
    grant(target, 'write')
    expect(effectOf(context(), 'write', target)).toBe('allow')
    expect(effectOf(context(), 'read', target)).toBe('allow')
  })

  it('PERM-4: 只有读授权时 write 不命中（读权限不隐含写权限）', () => {
    grant(target, 'read')
    expect(effectOf(context(), 'read', target)).toBe('allow')
    expect(verdict(context().evaluate('write', { type: 'path', path: target }))).toEqual(ASK_WRITE)
  })

  it('PERM-4: 目录授权按路径段前缀命中；授权撤掉后恒不命中', () => {
    grant(join(HOME_PLACE, 'sub'), 'write')
    expect(effectOf(context(), 'write', join(HOME_PLACE, 'sub', 'deep', 'b.txt'))).toBe('allow')
    expect(effectOf(context(), 'read', join(HOME_PLACE, 'sub', 'deep', 'b.txt'))).toBe('allow')
    expect(effectOf(context(), 'write', join(HOME_PLACE, 'subsidiary.txt'))).toBe('ask')

    revokeGrants()
    expect(effectOf(context(), 'write', join(HOME_PLACE, 'sub', 'deep', 'b.txt'))).toBe('ask')
    expect(effectOf(context(), 'write', target)).toBe('ask')
  })

  it('PERM-4: 授权只属于它那条会话 —— s1 的写授权不放行 s2', () => {
    grant(target, 'write', 's1')
    expect(effectOf(context('s1'), 'write', target)).toBe('allow')
    expect(verdict(context('s2').evaluate('write', { type: 'path', path: target }))).toEqual(
      ASK_WRITE
    )
  })

  it('PERM-4: 卡片上「允许并记住」→ 本会话权限表多一条 user 行（读写各一），同一个 context 再来不问', async () => {
    ensureSession('s1')
    const requestUserInput = vi.fn(async () => ({
      kind: 'ask' as const,
      allowed: true,
      extra: { rememberPath: true }
    }))
    const ctx = getDesktopSecurityContext({ sessionId: 's1', requestUserInput }, () => config)
    const outside = join(OUTSIDE, 'remember.txt')
    const credential = join(HOME_PLACE, 'remember.txt')
    try {
      await ctx.enforcePath('write', outside, { toolCallId: 'perm4-r1', toolName: 'write' })
      await ctx.enforcePath('read', credential, { toolCallId: 'perm4-r2', toolName: 'read' })
      expect(requestUserInput).toHaveBeenCalledTimes(2)
      const granted = sessionAcl
        .entries('s1')
        .filter((e) => e.source === 'user')
        .map((e) => [realOf(e.target), e.access])
      expect(granted).toEqual([
        [realOf(outside), 'write'],
        [realOf(credential), 'read']
      ])

      await ctx.enforcePath('write', outside, { toolCallId: 'perm4-r3', toolName: 'write' })
      await ctx.enforcePath('read', credential, { toolCallId: 'perm4-r4', toolName: 'read' })
      expect(requestUserInput).toHaveBeenCalledTimes(2)
    } finally {
      clearReviewState('s1')
      clearSessionDecisions('s1')
    }
  })

  it('PERM-4: 询问材料的字面值是 Read(…) / Write(…)（路径是真实去处 —— macOS 的临时目录在 /private/var 下）', () => {
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
    grant(credential, 'read')
    expect(context().evaluateReadOnly('read', { type: 'path', path: credential })).toBe(true)
  })
})

describe('桌面安全 provider — 不缓存权限表快照', () => {
  const target = join(OUTSIDE, 'a.txt')

  it('同一个 context 实例在权限表变化后立即反映新值（会话中途「允许并记住」不该还弹旧快照）', () => {
    // context 在建会话时创建一次、整会话复用；每次判定都必须现读权限表
    const ctx = context()

    expect(verdict(ctx.evaluate('write', { type: 'path', path: target }))).toEqual(ASK_WRITE)

    // 会话中途对具体路径「允许并记住」：外部目录那一问不再命中
    grant(target, 'write')
    const granted = ctx.evaluate('write', { type: 'path', path: target })
    expect(verdict(granted)).toEqual(ALLOW)
    expect(granted.matched).toEqual([])

    // 授权被撤掉后同样立刻失效
    revokeGrants()
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
    'PERM-S1 %s：读问 #0、写问 #1，卡片都给「记住」；写授权之后读写都放行，读授权只放读',
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

      grant(p, 'write')
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual(ALLOW)
      expect(verdict(context().evaluate('read', { type: 'path', path: p }))).toEqual(ALLOW)

      revokeGrants()
      grant(p, 'read')
      expect(verdict(context().evaluate('read', { type: 'path', path: p }))).toEqual(ALLOW)
      expect(verdict(context().evaluate('write', { type: 'path', path: p }))).toEqual(ASK_WRITE)
    }
  )
})

describe('桌面安全 provider — 本会话 artifacts 在权限表里', () => {
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
 * 会话设置带来的权限表行（acl/derive 的 knowledge / skill 行）：本会话勾选的知识库可读写（vars.aclWrite）；
 * 技能目录与只读的内置知识库只读（只在 vars.aclRead 里 —— 读规则免、写规则不免）。勾选变了下一次读表
 * 就跟上（懒对账）。用家目录里的路径，读规则的豁免才看得出来。
 */
describe('桌面安全 provider — 勾选的知识库与技能目录', () => {
  const KB = join(homedir(), '.shuvix', 'knowledge', 'shuvix-policy-kb')
  const KB_UNTICKED = join(homedir(), '.shuvix', 'knowledge', 'shuvix-policy-kb-unticked')
  const KB_READONLY = join(homedir(), 'shuvix-policy-readonly-kb')
  const SKILLS_HOME = join(homedir(), '.shuvix', 'skills')

  it('PERM-K1 勾选的库在权限表里（可写）：读写都不问；没勾的库照常问（读 #0、写 #1）；取消勾选后照问', () => {
    state.knowledgeTargets = [{ name: 'shuvix-policy-kb', target: { dir: KB } }]
    expect(varsAt(WORKSPACE).aclWrite).toContain(realOf(KB))

    const entry = join(KB, 'notes', 'entry.md')
    expect(verdict(context().evaluate('read', { type: 'path', path: entry }))).toEqual(ALLOW)
    expect(verdict(context().evaluate('write', { type: 'path', path: entry }))).toEqual(ALLOW)

    const other = join(KB_UNTICKED, 'entry.md')
    expect(verdict(context().evaluate('read', { type: 'path', path: other }))).toEqual(ASK_READ)
    expect(verdict(context().evaluate('write', { type: 'path', path: other }))).toEqual(ASK_WRITE)

    // 取消勾选：同一条会话下一次评估那一行就没了
    state.knowledgeTargets = []
    expect(varsAt(WORKSPACE).aclRead).not.toContain(realOf(KB))
    expect(verdict(context().evaluate('write', { type: 'path', path: entry }))).toEqual(ASK_WRITE)
  })

  it('PERM-K2 只读的库与启用的技能目录只免读：读不问、写问 #1（技能是 agent 自己要遵守的指令）', () => {
    state.knowledgeTargets = [{ name: 'shuvix', target: { dir: KB_READONLY, readonly: true } }]
    state.skillRoots = [SKILLS_HOME]
    const vars = varsAt(WORKSPACE)
    expect(vars.aclRead).toEqual(expect.arrayContaining([realOf(KB_READONLY), realOf(SKILLS_HOME)]))
    expect(vars.aclWrite).not.toContain(realOf(KB_READONLY))
    expect(vars.aclWrite).not.toContain(realOf(SKILLS_HOME))

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
  '桌面安全 provider — 工作目录与权限表（与沙箱同一张表）',
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
      'PERM-W2 工作目录不适合（%s）→ 权限表里没有工作目录那一行，区内的写照问（#1）',
      (_label, wsOf, targetOf) => {
        const ws = wsOf()
        const dirs = varsAt(ws).aclWrite as string[]
        expect(dirs).not.toContain(realOf(ws))
        expect(sessionAcl.entries('s1').some((e) => e.source === 'workdir')).toBe(false)
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
    ])('PERM-W2b 工作目录在 %s → 在权限表里（可写），区内读写不问', (_label, wsOf) => {
      const ws = wsOf()
      expect(varsAt(ws).aclWrite).toContain(realOf(ws))
      const p = join(ws, 'a.md')
      expect(verdict(contextAt(ws).evaluate('write', { type: 'path', path: p }))).toEqual(ALLOW)
      expect(verdict(contextAt(ws).evaluate('read', { type: 'path', path: p }))).toEqual(ALLOW)
    })

    it('PERM-W3 权限表与平台、沙箱开关无关：Windows 上（没有沙箱后端）工作区照样在表里，区内写不问', () => {
      const p = join(WORKSPACE, 'src', 'a.ts')
      setPlatform('win32')
      expect(varsAt(WORKSPACE).aclWrite).toContain(realOf(WORKSPACE))
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

  it('PERM-C2 装回 protect-shuvix-config：权限表里授予了 <agents 目录> / <那个文件> 的写 —— 照样问：授权让外部目录那一问不再命中，但压不过 force-ask', () => {
    withConfigGuard()
    const p = join(AGENTS_DIR, 'x.md')
    for (const granted of [AGENTS_DIR, p]) {
      revokeGrants()
      grant(granted, 'write')
      const d = context().evaluate('write', { type: 'path', path: p })
      expect({ granted, ...verdict(d) }).toEqual({
        granted,
        effect: 'ask',
        winning: 'protect-shuvix-config#0'
      })
      expect(d.matched, granted).not.toContain('ask-on-external-path#1')
    }
    // 对照：同样形状的授权对普通的区外文件是放行
    const outside = join(OUTSIDE, 'a.txt')
    grant(outside, 'write')
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

describe('桌面安全 provider — 内置安全策略的停用开关（isPolicyDisabled → policyService.isDisabled）', () => {
  const sessions: string[] = []
  afterEach(() => {
    for (const id of sessions) {
      clearSessionDecisions(id)
      clearReviewState(id)
    }
    sessions.length = 0
  })

  /** 一个记录询问的 context（询问一律答允许） */
  const askingContext = (sessionId: string): { ctx: SecurityContext; asks: InputRequest[] } => {
    sessions.push(sessionId)
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
    return { ctx, asks }
  }

  it('PERM-D1 停用 ask-on-external-path → 家目录里的读、会话目录外的写都放行、零命中，enforcePath 不问；重新启用 → #0 / #1 回来', async () => {
    const homeFile = join(HOME_PLACE, 'notes.txt')
    const outside = join(OUTSIDE, 'a.txt')
    state.disabled.add('policy:builtin:ask-on-external-path')

    const read = context().evaluate('read', { type: 'path', path: homeFile })
    expect(verdict(read)).toEqual(ALLOW)
    expect(read.matched).toEqual([])
    const write = context().evaluate('write', { type: 'path', path: outside })
    expect(verdict(write)).toEqual(ALLOW)
    expect(write.matched).toEqual([])

    const { ctx, asks } = askingContext('perm-d1')
    await ctx.enforcePath('read', homeFile, { toolCallId: 'd1-read', toolName: 'read' })
    await ctx.enforcePath('write', outside, { toolCallId: 'd1-write', toolName: 'write' })
    expect(asks).toEqual([])

    state.disabled.clear()
    expect(verdict(context().evaluate('read', { type: 'path', path: homeFile }))).toEqual(ASK_READ)
    expect(verdict(context().evaluate('write', { type: 'path', path: outside }))).toEqual(ASK_WRITE)
  })

  it('PERM-D2 停用 ask-on-command → 沙箱外命令不问；路径门照问（只停掉了那一份）', async () => {
    state.disabled.add('policy:builtin:ask-on-command')
    const { ctx, asks } = askingContext('perm-d2')
    const outcome = await ctx.enforceCommand(
      { channel: 'bash', command: 'echo hi', cwd: WORKSPACE },
      { toolCallId: 'd2-cmd', toolName: 'bash' }
    )
    expect(outcome).toMatchObject({ status: 'allowed' })
    expect(asks).toEqual([])

    await ctx.enforcePath('write', join(OUTSIDE, 'b.txt'), {
      toolCallId: 'd2-write',
      toolName: 'write'
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'ask', id: 'd2-write' })

    // 对照：重新启用后同一条命令要问
    state.disabled.clear()
    await ctx.enforceCommand(
      { channel: 'bash', command: 'echo hi', cwd: WORKSPACE },
      { toolCallId: 'd2-cmd-again', toolName: 'bash' }
    )
    expect(asks).toHaveLength(2)
    expect(asks[1]).toMatchObject({ kind: 'ask', id: 'd2-cmd-again' })
  })
})

/**
 * PERM-RV —— 权限审查员能读的，恰是被审 agent 不问就能读的。审查员（判定型 hook 派出的派生 agent）的
 * 调用拿不到询问通道（toolContext 按注入的判断去掉 onPermissionRequest 与 requestUserInput），于是判出
 * ask 的读取一律按 fail-closed 拒绝；判出 allow 的照常放行。这里用真实的会话权限表（工作区、本会话
 * artifacts、勾选的知识库、只读的技能目录、「允许并记住」）把这条等价钉住：对清单里每一个路径，审查员的
 * enforcePath('read') 放行 ⇔ 同一会话的 evaluate('read') 是 allow。
 */
describe('桌面安全 provider — 权限审查员的读取不问人（只读得到不问就能读的）', () => {
  const REVIEWER = { profileName: 'permission-reviewer', kind: 'spawned' as const }
  const ROOT = { profileName: 'work', kind: 'root' as const }
  const isRev = (agent: { profileName: string; kind: 'root' | 'spawned' }): boolean =>
    agent.kind === 'spawned' && agent.profileName === 'permission-reviewer'
  const KB = join(homedir(), '.shuvix', 'knowledge', 'shuvix-policy-rv-kb')
  const SKILLS_HOME = join(homedir(), '.shuvix', 'skills')
  const ART = join(homedir(), '.shuvix', 'artifacts')
  const HOME_FILE = join(HOME_PLACE, 'rv', 'run.sh')
  const sessions: string[] = []

  const PATHS = [
    join(WORKSPACE, 'scripts', 'build.sh'),
    join(ART, 's1', 'x'),
    join(ART, 's2', 'x'),
    join(BUILTIN_SKILLS, 'drawing', 'SKILL.md'),
    join(SKILLS_HOME, 'demo', 'SKILL.md'),
    join(KB, 'notes', 'entry.md'),
    HOME_FILE,
    join(OUTSIDE, 'run.sh')
  ]
  /** 三种授权状态：没有、HOME_PLACE 的读授权、HOME_PLACE 的写授权（写授权覆盖读） */
  const GRANTS: Array<[string, PathAccess | undefined]> = [
    ['no grant', undefined],
    ['Read grant', 'read'],
    ['Write grant', 'write']
  ]

  beforeEach(() => {
    state.knowledgeTargets = [{ name: 'shuvix-policy-rv-kb', target: { dir: KB } }]
    state.skillRoots = [SKILLS_HOME]
  })

  afterEach(() => {
    for (const id of sessions.splice(0)) {
      clearReviewState(id)
      clearSessionDecisions(id)
    }
  })

  /** 按身份走一遍清单：每个路径 → [evaluate 的 effect, enforcePath 放没放行, 弹没弹卡] */
  async function sweep(
    agent: typeof REVIEWER | typeof ROOT,
    label: string
  ): Promise<Array<{ path: string; effect: SecurityEffect; passed: boolean; carded: boolean }>> {
    const reviewer = vi.fn(async (): Promise<PermissionReviewAnswer | null> => null)
    setPermissionReviewer(reviewer, isRev)
    const requestUserInput = vi.fn(async () => ({ kind: 'ask' as const, allowed: true }))
    sessions.push('s1')
    ensureSession('s1')
    const ctx = getDesktopSecurityContext(
      { sessionId: 's1', agent, requestUserInput },
      () => config
    )
    const rows: Array<{ path: string; effect: SecurityEffect; passed: boolean; carded: boolean }> =
      []
    for (const [i, path] of PATHS.entries()) {
      const effect = effectOf(context('s1'), 'read', path)
      const cards = requestUserInput.mock.calls.length
      const passed = await ctx
        .enforcePath('read', path, { toolCallId: `${label}-${i}`, toolName: 'read' })
        .then(
          () => true,
          (err: Error) => {
            expect(err.message, path).toMatch(/no way to ask/)
            return false
          }
        )
      rows.push({ path, effect, passed, carded: requestUserInput.mock.calls.length > cards })
    }
    if (agent === REVIEWER) expect(reviewer).not.toHaveBeenCalled()
    return rows
  }

  it.each(GRANTS)(
    'PERM-RV1 (%s) 审查员的 enforcePath(read) 放行 ⇔ evaluate(read) 是 allow；拒绝的从不弹卡',
    async (label, access) => {
      if (access) grant(HOME_PLACE, access)
      const rows = await sweep(REVIEWER, `rv1-${label}`)
      for (const row of rows) {
        expect({ path: row.path, passed: row.passed, carded: row.carded }).toEqual({
          path: row.path,
          passed: row.effect === 'allow',
          carded: false
        })
      }
      // 自检：清单两边都有（否则等价是空话）—— 没有授权时家目录那一处与别的会话的 artifacts 要问
      expect(rows.some((row) => row.effect === 'allow')).toBe(true)
      const refused = rows.filter((row) => !row.passed).map((row) => row.path)
      expect(refused).toEqual(access ? [join(ART, 's2', 'x')] : [join(ART, 's2', 'x'), HOME_FILE])
    }
  )

  it.each(GRANTS)(
    'PERM-RV2 (%s) 同一份清单换成根 agent：恰在审查员被拒的地方弹卡，其余照样不问',
    async (label, access) => {
      if (access) grant(HOME_PLACE, access)
      const reviewerRows = await sweep(REVIEWER, `rv2r-${label}`)
      const rootRows = await sweep(ROOT, `rv2-${label}`)
      expect(rootRows.map((row) => row.passed)).toEqual(PATHS.map(() => true))
      expect(rootRows.map((row) => row.carded)).toEqual(reviewerRows.map((row) => !row.passed))
    }
  )
})

/**
 * 会话交互（XS-37…XS-40）—— `session` 工具查看（read）/ 对话（write）一条不是自己子会话的会话，走 enforceSession，
 * 客体 {type: 'session', sessionId, title, ownTurn}。出厂的 ask-on-session-access：不是自己发起的那一轮、又不在本会话
 * 权限表的会话行里（vars.aclSessionRead / aclSessionWrite）时询问。权限表是真的：卡片上「允许并记住」
 * （`extra.remember: true`）经 persistSessionGrant → sessionAcl.grantSession 写一行 `kind: 'session'`（来源 user）。
 * 这里的会话都是内存会话（目标会话也得在 —— grantSession 不给不在的会话写行）。
 *
 *   XS-37 对话 B 答「允许并记住」→ 一张卡（带 session 目标）；s1 的表多一行 {session, B, write, user}；之后对话 / 查看
 *         都不问；s2 → B 照问
 *   XS-38 允许不记住 → 不写行、下次照问；拒绝 → 抛 User denied talking to / reading …、不写行；记住「查看」→
 *         查看免问、对话照问
 *   XS-39 没有询问通道（hook / 后台）→ 抛 no way to ask、不写行；ownTurn（自己发起的那一轮）→ 不问直接过
 *   XS-40 停用 ask-on-session-access → 不问、放行、零命中，路径门照问；用户写一份同名、规则清空的覆盖 → 同样
 */
describe('桌面安全 provider — 会话交互（ask-on-session-access，「允许并记住」写进权限表的会话行）', () => {
  const TARGET = 'sess-b'
  const TITLE = 'Plan the release'
  const sessions: string[] = []

  afterEach(() => {
    for (const id of sessions.splice(0)) {
      clearSessionDecisions(id)
      clearReviewState(id)
    }
  })

  /** 目标会话（内存会话，带标题 —— 卡片与拒绝文案摆它） */
  function ensureTarget(): void {
    ensureSession(TARGET)
    sessionRecords.updateTitle(TARGET, TITLE)
  }
  const target = (over: Partial<SessionObjectInput> = {}): SessionObjectInput => ({
    sessionId: TARGET,
    title: TITLE,
    ownTurn: false,
    ...over
  })
  const opts = (
    toolCallId: string,
    operation = 'prompt-session'
  ): { toolCallId: string; toolName: string; operation: string } => ({
    toolCallId,
    toolName: 'session',
    operation
  })
  /** 一个按 reply() 作答、记下每张卡片的 context */
  function asking(
    sessionId: string,
    reply: () => InputResponse
  ): { ctx: SecurityContext; asks: AskInputRequest[] } {
    ensureSession(sessionId)
    ensureTarget()
    sessions.push(sessionId)
    const asks: AskInputRequest[] = []
    const ctx = getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req as AskInputRequest)
          return reply()
        }
      },
      () => config
    )
    return { ctx, asks }
  }
  /** 这条会话权限表里的会话行（去掉 id 与时间） */
  const sessionRows = (
    sessionId: string
  ): Array<{ kind: string; target: string; access: string; source: string; sourceKey: string }> =>
    sessionAcl
      .entries(sessionId)
      .filter((e) => e.kind === 'session')
      .map(({ kind, target, access, source, sourceKey }) => ({
        kind,
        target,
        access,
        source,
        sourceKey
      }))
  const REMEMBER: InputResponse = { kind: 'ask', allowed: true, extra: { remember: true } }
  const ALLOW_ONCE: InputResponse = { kind: 'ask', allowed: true }

  it('XS-37 对话 B 答「允许并记住」→ 一张卡（带 session 目标）；s1 的表多一行 {session, B, write, user}；之后对话 / 查看都不问；s2 → B 照问', async () => {
    const { ctx, asks } = asking('s1', () => REMEMBER)
    await ctx.enforceSession('write', target(), opts('xs37-1'))
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      kind: 'ask',
      id: 'xs37-1',
      toolName: 'session',
      command: `Session(write, ${TARGET})`,
      session: { sessionId: TARGET, title: TITLE, access: 'write', operation: 'prompt-session' }
    })
    expect(asks[0].policyPrompt?.text).toContain('sends a message into another session')
    expect(sessionRows('s1')).toEqual([
      { kind: 'session', target: TARGET, access: 'write', source: 'user', sourceKey: '' }
    ])
    // 策略看得见的就是这一行（对话隐含查看）
    const vars = varsAt(WORKSPACE, 's1')
    expect(vars.aclSessionRead).toEqual([TARGET])
    expect(vars.aclSessionWrite).toEqual([TARGET])

    // 同一个 context 再对话、再查看：都不问，表不再长
    await ctx.enforceSession('write', target(), opts('xs37-2', 'steer-session'))
    await ctx.enforceSession('read', target(), opts('xs37-3', 'read-session'))
    await ctx.enforceSession('read', target(), opts('xs37-4', 'inspect-session'))
    expect(asks).toHaveLength(1)
    expect(sessionRows('s1')).toHaveLength(1)

    // 授权只属于 s1：s2 查看 B 照问
    const other = asking('s2', () => ALLOW_ONCE)
    await other.ctx.enforceSession('read', target(), opts('xs37-5', 'read-session'))
    expect(other.asks).toHaveLength(1)
    expect(other.asks[0]).toMatchObject({
      command: `Session(read, ${TARGET})`,
      session: { sessionId: TARGET, title: TITLE, access: 'read', operation: 'read-session' }
    })
    expect(other.asks[0].policyPrompt?.text).toContain("brings another session's conversation")
    expect(sessionRows('s2')).toEqual([])
  })

  it('XS-38 允许但不记住 → 不写行、下次照问（remember 只认 true）；拒绝 → 抛 User denied talking to / reading …、不写行', async () => {
    let reply: InputResponse = ALLOW_ONCE
    const { ctx, asks } = asking('s1', () => reply)

    await ctx.enforceSession('write', target(), opts('xs38-1'))
    expect(sessionRows('s1')).toEqual([])
    await ctx.enforceSession('write', target(), opts('xs38-2'))
    expect(asks).toHaveLength(2)
    // 「允许并记住」的标记只认 true：别的真值不记
    reply = { kind: 'ask', allowed: true, extra: { remember: 'yes' } }
    await ctx.enforceSession('write', target(), opts('xs38-3'))
    expect(asks).toHaveLength(3)
    expect(sessionRows('s1')).toEqual([])

    // 拒绝（哪怕带着 remember）：抛给模型的文案点名那条会话，不写行
    reply = { kind: 'ask', allowed: false, extra: { remember: true } }
    await expect(ctx.enforceSession('write', target(), opts('xs38-4'))).rejects.toMatchObject({
      message: `User denied talking to session "${TITLE}" (${TARGET})`
    })
    await expect(
      ctx.enforceSession('read', target(), opts('xs38-5', 'read-session'))
    ).rejects.toMatchObject({ message: `User denied reading session "${TITLE}" (${TARGET})` })
    expect(asks).toHaveLength(5)
    expect(sessionRows('s1')).toEqual([])
  })

  it('XS-38 记住「查看」→ 查看免问、对话照问；再记住「对话」→ 同一行放宽成对话', async () => {
    const { ctx, asks } = asking('s1', () => REMEMBER)
    await ctx.enforceSession('read', target(), opts('xs38-r1', 'read-session'))
    expect(asks).toHaveLength(1)
    expect(sessionRows('s1')).toEqual([
      { kind: 'session', target: TARGET, access: 'read', source: 'user', sourceKey: '' }
    ])
    const readRow = sessionAcl.entries('s1').find((e) => e.kind === 'session')!

    await ctx.enforceSession('read', target(), opts('xs38-r2', 'wait-for-sessions'))
    expect(asks).toHaveLength(1)
    expect(verdict(ctx.evaluate('write', { type: 'session', ...target() }))).toEqual({
      effect: 'ask',
      winning: 'ask-on-session-access#1'
    })

    await ctx.enforceSession('write', target(), opts('xs38-r3'))
    expect(asks).toHaveLength(2)
    expect(asks[1].session).toMatchObject({ access: 'write' })
    const rows = sessionAcl.entries('s1').filter((e) => e.kind === 'session')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: readRow.id, access: 'write' })
  })

  it('XS-39 没有询问通道（hook / 后台）→ 抛 no way to ask、不写行；ownTurn（自己发起的那一轮）→ 不问直接过', async () => {
    ensureSession('s1')
    ensureTarget()
    sessions.push('s1')
    const silent = getDesktopSecurityContext({ sessionId: 's1' }, () => config)
    const noWay = `Access denied: this needs your confirmation but there is no way to ask: session "${TITLE}" (${TARGET})`
    await expect(silent.enforceSession('write', target(), opts('xs39-1'))).rejects.toMatchObject({
      message: noWay
    })
    await expect(
      silent.enforceSession('read', target(), opts('xs39-2', 'read-session'))
    ).rejects.toMatchObject({ message: noWay })
    expect(sessionRows('s1')).toEqual([])

    // 自己发起的那一轮：没有通道也过；有通道也不弹卡（答什么都无所谓）
    await expect(
      silent.enforceSession('write', target({ ownTurn: true }), opts('xs39-3', 'answer-session'))
    ).resolves.toBeUndefined()
    const { ctx, asks } = asking('s1', () => ({ kind: 'ask', allowed: false }))
    await expect(
      ctx.enforceSession('write', target({ ownTurn: true }), opts('xs39-4', 'steer-session'))
    ).resolves.toBeUndefined()
    await expect(
      ctx.enforceSession('read', target({ ownTurn: true }), opts('xs39-5', 'read-session'))
    ).resolves.toBeUndefined()
    expect(asks).toEqual([])
    expect(sessionRows('s1')).toEqual([])
  })

  /** 用户在 ~/.shuvix/policies 里写的同名覆盖：规则清空（= 把这道门拿掉） */
  const CLEARED: UserPolicyFile = {
    name: 'ask-on-session-access',
    displayName: 'ask-on-session-access',
    description: '',
    rules: [],
    body: '',
    fileName: 'ask-on-session-access.md'
  }

  it.each<[string, () => void]>([
    [
      '停用开关（isPolicyDisabled）',
      () => state.disabled.add('policy:builtin:ask-on-session-access')
    ],
    ['同名覆盖、规则清空', () => (state.userPolicies = [CLEARED])]
  ])('XS-40 %s → 会话交互不问、放行、零命中；路径门照问', async (_label, switchOff) => {
    switchOff()
    const { ctx, asks } = asking('s1', () => ALLOW_ONCE)
    for (const mode of ['read', 'write'] as const) {
      const decision = ctx.evaluate(mode, { type: 'session', ...target() })
      expect({ mode, ...verdict(decision) }).toEqual({
        mode,
        effect: 'allow',
        winning: 'default:session'
      })
      expect(decision.matched, mode).toEqual([])
    }
    await ctx.enforceSession('write', target(), opts('xs40-1'))
    await ctx.enforceSession('read', target(), opts('xs40-2', 'read-session'))
    expect(asks).toEqual([])
    expect(sessionRows('s1')).toEqual([])

    // 只拿掉了那一道门：会话目录外的写照问
    await ctx.enforcePath('write', join(OUTSIDE, 'xs40.txt'), {
      toolCallId: 'xs40-3',
      toolName: 'write'
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'ask', id: 'xs40-3', toolName: 'write' })
    expect(asks[0]).not.toHaveProperty('session')
  })
})

/**
 * 组件使用（WT4-AC-18…22）—— `widget` 工具调组件的读 / 写操作、改组件，走 enforceWidget，客体
 * {type: 'widget', widgetId, name, operation}。出厂的 ask-on-widget-access：不在本会话权限表的组件行里
 * （vars.aclWidgetRead / aclWidgetWrite）时询问。权限表是真的：卡片上「允许并记住」（`extra.remember: true`，
 * 读卡还可以带 `rememberAccess: 'write'` 一次记成读写）经 persistWidgetGrant → sessionAcl.grantWidget 写一行
 * `kind: 'widget'`（来源 user）。读写行派生出组件源码目录 ~/.shuvix/widgets/<id> 的可写行（D14：改组件的代码与写
 * 它的数据同一道授权）。
 *
 *   WT4-AC-18 s1 写 X 答「允许并记住」→ 一张卡（Widget(write, X)、widget 素材、写规则的说明）；表多一行
 *             {widget, X, write, user, ''}；vars 两张表都有 X；之后读写都不问；s2 读 X 照问、不写行
 *   WT4-AC-19 允许一次 → 不写行、下次照问；拒绝 → User denied changing data in widget "N" (X)、不写行；记住读 →
 *             读免问、写照问（#1）；读卡记成读写 → 一行读写；没有询问通道 → no way to ask、不写行
 *   WT4-AC-20 源码目录跟着读写授权：读写行 → 目录里读写都不问；只有读行 → 目录里的写问（ask-on-external-path#1）；
 *             删掉行 → 又问；别的组件的目录一直问
 *   WT4-AC-21 停用 ask-on-widget-access / 同名覆盖规则清空 → 组件读写放行（default:widget、零命中、不弹卡）；路径门照问
 *   WT4-AC-22 judgeGate（预览页面的判定，main/index.ts 注入的那个）：从不弹卡；没有行 → {allowed:false,
 *             downgraded:true}；读行 → 读放行、写不；读写行 → 都放行
 */
describe('桌面安全 provider — 组件使用（ask-on-widget-access，「允许并记住」写进权限表的组件行）', () => {
  const WIDGET_ID = 'reading-list'
  const NAME = 'Reading list'
  const sessions: string[] = []

  afterEach(() => {
    for (const id of sessions.splice(0)) {
      clearSessionDecisions(id)
      clearReviewState(id)
    }
  })

  const widget = (over: Partial<WidgetObjectInput> = {}): WidgetObjectInput => ({
    widgetId: WIDGET_ID,
    name: NAME,
    operation: 'addBook',
    ...over
  })
  const opts = (
    toolCallId: string,
    operation = 'call'
  ): { toolCallId: string; toolName: string; operation: string } => ({
    toolCallId,
    toolName: 'widget',
    operation
  })
  /** 一个按 reply() 作答、记下每张卡片的 context */
  function asking(
    sessionId: string,
    reply: () => InputResponse
  ): { ctx: SecurityContext; asks: AskInputRequest[] } {
    ensureSession(sessionId)
    sessions.push(sessionId)
    const asks: AskInputRequest[] = []
    const ctx = getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req as AskInputRequest)
          return reply()
        }
      },
      () => config
    )
    return { ctx, asks }
  }
  /** 这条会话权限表里的组件行（去掉 id 与时间） */
  const widgetRows = (
    sessionId: string
  ): Array<{ kind: string; target: string; access: string; source: string; sourceKey: string }> =>
    sessionAcl
      .entries(sessionId)
      .filter((e) => e.kind === 'widget')
      .map(({ kind, target, access, source, sourceKey }) => ({
        kind,
        target,
        access,
        source,
        sourceKey
      }))
  const REMEMBER: InputResponse = { kind: 'ask', allowed: true, extra: { remember: true } }
  const ALLOW_ONCE: InputResponse = { kind: 'ask', allowed: true }

  it('WT4-AC-18 写 X 答「允许并记住」→ 一张卡；s1 的表多一行 {widget, X, write, user}；之后读写都不问；s2 读 X 照问', async () => {
    const { ctx, asks } = asking('s1', () => REMEMBER)
    await ctx.enforceWidget('write', widget(), opts('wt4-18-1'))
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      kind: 'ask',
      id: 'wt4-18-1',
      toolName: 'widget',
      command: `Widget(write, ${WIDGET_ID})`,
      widget: { widgetId: WIDGET_ID, name: NAME, access: 'write', operation: 'addBook' }
    })
    expect(asks[0]).not.toHaveProperty('session')
    expect(asks[0].policyPrompt?.text).toContain(
      'This lets the agent change the records in this widget'
    )
    expect(widgetRows('s1')).toEqual([
      { kind: 'widget', target: WIDGET_ID, access: 'write', source: 'user', sourceKey: '' }
    ])
    const vars = varsAt(WORKSPACE, 's1')
    expect(vars.aclWidgetRead).toEqual([WIDGET_ID])
    expect(vars.aclWidgetWrite).toEqual([WIDGET_ID])

    // 同一个 context 再写、再读：都不问，表不再长
    await ctx.enforceWidget('write', widget(), opts('wt4-18-2', 'build'))
    await ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-18-3'))
    await ctx.enforceWidget('read', widget({ operation: 'preview' }), opts('wt4-18-4', 'preview'))
    expect(asks).toHaveLength(1)
    expect(widgetRows('s1')).toHaveLength(1)

    // 授权只属于 s1：s2 读 X 照问
    const other = asking('s2', () => ALLOW_ONCE)
    await other.ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-18-5'))
    expect(other.asks).toHaveLength(1)
    expect(other.asks[0]).toMatchObject({
      command: `Widget(read, ${WIDGET_ID})`,
      widget: { widgetId: WIDGET_ID, name: NAME, access: 'read', operation: 'listBooks' }
    })
    expect(other.asks[0].policyPrompt?.text).toContain('This lets the agent read the records')
    expect(widgetRows('s2')).toEqual([])
  })

  it('WT4-AC-19 允许一次 → 不写行、下次照问；拒绝 → User denied changing data in …、不写行', async () => {
    let reply: InputResponse = ALLOW_ONCE
    const { ctx, asks } = asking('s1', () => reply)

    await ctx.enforceWidget('write', widget(), opts('wt4-19-1'))
    expect(widgetRows('s1')).toEqual([])
    await ctx.enforceWidget('write', widget(), opts('wt4-19-2'))
    expect(asks).toHaveLength(2)

    // 拒绝（哪怕带着 remember）：抛给模型的文案点名那个组件，不写行
    reply = { kind: 'ask', allowed: false, extra: { remember: true } }
    await expect(ctx.enforceWidget('write', widget(), opts('wt4-19-3'))).rejects.toMatchObject({
      message: `User denied changing data in widget "${NAME}" (${WIDGET_ID})`
    })
    await expect(
      ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-19-4'))
    ).rejects.toMatchObject({ message: `User denied reading widget "${NAME}" (${WIDGET_ID})` })
    expect(asks).toHaveLength(4)
    expect(widgetRows('s1')).toEqual([])
  })

  it('WT4-AC-19 记住读 → 读免问、写照问（#1）；读卡带 rememberAccess: write → 一行读写', async () => {
    const { ctx, asks } = asking('s1', () => REMEMBER)
    await ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-19-r1'))
    expect(asks).toHaveLength(1)
    expect(widgetRows('s1')).toEqual([
      { kind: 'widget', target: WIDGET_ID, access: 'read', source: 'user', sourceKey: '' }
    ])
    await ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-19-r2'))
    expect(asks).toHaveLength(1)
    expect(verdict(ctx.evaluate('write', { type: 'widget', ...widget() }))).toEqual({
      effect: 'ask',
      winning: 'ask-on-widget-access#1'
    })

    // 另一条会话：读卡上一次记成读写
    const wide = asking('s3', () => ({
      kind: 'ask',
      allowed: true,
      extra: { remember: true, rememberAccess: 'write' }
    }))
    await wide.ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-19-r3'))
    expect(wide.asks).toHaveLength(1)
    expect(widgetRows('s3')).toEqual([
      { kind: 'widget', target: WIDGET_ID, access: 'write', source: 'user', sourceKey: '' }
    ])
    await wide.ctx.enforceWidget('write', widget(), opts('wt4-19-r4'))
    expect(wide.asks).toHaveLength(1)
  })

  it('WT4-AC-19 没有询问通道（hook / 后台）→ 抛 no way to ask、不写行', async () => {
    ensureSession('s1')
    sessions.push('s1')
    const silent = getDesktopSecurityContext({ sessionId: 's1' }, () => config)
    const noWay = `Access denied: this needs your confirmation but there is no way to ask: widget "${NAME}" (${WIDGET_ID})`
    await expect(silent.enforceWidget('write', widget(), opts('wt4-19-n1'))).rejects.toMatchObject({
      message: noWay
    })
    await expect(
      silent.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-19-n2'))
    ).rejects.toMatchObject({ message: noWay })
    expect(widgetRows('s1')).toEqual([])
  })

  it('WT4-AC-20 源码目录跟着读写授权：读写行 → 目录里读写不问；只有读行 → 写问；删掉 → 又问；别的组件的目录一直问', async () => {
    const dir = join(homedir(), '.shuvix', 'widgets', WIDGET_ID)
    const file = join(dir, 'src', 'App.tsx')
    const otherFile = join(homedir(), '.shuvix', 'widgets', 'expense-log', 'src', 'App.tsx')
    // 前提：没有授权时目录里的读写都问（家目录里、权限表外）
    expect(verdict(context().evaluate('read', { type: 'path', path: file }))).toEqual(ASK_READ)
    expect(verdict(context().evaluate('write', { type: 'path', path: file }))).toEqual(ASK_WRITE)

    const row = sessionAcl.grantWidget('s1', WIDGET_ID, 'write')!
    expect(verdict(context().evaluate('write', { type: 'path', path: file }))).toEqual(ALLOW)
    expect(verdict(context().evaluate('read', { type: 'path', path: file }))).toEqual(ALLOW)
    // 真的过一次写门：没有询问通道也直接过
    await expect(
      context().enforcePath('write', file, { toolCallId: 'wt4-20-1', toolName: 'write' })
    ).resolves.toBeUndefined()
    expect(verdict(context().evaluate('write', { type: 'path', path: otherFile }))).toEqual(
      ASK_WRITE
    )

    // 降成只读：目录的写又问（只读授权不派生目录行）
    expect(sessionAcl.setAccess('s1', row.id, 'read')).toBe(true)
    expect(verdict(context().evaluate('write', { type: 'path', path: file }))).toEqual(ASK_WRITE)

    // 再放宽、然后删掉那一行：先不问、再问
    expect(sessionAcl.setAccess('s1', row.id, 'write')).toBe(true)
    expect(verdict(context().evaluate('write', { type: 'path', path: file }))).toEqual(ALLOW)
    expect(sessionAcl.remove('s1', row.id)).toBe(true)
    expect(verdict(context().evaluate('write', { type: 'path', path: file }))).toEqual(ASK_WRITE)
    expect(verdict(context().evaluate('read', { type: 'path', path: file }))).toEqual(ASK_READ)
    expect(verdict(context().evaluate('write', { type: 'path', path: otherFile }))).toEqual(
      ASK_WRITE
    )
  })

  /** 用户在 ~/.shuvix/policies 里写的同名覆盖：规则清空（= 把这道门拿掉） */
  const CLEARED: UserPolicyFile = {
    name: 'ask-on-widget-access',
    displayName: 'ask-on-widget-access',
    description: '',
    rules: [],
    body: '',
    fileName: 'ask-on-widget-access.md'
  }

  it.each<[string, () => void]>([
    [
      '停用开关（isPolicyDisabled）',
      () => state.disabled.add('policy:builtin:ask-on-widget-access')
    ],
    ['同名覆盖、规则清空', () => (state.userPolicies = [CLEARED])]
  ])('WT4-AC-21 %s → 组件读写不问、放行、零命中；路径门照问', async (_label, switchOff) => {
    switchOff()
    const { ctx, asks } = asking('s1', () => ALLOW_ONCE)
    for (const mode of ['read', 'write'] as const) {
      const decision = ctx.evaluate(mode, { type: 'widget', ...widget() })
      expect({ mode, ...verdict(decision) }).toEqual({
        mode,
        effect: 'allow',
        winning: 'default:widget'
      })
      expect(decision.matched, mode).toEqual([])
    }
    await ctx.enforceWidget('write', widget(), opts('wt4-21-1'))
    await ctx.enforceWidget('read', widget({ operation: 'listBooks' }), opts('wt4-21-2'))
    expect(asks).toEqual([])
    expect(widgetRows('s1')).toEqual([])

    // 只拿掉了那一道门：会话目录外的写照问
    await ctx.enforcePath('write', join(OUTSIDE, 'wt4-21.txt'), {
      toolCallId: 'wt4-21-3',
      toolName: 'write'
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ kind: 'ask', id: 'wt4-21-3', toolName: 'write' })
    expect(asks[0]).not.toHaveProperty('widget')
  })

  it('WT4-AC-22 judgeGate（预览页面的判定）：从不弹卡；没有行 → 降级为不放行；读行只放读；读写行都放', () => {
    const { ctx, asks } = asking('s1', () => ALLOW_ONCE)
    const gate = (
      action: 'read' | 'write'
    ): { allowed: boolean; downgraded: boolean; winning: string } => {
      const v = ctx.judgeGate(action, {
        type: 'widget',
        widgetId: WIDGET_ID,
        name: '',
        operation: 'db/items'
      })
      return { allowed: v.allowed, downgraded: v.downgraded, winning: v.decision.winning }
    }

    expect(gate('read')).toEqual({
      allowed: false,
      downgraded: true,
      winning: 'ask-on-widget-access#0'
    })
    expect(gate('write')).toEqual({
      allowed: false,
      downgraded: true,
      winning: 'ask-on-widget-access#1'
    })

    const row = sessionAcl.grantWidget('s1', WIDGET_ID, 'read')!
    expect(gate('read')).toEqual({ allowed: true, downgraded: false, winning: 'default:widget' })
    expect(gate('write')).toMatchObject({ allowed: false, downgraded: true })

    sessionAcl.setAccess('s1', row.id, 'write')
    expect(gate('read').allowed).toBe(true)
    expect(gate('write').allowed).toBe(true)

    expect(asks).toEqual([])
    expect(widgetRows('s1')).toHaveLength(1)
  })
})
