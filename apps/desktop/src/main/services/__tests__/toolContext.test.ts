/**
 * toolContext —— agentActorOf：本工具实例所属 agent 的 OKF actor 字符串
 * （`shuvix-<profile>/<model>`）。模型惰性取（会话中途换模型也跟得上）；元数据缺失时回落
 * `shuvix-agent/unknown` —— 章要盖，但不能编。dao / 服务 / paths 全部 mock（同 askPolicy.test）。
 *
 * resolveProjectConfig —— 工具每次执行时读的工作目录。口径只有一处（sessionService.getById 的
 * 「项目根 → 无项目会话自带的目录 → 临时工作区」），这里只能照抄它、不能另算：
 *   TC-WD1 项目会话 → getById 给的（即项目根，哪怕 settings 里另有一个目录），envVars 取项目的
 *   TC-WD2 无项目、自带目录 → 那个目录，不去问临时工作区
 *   TC-WD3 无项目、没有自带目录 → getById 给的临时工作区
 *   TC-WD4 会话不存在 → 临时工作区（按 sessionId 取）
 *
 * 命令沙箱的宿主胶水（HG-1）：
 *   getSessionPathGrants —— 会话 allowList 的 Write(...) / Read(...) 拆成写 / 读授权根，
 *     历史遗留的 Bash(...) 与写坏的条目不授予任何东西；
 *   getVars 展开 sandbox.sessionView(ctx.sessionId, <工具看到的同一个工作区>) 的六个键 ——
 *     文件工具的免询问范围与命令实际能碰的范围同源。sandbox 模块以「透传真实实现的 spy」替身：
 *     默认走真实 sessionView（未固定 → INACTIVE_VIEW），单条用例可以换成假值。
 *
 * 询问点的自动审查带来的桌面接线（设计稿 docs/permission-review-design.md）：
 *   SEC-9 shuvixConfigDirs —— protect-shuvix-config 守的 policies / agents / hooks / skills 四个目录；
 *   HG-3 getVars 另展开 sandbox.workspaceWriteView 的三个 workspace* 键（ask-on-write 与沙箱脱钩的
 *     工作区豁免）—— 与沙箱那一面同一对参数、每次现取；本文件不 mock electron，真实模块取不到
 *     app.getPath，于是三个键恒为空数组（HG-3b 钉住这条出错路径不抛、不漏键）；
 *   HG-4 sessionCredentialPaths —— 命令沙箱的凭据清单：生效的 protect-credentials 的 `credentialDirs`，
 *     用宿主的非沙箱变量求值、只留绝对路径、每次现读，求值时不碰沙箱视图；
 *   TC-SUBJ 桌面 subject 带上 ctx.agent 的档案名与 root / spawned（审查员的防递归与用户策略都读它）；
 *   TC-RV onPermissionRequest 每次现取注入的审查者（setPermissionReviewer），被动判定从不走到它。
 * 需要真实评估的用例读仓库里那份内置策略 md（同 askPolicy.test）；用户策略由 tc.userPolicies 喂。
 * reviewState / 决策日志是进程级表：这些用例各用独立 sessionId，afterEach 清掉。
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const tc = vi.hoisted(() => ({
  getById: vi.fn((_id: string): unknown => undefined),
  projectPick: vi.fn((_id: string, _cols: string[]): unknown => undefined),
  pickSettings: vi.fn((_id: string, _keys: string[]): unknown => undefined),
  getTempWorkspace: vi.fn((_sid: string) => '/tmp/shuvix-actor-ws'),
  getSessionArtifactsDir: vi.fn((id: string) => `/tmp/shuvix-artifacts/${id}`),
  /** toolContext 的 'Security' 日志（HG-4 看 let 求值失败的那一行） */
  securityLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  /** policyService.getUserPolicies 交出的用户策略（TC-SUBJ2 / TC-RV3 换） */
  userPolicies: [] as UserPolicyFile[],
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: tc.projectPick } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: tc.pickSettings } }))
// 真实模块 + sessionView / workspaceWriteView 换成透传 spy：不改行为，只多一个观测点（与可按用例替换的返回值）
vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  return {
    ...actual,
    sessionView: vi.fn(actual.sessionView),
    workspaceWriteView: vi.fn(actual.workspaceWriteView)
  }
})
vi.mock('../sessionService', () => ({
  sessionService: { getById: tc.getById, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({ skillService: { listExternalDirs: () => [] } }))
vi.mock('../policyService', () => ({
  policyService: {
    getUserPolicies: () => tc.userPolicies,
    // 与 policyService.readBuiltinPolicyMd 同形，只是基准目录直接钉在仓库那份上
    readBuiltinPolicyMd: (fileName: string) => {
      try {
        return readFileSync(join(tc.builtinDir, fileName), 'utf-8')
      } catch {
        return null
      }
    }
  }
}))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: tc.getTempWorkspace,
  getToolResultsBase: () => '/tmp/shuvix-actor-tool-results',
  getDefaultSkillsDir: () => '/tmp/shuvix-actor-skills',
  getBuiltinSkillsDir: () => '/tmp/shuvix-actor-builtin-skills',
  getMemoryRootDir: () => '/tmp/shuvix-actor-memory',
  getDefaultBotsDir: () => '/tmp/shuvix-bots',
  // protect-shuvix-config 的四个目录（getVars 的 shuvixConfigDirs）
  getDefaultPoliciesDir: () => '/tmp/shuvix-policies',
  getDefaultAgentsDir: () => '/tmp/shuvix-agents',
  getDefaultHooksDir: () => '/tmp/shuvix-hooks',
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-builtin-knowledge',
  getSessionArtifactsDir: tc.getSessionArtifactsDir,
  // 与 utils/paths 的真实判定逐字相同（含单独的 '.'）—— SEC-8 判的就是它挡不挡得住
  isSafeSessionId: (id: string) =>
    !!id && !/[/\\]/.test(id) && id !== '.' && id !== '..' && !id.includes('..'),
  getShuvixKnowledgeRootDir: () => '/tmp/shuvix-knowledge-shuvix'
}))
vi.mock('../../logger', () => ({
  createLogger: (name?: string) =>
    name === 'Security' ? tc.securityLog : { info: () => {}, warn: () => {}, error: () => {} }
}))

import {
  agentActorOf,
  getDesktopSecurityContext,
  getSessionPathGrants,
  isPathReadAllowed,
  isPathWriteAllowed,
  makeDesktopSecurityProvider,
  resolveProjectConfig,
  sessionCredentialPaths,
  setPermissionReviewer,
  type ProjectConfig,
  type ToolContext
} from '../toolContext'
import { sessionView, workspaceWriteView } from '../sandbox'
import {
  clearReviewState,
  clearSessionDecisions,
  parsePolicyDefinitionFile,
  type PermissionRequestEvent,
  type PermissionReviewAnswer,
  type SecurityDecision,
  type SecuritySubject,
  type UserPolicyFile
} from '@shuvix/agent-runtime'
import type { AskInputRequest, InputRequest } from '@shuvix/chat-protocol/types/inputRequest'

describe('agentActorOf', () => {
  it('TC-1 `shuvix-<profile>/<model>`：模型惰性取；缺元数据回落 shuvix-agent/unknown；取模型抛错或空白 → unknown；档案名空白归一为 -', () => {
    expect(
      agentActorOf({
        agent: {
          profileName: 'work',
          kind: 'root',
          getModelConfig: () => ({ provider: 'p', model: 'gpt-5', capabilities: {} })
        }
      })
    ).toBe('shuvix-work/gpt-5')
    expect(agentActorOf({})).toBe('shuvix-agent/unknown')
    expect(
      agentActorOf({
        agent: {
          profileName: 'work',
          kind: 'root',
          getModelConfig: () => {
            throw new Error('model gone')
          }
        }
      })
    ).toBe('shuvix-work/unknown')
    expect(agentActorOf({ agent: { profileName: 'work', kind: 'spawned' } })).toBe(
      'shuvix-work/unknown'
    )
    expect(
      agentActorOf({
        agent: {
          profileName: 'my agent',
          kind: 'spawned',
          getModelConfig: () => ({ provider: 'p', model: ' ', capabilities: {} })
        }
      })
    ).toBe('shuvix-my-agent/unknown')
  })

  it('TC-1 惰性：同一个 ctx 在模型切换后给出新的 actor', () => {
    let model = 'm1'
    const ctx = {
      agent: {
        profileName: 'coding',
        kind: 'spawned' as const,
        getModelConfig: () => ({ provider: 'p', model, capabilities: {} })
      }
    }
    expect(agentActorOf(ctx)).toBe('shuvix-coding/m1')
    model = 'm2'
    expect(agentActorOf(ctx)).toBe('shuvix-coding/m2')
  })
})

/**
 * 桌面变量表 —— 内置策略 match 里的 `vars.*` 就是从这里拿值的。
 *
 * 一条指向**未设变量**的策略在 strict 语义下不是「拦不住」而是更糟：match 报错走 fail-safe，
 * force-allow 视为不命中、force-ask 那一族则每次评估刷一条告警 —— 无论哪种，用户都看不出
 * 这道门其实没在工作。所以每加一份引用新变量的内置策略，这张表都得跟着长一项。
 */
describe('makeDesktopSecurityProvider —— 变量表', () => {
  const providerFor = (sessionId: string): ReturnType<typeof makeDesktopSecurityProvider> =>
    makeDesktopSecurityProvider(
      { sessionId, requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' }) as never
    )
  const vars = (sessionId = 's1'): Record<string, string | string[]> =>
    providerFor(sessionId).getVars() as Record<string, string | string[]>

  it('SEC-6 botsDir 由 getDefaultBotsDir() 填 —— protect-bot-files 指的就是它', () => {
    // 漏填 botsDir 的后果是那份策略静默失效，而它守的是「bot 改写自己那份文件」这条会话中途、
    // 没人看着的写入
    expect(vars().botsDir).toBe('/tmp/shuvix-bots')
    // 工作区来自 getConfig()（每次评估现读），不是构造时的快照
    expect(vars().workspace).toBe('/ws')
  })

  // sessionArtifactsDir —— ask-on-write 对它免询问（本会话认领下来的图与交互块）。
  // 它是**免询问的范围**，所以两件事都得钉：取的是哪一个会话的目录（SEC-7），以及坏 id 不能把
  // 这个范围放大（SEC-8：空 id = 所有会话的 artifacts 根，`..` = ~/.shuvix，里面有 policies/）。

  it('SEC-7 sessionArtifactsDir 由 getSessionArtifactsDir(ctx.sessionId) 填：一会话一个目录，子会话不继承父会话的', () => {
    tc.getSessionArtifactsDir.mockClear()
    expect(vars('s1').sessionArtifactsDir).toBe('/tmp/shuvix-artifacts/s1')
    // 取目录用的正是 ctx.sessionId —— artifact 工具落盘用的也是这个 id
    expect(tc.getSessionArtifactsDir).toHaveBeenCalledWith('s1')
    expect(tc.getSessionArtifactsDir.mock.calls.every(([id]) => id === 's1')).toBe(true)

    tc.getSessionArtifactsDir.mockClear()
    expect(vars('child').sessionArtifactsDir).toBe('/tmp/shuvix-artifacts/child')
    expect(tc.getSessionArtifactsDir.mock.calls.every(([id]) => id === 'child')).toBe(true)

    // 同一个 provider 反复现取，值不漂
    const provider = providerFor('s1')
    const first = (provider.getVars() as Record<string, unknown>).sessionArtifactsDir
    const second = (provider.getVars() as Record<string, unknown>).sessionArtifactsDir
    expect(first).toBe('/tmp/shuvix-artifacts/s1')
    expect(second).toBe(first)
  })

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b'])(
    'SEC-8 坏会话 id %j 不放大豁免：sessionArtifactsDir 给空串（inDir 恒不命中，两道门照问）',
    (id) => {
      expect(vars(id).sessionArtifactsDir).toBe('')
    }
  )

  // shuvixConfigDirs —— protect-shuvix-config（force-ask）守的就是它：漏一项，那一类规矩文件的写入
  // 就回到普通的 ask-on-write，于是可以被审查员代答，一次注入就能改掉审查员自己
  it('SEC-9 shuvixConfigDirs 恰为 policies / agents / hooks / skills 四个默认目录（按这个顺序；内置与外部技能目录不在其中）', () => {
    expect(vars().shuvixConfigDirs).toEqual([
      '/tmp/shuvix-policies',
      '/tmp/shuvix-agents',
      '/tmp/shuvix-hooks',
      '/tmp/shuvix-actor-skills'
    ])
  })
})

describe('resolveProjectConfig —— 工作目录照抄 getById 的口径', () => {
  beforeEach(() => {
    tc.getById.mockReset()
    tc.projectPick.mockReset()
    tc.getTempWorkspace.mockClear()
  })

  it('TC-WD1 项目会话 → 项目根（settings 里另有目录也不用），envVars 取项目的', () => {
    tc.getById.mockReturnValue({
      id: 's1',
      projectId: 'p1',
      settings: { workingDirectory: '/own/dir' },
      workingDirectory: '/proj/root'
    })
    tc.projectPick.mockReturnValue({
      id: 'p1',
      path: '/proj/root',
      settings: { tool: { envVars: [{ key: 'K', value: 'v' }] } }
    })
    expect(resolveProjectConfig('s1')).toEqual({
      workingDirectory: '/proj/root',
      envVars: { K: 'v' }
    })
    expect(tc.projectPick).toHaveBeenCalledWith('p1', ['id', 'path', 'settings'])
    expect(tc.getTempWorkspace).not.toHaveBeenCalled()
  })

  it('TC-WD2 无项目、自带目录 → 那个目录；不问临时工作区', () => {
    tc.getById.mockReturnValue({
      id: 's2',
      projectId: null,
      settings: { workingDirectory: '/own/dir' },
      workingDirectory: '/own/dir'
    })
    expect(resolveProjectConfig('s2')).toEqual({ workingDirectory: '/own/dir' })
    expect(tc.projectPick).not.toHaveBeenCalled()
    expect(tc.getTempWorkspace).not.toHaveBeenCalled()
  })

  it('TC-WD3 无项目、没有自带目录 → getById 给的临时工作区', () => {
    tc.getById.mockReturnValue({
      id: 's3',
      projectId: null,
      settings: {},
      workingDirectory: '/tmp/temp_workspace/s3'
    })
    expect(resolveProjectConfig('s3')).toEqual({ workingDirectory: '/tmp/temp_workspace/s3' })
  })

  it('TC-WD4 会话不存在 → 临时工作区（按 sessionId 取）', () => {
    tc.getById.mockReturnValue(undefined)
    expect(resolveProjectConfig('gone')).toEqual({ workingDirectory: '/tmp/shuvix-actor-ws' })
    expect(tc.getTempWorkspace).toHaveBeenCalledWith('gone')
  })
})

/**
 * HG-1 命令沙箱的宿主胶水 —— 两件事：
 *   - getSessionPathGrants：会话「允许并记住」的路径授权（allowList）拆成写 / 读两组，交给沙箱当
 *     可写根 / 放回可读。与安全模块同一个解析（parseAllowEntry）：Bash(...) 这类命令条目早已不授予
 *     任何东西，写坏的条目同理 —— 它们要是被当成路径，沙箱就会凭空多出一个可写根；
 *   - getVars 的沙箱那一面：六个 `sandbox*` 键来自 sessionView(ctx.sessionId, 工作区)，工作区与
 *     文件工具看到的是同一个（getConfig 现读），所以免询问范围就是命令实际能碰的范围。
 */
describe('HG-1 getSessionPathGrants —— allowList 拆成写 / 读授权根', () => {
  beforeEach(() => {
    tc.pickSettings.mockReset()
  })

  it('HG-1 Write(...) → grantedWrite、Read(...) → grantedRead（保持原顺序）；Bash(...) 与写坏的条目跳过', () => {
    tc.pickSettings.mockReturnValue({
      allowList: ['Write(/a)', 'Read(/b)', 'Write(/c/d)', 'Bash(ls)', 'junk']
    })
    expect(getSessionPathGrants('s1')).toEqual({
      grantedWrite: ['/a', '/c/d'],
      grantedRead: ['/b']
    })
    // 按这条会话、只取 allowList 一个键
    expect(tc.pickSettings).toHaveBeenCalledWith('s1', ['allowList'])
  })

  it('HG-1 会话不存在 / 行里没有 allowList 键（DAO 回 null）→ 两组都是空', () => {
    tc.pickSettings.mockReturnValue(undefined)
    expect(getSessionPathGrants('gone')).toEqual({ grantedWrite: [], grantedRead: [] })

    tc.pickSettings.mockReturnValue({ allowList: null })
    expect(getSessionPathGrants('s-no-key')).toEqual({ grantedWrite: [], grantedRead: [] })

    tc.pickSettings.mockReturnValue({ allowList: [] })
    expect(getSessionPathGrants('s-empty')).toEqual({ grantedWrite: [], grantedRead: [] })
  })

  it('HG-1 只有命令类 / 写坏的条目 → 什么也不授予（不会把条目原文当成路径）', () => {
    tc.pickSettings.mockReturnValue({
      allowList: ['Bash(rm -rf /)', 'Write()', 'write(/lower)', '/plain/path', '']
    })
    expect(getSessionPathGrants('s1')).toEqual({ grantedWrite: [], grantedRead: [] })
  })
})

describe('HG-1 getVars —— 展开 sandbox.sessionView 的四个键', () => {
  const SANDBOX_KEYS = [
    'sandboxActive',
    'sandboxWritableRoots',
    'sandboxWriteDenied',
    'sandboxProtectedPatterns'
  ] as const

  const pickSandboxKeys = (vars: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(SANDBOX_KEYS.filter((k) => k in vars).map((k) => [k, vars[k]]))

  const sessionViewSpy = vi.mocked(sessionView)

  beforeEach(() => {
    sessionViewSpy.mockClear()
    tc.getById.mockReset()
    tc.projectPick.mockReset()
  })

  it('HG-1 sandbox 模块给什么，四个键就是什么；按 ctx.sessionId 与 getConfig() 的工作区去取', () => {
    const fake = {
      sandboxActive: true,
      sandboxWritableRoots: ['/ws', '/private/tmp/shuvix-501/abcd1234'],
      sandboxWriteDenied: ['/ws/.git/hooks'],
      sandboxProtectedPatterns: ['**/.git/config']
    }
    sessionViewSpy.mockReturnValueOnce(fake)

    const vars = makeDesktopSecurityProvider(
      { sessionId: 'sess-1', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    ).getVars() as Record<string, unknown>

    expect(sessionViewSpy.mock.calls).toEqual([['sess-1', '/ws']])
    expect(pickSandboxKeys(vars)).toEqual(fake)
    // 展开的是沙箱那一面，不是把整张表换掉：其余变量照旧
    expect(vars.workspace).toBe('/ws')
    expect(vars.botsDir).toBe('/tmp/shuvix-bots')
  })

  it('HG-1 工作区与工具同源：getConfig = resolveProjectConfig 时传给 sessionView 的就是项目根，且每次现读', () => {
    tc.getById.mockReturnValue({
      id: 's2',
      projectId: 'p1',
      settings: {},
      workingDirectory: '/proj/root'
    })
    tc.projectPick.mockReturnValue({ id: 'p1', path: '/proj/root', settings: {} })

    const provider = makeDesktopSecurityProvider(
      { sessionId: 's2', requestUserInput: undefined },
      () => resolveProjectConfig('s2')
    )
    const first = provider.getVars() as Record<string, unknown>
    expect(sessionViewSpy.mock.calls).toEqual([['s2', '/proj/root']])
    // 文件工具的 workspace 与沙箱那一面拿的是同一个目录
    expect(first.workspace).toBe('/proj/root')

    // 会话换了工作目录（例如项目被挪走）：同一个 provider 下一次评估就跟上，不是构造时的快照
    tc.getById.mockReturnValue({
      id: 's2',
      projectId: null,
      settings: { workingDirectory: '/elsewhere' },
      workingDirectory: '/elsewhere'
    })
    const second = provider.getVars() as Record<string, unknown>
    expect(sessionViewSpy.mock.calls.at(-1)).toEqual(['s2', '/elsewhere'])
    expect(second.workspace).toBe('/elsewhere')
  })

  it('HG-1 真实 sandbox 模块、会话未固定 → 四个键都在且全是「未启用」的值（不去碰 electron app）', () => {
    // 这里没有 mock electron：`app` 在 node 里是 undefined，真实 sessionView 若去取 app.getPath
    // 就会抛 —— 能拿到结果本身就说明未固定的会话不碰宿主路径
    const vars = makeDesktopSecurityProvider(
      { sessionId: 'never-pinned', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    ).getVars() as Record<string, unknown>

    expect(sessionViewSpy).toHaveBeenCalledTimes(1)
    expect(pickSandboxKeys(vars)).toEqual({
      sandboxActive: false,
      sandboxWritableRoots: [],
      sandboxWriteDenied: [],
      sandboxProtectedPatterns: []
    })
    // 四个键一个不少：策略的 vars.sandbox* 指向未设变量会走 fail-safe 并刷告警
    for (const key of SANDBOX_KEYS) expect(vars, key).toHaveProperty(key)
  })
})

/**
 * HG-3 工作区写入视图 —— ask-on-write 的工作区豁免不再依赖沙箱：getVars 另展开
 * sandbox.workspaceWriteView(ctx.sessionId, 工作区) 的三个键。参数必须与沙箱那一面同一对（同一个会话、
 * 文件工具看到的同一个工作区），且每次评估现取 —— 会话中途换了工作目录，豁免范围跟着走。
 */
describe('HG-3 getVars —— 展开 sandbox.workspaceWriteView 的三个键', () => {
  const WORKSPACE_KEYS = [
    'workspaceWritable',
    'workspaceWriteDenied',
    'workspaceProtectedPatterns'
  ] as const

  const pickWorkspaceKeys = (vars: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(WORKSPACE_KEYS.filter((k) => k in vars).map((k) => [k, vars[k]]))

  const sessionViewSpy = vi.mocked(sessionView)
  const workspaceWriteViewSpy = vi.mocked(workspaceWriteView)

  beforeEach(() => {
    // mockReset 回到透传真实实现（vi.fn(impl) 的语义），顺带清掉没用完的 Once 值
    sessionViewSpy.mockReset()
    workspaceWriteViewSpy.mockReset()
  })

  it('HG-3a workspaceWriteView 给什么，三个键就是什么；参数与 sessionView 同一对（ctx.sessionId, getConfig() 的工作区）；同一个 provider 每次评估现取', () => {
    const first = {
      workspaceWritable: ['/ws'],
      workspaceWriteDenied: ['/ws/.vscode', '/Users/u/.ssh'],
      workspaceProtectedPatterns: ['/\\.[Gg][Ii][Tt]$']
    }
    const second = {
      workspaceWritable: ['/elsewhere'],
      workspaceWriteDenied: ['/elsewhere/.claude'],
      workspaceProtectedPatterns: []
    }
    workspaceWriteViewSpy.mockReturnValueOnce(first).mockReturnValueOnce(second)

    let workingDirectory = '/ws'
    const provider = makeDesktopSecurityProvider(
      { sessionId: 'sess-w', requestUserInput: undefined },
      () => ({ workingDirectory })
    )

    const v1 = provider.getVars() as Record<string, unknown>
    expect(workspaceWriteViewSpy.mock.calls).toEqual([['sess-w', '/ws']])
    expect(workspaceWriteViewSpy.mock.calls).toEqual(sessionViewSpy.mock.calls)
    expect(pickWorkspaceKeys(v1)).toEqual(first)
    // 展开的是多出来的三个键，不是把整张表换掉：工作区与沙箱那一面照旧
    expect(v1.workspace).toBe('/ws')
    expect(v1.sandboxActive).toBe(false)

    // 会话换了工作目录：同一个 provider 下一次评估就跟上（两面拿到的都是新目录）
    workingDirectory = '/elsewhere'
    const v2 = provider.getVars() as Record<string, unknown>
    expect(workspaceWriteViewSpy).toHaveBeenCalledTimes(2)
    expect(workspaceWriteViewSpy.mock.calls.at(-1)).toEqual(['sess-w', '/elsewhere'])
    expect(sessionViewSpy.mock.calls.at(-1)).toEqual(['sess-w', '/elsewhere'])
    expect(pickWorkspaceKeys(v2)).toEqual(second)
    expect(v2.workspace).toBe('/elsewhere')
  })

  it('HG-3b 真实 sandbox 模块、不 mock electron（取不到 app.getPath，算不出规格）→ getVars 不抛，三个键都在且都是空数组（= 区内写照旧问）', () => {
    const provider = makeDesktopSecurityProvider(
      { sessionId: 'sess-real', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    )
    let vars: Record<string, unknown> = {}
    expect(() => {
      vars = provider.getVars() as Record<string, unknown>
    }).not.toThrow()

    expect(workspaceWriteViewSpy.mock.calls).toEqual([['sess-real', '/ws']])
    expect(pickWorkspaceKeys(vars)).toEqual({
      workspaceWritable: [],
      workspaceWriteDenied: [],
      workspaceProtectedPatterns: []
    })
    // 三个键一个不少：ask-on-write 的 match 引用它们，缺键会走 fail-safe
    for (const key of WORKSPACE_KEYS) expect(vars, key).toHaveProperty(key)
  })
})

/**
 * 主体（TC-SUBJ）与询问点的审查接缝（TC-RV）。
 *
 * subject 从 ctx.agent 来：档案名 + root / spawned（没有 ctx.agent 的调用点按 root 报，且不带档案名键；
 * 档案名空串同样不带）。审查员的防递归（「审查员自己在要权限」）与用户按主体写的策略都读它。
 * 观察点就是注入的审查者替身收到的 event.request.subject —— 生产里读它的正是那一个接缝。
 *
 * onPermissionRequest 每次调用现取注入的审查者：provider 可整会话复用，注入发生在启动时（index.ts），
 * 两者谁先谁后都得对。被动判定（evaluate / evaluateReadOnly / 预览面板与笔记本的 user 主体判定）
 * 只判不执行，从不走到接缝。
 */
describe('TC-SUBJ / TC-RV 桌面主体与审查接缝', () => {
  const WS = '/ws'
  const ART = '/tmp/shuvix-artifacts'
  /** 工作区外的普通文件：ask-on-write#0（ask 档 —— 审查接缝只管这一档） */
  const OUTSIDE = '/tmp/shuvix-tc-review-outside/a.txt'
  const projectConfig: ProjectConfig = { workingDirectory: WS }
  const cfg = (): ProjectConfig => projectConfig

  const usedSessions = new Set<string>()
  const sid = (id: string): string => {
    usedSessions.add(id)
    return id
  }

  const answer = (decision: 'allow' | 'ask' | 'deny'): PermissionReviewAnswer => ({
    verdict: { decision, risk: 'low', summary: 'Writes a file.', reason: 'test reviewer' },
    source: 'test-reviewer'
  })

  type Reviewer = (
    event: PermissionRequestEvent,
    signal?: AbortSignal
  ) => Promise<PermissionReviewAnswer | null>

  const verdictOf = (d: SecurityDecision): { effect: string; winning: string } => ({
    effect: d.effect,
    winning: d.winning
  })

  /** 用户在 ~/.shuvix/policies 里写的一份（与 policyService 一样：解析结果 + 文件名） */
  function userPolicy(fileName: string, md: string): UserPolicyFile {
    const parsed = parsePolicyDefinitionFile(md, fileName.replace(/\.md$/, ''))
    if (!parsed) throw new Error(`fixture policy ${fileName} does not parse`)
    return { ...parsed, fileName }
  }

  beforeEach(() => {
    tc.pickSettings.mockReset()
    tc.userPolicies = []
    vi.mocked(sessionView).mockReset()
    vi.mocked(workspaceWriteView).mockReset()
  })

  afterEach(() => {
    setPermissionReviewer(null)
    for (const id of usedSessions) {
      clearReviewState(id)
      clearSessionDecisions(id)
    }
    usedSessions.clear()
  })

  it.each<[string, string, ToolContext['agent'], Partial<SecuritySubject>]>([
    [
      '派生的 coding',
      'tc-subj1-spawned',
      { profileName: 'coding', kind: 'spawned' },
      { agentKind: 'spawned', profileName: 'coding' }
    ],
    [
      '会话根 work',
      'tc-subj1-root',
      { profileName: 'work', kind: 'root' },
      { agentKind: 'root', profileName: 'work' }
    ],
    [
      '没有 ctx.agent（MCP 能力服务器等自建 ctx 的调用点）',
      'tc-subj1-none',
      undefined,
      { agentKind: 'root' }
    ],
    [
      '档案名为空串',
      'tc-subj1-blank',
      { profileName: '', kind: 'spawned' },
      { agentKind: 'spawned' }
    ]
  ])(
    'TC-SUBJ1 %s → 审查接缝收到的 subject 恰为 agent + 会话 id + agentKind（+ 有名字时的 profileName）',
    async (_label, id, agent, expected) => {
      const sessionId = sid(id)
      const seen: SecuritySubject[] = []
      setPermissionReviewer(async (event) => {
        seen.push(event.request.subject)
        return answer('allow')
      })

      const ctx = getDesktopSecurityContext({ sessionId, ...(agent ? { agent } : {}) }, cfg)
      // 审查员放行 → 不弹卡、直接过门（这里没给询问通道，走到卡片就会被拒）
      await expect(
        ctx.enforcePath('write', OUTSIDE, { toolCallId: `${id}-w`, toolName: 'write' })
      ).resolves.toBeUndefined()

      expect(seen).toHaveLength(1)
      // toStrictEqual：没有档案名时连 profileName 键都不该有（值为 undefined 的键也算多）
      expect(seen[0]).toStrictEqual({ kind: 'agent', sessionId, ...expected })
    }
  )

  it('TC-SUBJ2 用户策略按主体写（subject.profile == coding && subject.agentKind == spawned 的 deny）：只落在派生的 coding 上', () => {
    tc.userPolicies = [
      userPolicy(
        'no-spawned-coding-writes.md',
        [
          '---',
          'shuvix: policy v1',
          'name: no-spawned-coding-writes',
          'description: Spawned coding agents may not write files.',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    action: [write]',
          "    match: subject.profile == 'coding' && subject.agentKind == 'spawned'",
          '---',
          ''
        ].join('\n')
      )
    ]

    const cases: Array<[ToolContext['agent'], string, string]> = [
      // [ctx.agent, 本会话 artifacts 里的写, 工作区外的写]
      [{ profileName: 'coding', kind: 'spawned' }, 'deny', 'deny'],
      [{ profileName: 'coding', kind: 'root' }, 'allow', 'ask'],
      [{ profileName: 'work', kind: 'spawned' }, 'allow', 'ask'],
      [{ profileName: '', kind: 'spawned' }, 'allow', 'ask'],
      [undefined, 'allow', 'ask']
    ]
    const sessionId = sid('tc-subj2')
    for (const [agent, artifactEffect, outsideEffect] of cases) {
      const ctx = getDesktopSecurityContext({ sessionId, ...(agent ? { agent } : {}) }, cfg)
      const own = ctx.evaluate('write', { type: 'path', path: `${ART}/${sessionId}/chart.svg` })
      const outside = ctx.evaluate('write', { type: 'path', path: OUTSIDE })
      expect({ agent, own: own.effect, outside: outside.effect }).toEqual({
        agent,
        own: artifactEffect,
        outside: outsideEffect
      })
      if (artifactEffect === 'deny') {
        // 拒绝归因到用户那条规则（deny 压过 ask-on-write，也压过本会话 artifacts 的豁免）
        expect(verdictOf(own)).toEqual({ effect: 'deny', winning: 'no-spawned-coding-writes#0' })
        expect(verdictOf(outside)).toEqual({
          effect: 'deny',
          winning: 'no-spawned-coding-writes#0'
        })
      } else {
        expect(own.matched, JSON.stringify(agent)).not.toContain('no-spawned-coding-writes#0')
        expect(outside.winning, JSON.stringify(agent)).toBe('ask-on-write#0')
      }
    }
  })

  it('TC-RV1 没注入审查者：provider.onPermissionRequest 交回 null —— 询问照旧走到卡片（卡上没有审查意见）', async () => {
    const sessionId = sid('tc-rv1')
    const provider = makeDesktopSecurityProvider({ sessionId }, cfg)
    const event = { toolCallId: 'rv1', command: 'Write(/x)' } as unknown as PermissionRequestEvent
    expect(provider.onPermissionRequest).toBeTypeOf('function')
    await expect(
      provider.onPermissionRequest!(event, new AbortController().signal)
    ).resolves.toBeNull()
    await expect(provider.onPermissionRequest!(event)).resolves.toBeNull()

    // 端到端：同一次 ask 直接到人
    const asks: InputRequest[] = []
    const ctx = getDesktopSecurityContext(
      {
        sessionId,
        requestUserInput: async (req) => {
          asks.push(req)
          return { kind: 'ask', allowed: true }
        }
      },
      cfg
    )
    await ctx.enforcePath('write', OUTSIDE, { toolCallId: 'rv1-w', toolName: 'write' })
    expect(asks).toHaveLength(1)
    expect((asks[0] as AskInputRequest).review).toBeUndefined()
  })

  it('TC-RV2 注入之前就构造好的 provider，下一次调用也走注入的审查者：(event, signal) 原样交进去、回答原样交回；setPermissionReviewer(null) 之后复原成 null', async () => {
    const provider = makeDesktopSecurityProvider({ sessionId: sid('tc-rv2') }, cfg)
    const event = { toolCallId: 'rv2', command: 'Write(/x)' } as unknown as PermissionRequestEvent
    const signal = new AbortController().signal
    await expect(provider.onPermissionRequest!(event, signal)).resolves.toBeNull()

    const reply = answer('deny')
    const reviewer = vi.fn<Reviewer>(async () => reply)
    setPermissionReviewer(reviewer)
    const got = await provider.onPermissionRequest!(event, signal)
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(reviewer.mock.calls[0][0]).toBe(event)
    expect(reviewer.mock.calls[0][1]).toBe(signal)
    expect(got).toBe(reply)

    // 换一个审查者：同一个 provider 立刻跟上（不是构造时的快照）
    const other = vi.fn<Reviewer>(async () => null)
    setPermissionReviewer(other)
    await expect(provider.onPermissionRequest!(event, signal)).resolves.toBeNull()
    expect(other).toHaveBeenCalledTimes(1)

    setPermissionReviewer(null)
    await expect(provider.onPermissionRequest!(event, signal)).resolves.toBeNull()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(other).toHaveBeenCalledTimes(1)
  })

  it('TC-RV3 被动判定从不调审查者：user 主体的 isPathReadAllowed / isPathWriteAllowed（连用户自己的 ask 策略判出 ask 时也不调）；agent 主体的 evaluate / evaluateReadOnly 同样只判不问', () => {
    const reviewer = vi.fn<Reviewer>(async () => answer('allow'))
    setPermissionReviewer(reviewer)

    // 内置防护只管 agent 主体：用户亲手的 UI 操作默认放行
    expect(isPathReadAllowed(projectConfig, OUTSIDE)).toBe(true)
    expect(isPathWriteAllowed(projectConfig, OUTSIDE)).toBe(true)

    // 用户给自己的 UI 面写了一道 ask 门：被动判定给 false（占位），不会去问审查员
    tc.userPolicies = [
      userPolicy(
        'user-ui-ask-outside.md',
        [
          '---',
          'shuvix: policy v1',
          'name: user-ui-ask-outside',
          'description: My own notebook writes outside the project ask first.',
          'shuvix-policy-scope:',
          '  subject.kind: [user]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: ask',
          '    action: [write]',
          '    match: >-',
          '      !inDir(object.path, vars.workspace)',
          '---',
          ''
        ].join('\n')
      )
    ]
    expect(isPathWriteAllowed(projectConfig, OUTSIDE)).toBe(false)
    expect(isPathWriteAllowed(projectConfig, `${WS}/in.txt`)).toBe(true)

    // agent 主体：ask 档，但 evaluate / evaluateReadOnly 只是判定
    const ctx = getDesktopSecurityContext({ sessionId: sid('tc-rv3') }, cfg)
    expect(ctx.evaluate('write', { type: 'path', path: OUTSIDE })).toMatchObject({
      effect: 'ask',
      tier: 'ask',
      winning: 'ask-on-write#0'
    })
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: OUTSIDE })).toBe(false)

    expect(reviewer).not.toHaveBeenCalled()
  })
})

/**
 * HG-4 sessionCredentialPaths —— 命令沙箱的凭据清单（main 启动时经 setSandboxCredentialReader 注入）：
 * 生效的 protect-credentials 的 `credentialDirs`，用宿主的非沙箱变量（hostPolicyVars）求值，只留绝对路径。
 * 沙箱视图本身要用这份清单，所以求值时绝不能反过来去取沙箱视图（sessionView / workspaceWriteView）。
 * 用户策略由 tc.userPolicies 喂（与 policyService.getUserPolicies 同形：解析结果 + 文件名），每次现读。
 */
describe('HG-4 sessionCredentialPaths', () => {
  const HOME = homedir()
  const BUILTIN = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.config/gh',
    '.netrc',
    '.shuvix/.session-state',
    'AppData/Local/Microsoft/Credentials',
    'AppData/Roaming/Microsoft/Credentials'
  ].map((d) => `${HOME}/${d}`)

  /** 出厂 en 那份原样解析 —— 覆盖副本的起点 */
  const builtinCopy = (): ReturnType<typeof parsePolicyDefinitionFile> & object => {
    const parsed = parsePolicyDefinitionFile(
      readFileSync(join(tc.builtinDir, 'protect-credentials.md'), 'utf-8'),
      'protect-credentials'
    )
    if (!parsed) throw new Error('builtin protect-credentials.md does not parse')
    return parsed
  }

  /** 用户在 ~/.shuvix/policies 放的同名覆盖：规则照抄出厂，let 换成给定表达式（null = 删掉 lets） */
  const override = (credentialDirs: string | null, extra: { rules?: [] } = {}): UserPolicyFile => {
    const { lets: _lets, ...rest } = builtinCopy()
    return {
      ...rest,
      ...(credentialDirs === null ? {} : { lets: { credentialDirs } }),
      ...extra,
      fileName: 'protect-credentials.md'
    }
  }

  beforeEach(() => {
    tc.userPolicies = []
    tc.securityLog.warn.mockClear()
    vi.mocked(sessionView).mockReset()
    vi.mocked(workspaceWriteView).mockReset()
  })

  afterEach(() => {
    tc.userPolicies = []
  })

  it('SCP-1 没有用户策略 → 出厂的 8 个位置，拼在真实家目录上', () => {
    expect(sessionCredentialPaths('s1', '/ws')).toEqual(BUILTIN)
    expect(tc.securityLog.warn).not.toHaveBeenCalled()
  })

  it('SCP-2 同名覆盖改了清单 → 恰为覆盖给的那几项（没有 .aws）', () => {
    tc.userPolicies = [override("[vars.home + '/.ssh', vars.home + '/.gnupg']")]
    const paths = sessionCredentialPaths('s1', '/ws')
    expect(paths).toEqual([`${HOME}/.ssh`, `${HOME}/.gnupg`])
    expect(paths).not.toContain(`${HOME}/.aws`)
  })

  it('SCP-3 宿主变量流进 let（工作区、bots 目录、本会话 artifacts）；坏会话 id 的 artifacts 是空串、被丢掉', () => {
    tc.userPolicies = [
      // CEL 的列表字面量要求元素同类型：裸的 vars.x 是 dyn，与 string 混写会求值失败，故包一层 string()
      override(
        "[vars.workspace + '/secrets', string(vars.botsDir), string(vars.sessionArtifactsDir)]"
      )
    ]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual([
      '/ws/secrets',
      '/tmp/shuvix-bots',
      '/tmp/shuvix-artifacts/s1'
    ])
    expect(sessionCredentialPaths('..', '/ws')).toEqual(['/ws/secrets', '/tmp/shuvix-bots'])
  })

  it.each<[string, string, string[]]>([
    [
      '混着空串 / 相对路径的列表 → 只留绝对路径',
      "['/a', '', string(vars.home), '.ssh', 'rel/x']",
      ['/a', HOME]
    ],
    ['数字列表 → 空', '[1, 2]', []],
    ['单个字符串 → 空（不替它包成列表）', "'/single'", []],
    ['映射 → 空', "{'a': '/x'}", []]
  ])('SCP-4 %s', (_label, expr, expected) => {
    tc.userPolicies = [override(expr)]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual(expected)
  })

  it('SCP-5 覆盖里没有这个 let（lets 为空表 / 没有 lets）、或规则清空了（let 还在）→ 空清单', () => {
    tc.userPolicies = [{ ...override(null), lets: {} }]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual([])
    tc.userPolicies = [override(null)]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual([])
    const cleared = override("[vars.home + '/.ssh']", { rules: [] })
    expect(cleared.lets?.credentialDirs).toBeDefined()
    tc.userPolicies = [cleared]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual([])
  })

  it('SCP-6 覆盖里的 let 求值出错（引用了宿主求值时不给的沙箱变量）→ 退回出厂清单 + Security 日志恰一行；求值全程不碰沙箱视图（不递归）', () => {
    tc.userPolicies = [override('vars.sandboxWritableRoots')]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual(BUILTIN)
    expect(tc.securityLog.warn).toHaveBeenCalledTimes(1)
    const line = String(tc.securityLog.warn.mock.calls[0][0])
    expect(line).toContain('protect-credentials')
    expect(line).toContain('credentialDirs')
    expect(line).toContain('using the builtin value instead')

    // 写错与没写不同：去掉 let 的覆盖照旧是空清单
    tc.userPolicies = [override(null)]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual([])

    // 出厂那份求值同样不碰沙箱视图
    tc.userPolicies = []
    expect(sessionCredentialPaths('s1', '/ws')).toEqual(BUILTIN)
    expect(sessionView).not.toHaveBeenCalled()
    expect(workspaceWriteView).not.toHaveBeenCalled()
  })

  it('SCP-7 每次现读：两次调用之间换了用户策略，第二次就跟上', () => {
    expect(sessionCredentialPaths('s1', '/ws')).toEqual(BUILTIN)
    tc.userPolicies = [override("[vars.home + '/.ssh']")]
    expect(sessionCredentialPaths('s1', '/ws')).toEqual([`${HOME}/.ssh`])
    tc.userPolicies = []
    expect(sessionCredentialPaths('s1', '/ws')).toEqual(BUILTIN)
  })
})
