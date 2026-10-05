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
 *   getVars 的 `sessionDirs` / `sessionReadDirs` 来自 sandbox.sessionDirsView(ctx.sessionId,
 *     <工具看到的同一个工作区>, sessionDirExtras(ctx.sessionId)) —— 外部目录访问策略（ask-on-external-path）
 *     的免询问范围与命令实际能碰的范围是同一份清单。sandbox 模块以「透传真实实现的 spy」替身：默认走
 *     真实 sessionDirsView（本文件不 mock electron，取不到 app.getPath → 空清单，HG-1 钉住这条出错路径
 *     不抛），单条用例可以换成假值；
 *   HG-2 sessionDirExtras —— 会话设置带来的那部分会话目录：勾选的知识库（非只读 → 可读写，只读的内置库
 *     → 只读）、技能目录（随包的内置 + skillService.enabledSkillRoots，只读）；任一来源抛错只少给、不抛。
 *
 * 询问点的自动审查带来的桌面接线（设计稿 docs/permission-review-design.md）：
 *   SEC-9 shuvixConfigDirs —— policies / agents / hooks / skills 四个目录（事实变量：引用它的出厂
 *     protect-shuvix-config 已于 2026-10-01 退役，留给用户自写的策略）；
 *   TC-SUBJ 桌面 subject 带上 ctx.agent 的档案名与 root / spawned（审查员的防递归与用户策略都读它）；
 *   TC-RV onPermissionRequest 每次现取注入的审查者（setPermissionReviewer），被动判定从不走到它。
 * 需要真实评估的用例读仓库里那份内置策略 md（同 askPolicy.test）；用户策略由 tc.userPolicies 喂。
 * reviewState / 决策日志是进程级表：这些用例各用独立 sessionId，afterEach 清掉。
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const tc = vi.hoisted(() => ({
  getById: vi.fn((_id: string): unknown => undefined),
  projectPick: vi.fn((_id: string, _cols: string[]): unknown => undefined),
  pickSettings: vi.fn((_id: string, _keys: string[]): unknown => undefined),
  getTempWorkspace: vi.fn((_sid: string) => '/tmp/shuvix-actor-ws'),
  getSessionArtifactsDir: vi.fn((id: string) => `/tmp/shuvix-artifacts/${id}`),
  /** knowledge/sessionBundle.enabledTargets：本会话勾选、且这台机器上真有的知识库（HG-2 换） */
  enabledTargets: vi.fn(
    (_sid: string): Array<{ name: string; target: { dir: string; readonly?: boolean } }> => []
  ),
  /** skillService.enabledSkillRoots：默认技能目录 + 没被停用的外部技能目录（HG-2 换） */
  enabledSkillRoots: vi.fn((): string[] => []),
  /** policyService.getUserPolicies 交出的用户策略（TC-SUBJ2 / TC-RV3 换） */
  userPolicies: [] as UserPolicyFile[],
  // 内置策略的事实源 —— 运行时读随包发布的目录，这里直接读仓库里那一份（同一批文件）。
  // src/main/services/__tests__ 往上六级是仓库根
  builtinDir: `${__dirname}/../../../../../../packages/agent-runtime/src/security/builtinPolicies/md`
}))

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: tc.projectPick } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: tc.pickSettings } }))
// 真实模块 + sessionDirsView 换成透传 spy：不改行为，只多一个观测点（与可按用例替换的返回值）
vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  return { ...actual, sessionDirsView: vi.fn(actual.sessionDirsView) }
})
vi.mock('../sessionService', () => ({
  sessionService: { getById: tc.getById, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({
  skillService: { listExternalDirs: () => [], enabledSkillRoots: tc.enabledSkillRoots }
}))
vi.mock('../knowledge/sessionBundle', () => ({ enabledTargets: tc.enabledTargets }))
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
  // getVars 的 shuvixConfigDirs 的四个目录（退役的 protect-shuvix-config 引用它们）
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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  agentActorOf,
  getDesktopSecurityContext,
  getSessionPathGrants,
  isPathReadAllowed,
  isPathWriteAllowed,
  makeDesktopSecurityProvider,
  resolveProjectConfig,
  sessionDirExtras,
  setPermissionReviewer,
  withCallAgent,
  type ProjectConfig,
  type ToolContext
} from '../toolContext'
import type { ToolAgentIdentity } from '../toolAgent'
import { sessionDirsView } from '../sandbox'
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

  it('SEC-6 botsDir 由 getDefaultBotsDir() 填 —— 退役的 protect-bot-files 指的就是它（事实变量，留给用户策略）', () => {
    // 漏填 botsDir 的后果是引用它的策略静默失效，而那种策略守的是「bot 改写自己那份文件」这条
    // 会话中途、没人看着的写入
    expect(vars().botsDir).toBe('/tmp/shuvix-bots')
    // 工作区来自 getConfig()（每次评估现读），不是构造时的快照
    expect(vars().workspace).toBe('/ws')
  })

  // sessionArtifactsDir —— 本会话认领下来的图与交互块所在（事实变量；免询问靠的是 vars.sessionDirs
  // 里同一个目录，见 HG-1）。用户策略拿它当范围时两件事都得钉：取的是哪一个会话的目录（SEC-7），
  // 以及坏 id 不能把这个范围放大（SEC-8：空 id = 所有会话的 artifacts 根，`..` = ~/.shuvix，里面有 policies/）。

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
    'SEC-8 坏会话 id %j 不放大范围：sessionArtifactsDir 给空串（inDir 恒不命中）',
    (id) => {
      expect(vars(id).sessionArtifactsDir).toBe('')
    }
  )

  // shuvixConfigDirs —— 事实变量：用户装回 protect-shuvix-config（force-ask）时守的就是它：漏一项，
  // 那一类规矩文件的写入就回到普通的 ask-on-external-path，于是可以被审查员代答，一次注入就能改掉
  // 审查员自己
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
 *     可读写 / 可读的根（也是策略的 vars.grantedWrite / grantedRead）。与安全模块同一个解析
 *     （parseAllowEntry）：Bash(...) 这类命令条目早已不授予任何东西，写坏的条目同理 —— 它们要是被
 *     当成路径，沙箱就会凭空多出一个可写根；
 *   - getVars 的 `sessionDirs`：来自 sessionDirsView(ctx.sessionId, 工作区)，工作区与文件工具看到的是
 *     同一个（getConfig 现读），所以文件工具的免询问范围就是命令实际能碰的范围。
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

describe('HG-1 getVars —— sessionDirs 来自 sandbox.sessionDirsView', () => {
  const sessionDirsViewSpy = vi.mocked(sessionDirsView)

  beforeEach(() => {
    // mockReset 回到透传真实实现（vi.fn(impl) 的语义），顺带清掉没用完的 Once 值
    sessionDirsViewSpy.mockReset()
    tc.getById.mockReset()
    tc.projectPick.mockReset()
    tc.enabledTargets.mockReset()
    tc.enabledTargets.mockReturnValue([])
    tc.enabledSkillRoots.mockReset()
    tc.enabledSkillRoots.mockReturnValue([])
  })

  it('HG-1 sandbox 模块给什么，sessionDirs / sessionReadDirs 就是什么；按 ctx.sessionId、getConfig() 的工作区与 sessionDirExtras(ctx.sessionId) 去取', () => {
    tc.enabledTargets.mockReturnValue([{ name: 'notes', target: { dir: '/kb/notes' } }])
    tc.enabledSkillRoots.mockReturnValue(['/tmp/shuvix-actor-skills'])
    const fake = {
      sessionDirs: [
        '/ws',
        '/private/tmp/shuvix-501/abcd1234',
        '/Users/u/.shuvix/artifacts/sess-1',
        '/tool-results/sess-1',
        '/kb/notes'
      ],
      sessionReadDirs: ['/tmp/shuvix-actor-builtin-skills', '/tmp/shuvix-actor-skills']
    }
    sessionDirsViewSpy.mockReturnValueOnce(fake)

    const vars = makeDesktopSecurityProvider(
      { sessionId: 'sess-1', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    ).getVars() as Record<string, unknown>

    expect(sessionDirsViewSpy.mock.calls).toEqual([
      [
        'sess-1',
        '/ws',
        {
          readWrite: ['/kb/notes'],
          readOnly: ['/tmp/shuvix-actor-builtin-skills', '/tmp/shuvix-actor-skills']
        }
      ]
    ])
    expect(tc.enabledTargets).toHaveBeenCalledWith('sess-1')
    expect(vars.sessionDirs).toEqual(fake.sessionDirs)
    expect(vars.sessionReadDirs).toEqual(fake.sessionReadDirs)
    // 多出来的是这两个键，不是把整张表换掉：其余变量照旧
    expect(vars.workspace).toBe('/ws')
    expect(vars.botsDir).toBe('/tmp/shuvix-bots')
  })

  it('HG-1 工作区与工具同源：getConfig = resolveProjectConfig 时传给 sessionDirsView 的就是项目根，且每次现读', () => {
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
    expect(sessionDirsViewSpy.mock.calls.map(([id, ws]) => [id, ws])).toEqual([
      ['s2', '/proj/root']
    ])
    // 文件工具的 workspace 与会话目录拿的是同一个目录
    expect(first.workspace).toBe('/proj/root')

    // 会话换了工作目录（例如项目被挪走）：同一个 provider 下一次评估就跟上，不是构造时的快照
    tc.getById.mockReturnValue({
      id: 's2',
      projectId: null,
      settings: { workingDirectory: '/elsewhere' },
      workingDirectory: '/elsewhere'
    })
    const second = provider.getVars() as Record<string, unknown>
    expect(sessionDirsViewSpy.mock.calls.at(-1)?.slice(0, 2)).toEqual(['s2', '/elsewhere'])
    expect(second.workspace).toBe('/elsewhere')
  })

  it('HG-1 真实 sandbox 模块、不 mock electron（取不到 app.getPath，算不出会话目录）→ getVars 不抛，sessionDirs / sessionReadDirs 都是空清单（= 多问，绝不因此放行）；旧的 sandbox* / workspace* 键不再给', () => {
    const provider = makeDesktopSecurityProvider(
      { sessionId: 'sess-real', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' })
    )
    let vars: Record<string, unknown> = {}
    expect(() => {
      vars = provider.getVars() as Record<string, unknown>
    }).not.toThrow()

    expect(sessionDirsViewSpy).toHaveBeenCalledTimes(1)
    expect(sessionDirsViewSpy.mock.calls[0].slice(0, 2)).toEqual(['sess-real', '/ws'])
    expect(vars.sessionDirs).toEqual([])
    expect(vars.sessionReadDirs).toEqual([])
    for (const key of [
      'sandboxActive',
      'sandboxWritableRoots',
      'sandboxWriteDenied',
      'sandboxProtectedPatterns',
      'workspaceWritable',
      'workspaceWriteDenied',
      'workspaceProtectedPatterns'
    ]) {
      expect(vars, key).not.toHaveProperty(key)
    }
  })
})

/**
 * HG-2 sessionDirExtras —— 会话设置决定的那部分会话目录，策略与命令沙箱同一个来源：
 * 勾选的知识库里，非只读的可读写、只读的（内置库）只读；技能目录（随包的内置 + 启用的默认 / 外部目录）
 * 只读 —— 技能是 agent 自己要遵守的指令，改它照旧询问。来源读不到时少给（多问），不抛。
 */
describe('HG-2 sessionDirExtras —— 勾选的知识库与技能目录', () => {
  beforeEach(() => {
    tc.enabledTargets.mockReset()
    tc.enabledSkillRoots.mockReset()
  })

  it('HG-2 非只读的库 → readWrite；只读的库与技能目录 → readOnly（随包的内置技能目录打头）；按会话 id 去取', () => {
    tc.enabledTargets.mockReturnValue([
      { name: 'project', target: { dir: '/kb-shuvix/projects/p1' } },
      { name: 'shuvix', target: { dir: '/opt/shuvix/knowledge/shuvix/en', readonly: true } },
      { name: 'notes', target: { dir: '/kb/notes' } }
    ])
    tc.enabledSkillRoots.mockReturnValue(['/tmp/shuvix-actor-skills', '/ext/skills'])

    expect(sessionDirExtras('s-kb')).toEqual({
      readWrite: ['/kb-shuvix/projects/p1', '/kb/notes'],
      readOnly: [
        '/tmp/shuvix-actor-builtin-skills',
        '/opt/shuvix/knowledge/shuvix/en',
        '/tmp/shuvix-actor-skills',
        '/ext/skills'
      ]
    })
    expect(tc.enabledTargets).toHaveBeenCalledWith('s-kb')
  })

  it('HG-2 一个库都没勾、没有启用的技能目录 → 只剩随包的内置技能目录（只读）', () => {
    tc.enabledTargets.mockReturnValue([])
    tc.enabledSkillRoots.mockReturnValue([])
    expect(sessionDirExtras('s-none')).toEqual({
      readWrite: [],
      readOnly: ['/tmp/shuvix-actor-builtin-skills']
    })
  })

  it('HG-2 知识库或技能目录读不到（抛错）→ 那一部分少给，另一部分照给，整体不抛', () => {
    tc.enabledTargets.mockImplementation(() => {
      throw new Error('scan failed')
    })
    tc.enabledSkillRoots.mockReturnValue(['/tmp/shuvix-actor-skills'])
    expect(sessionDirExtras('s-kb-broken')).toEqual({
      readWrite: [],
      readOnly: ['/tmp/shuvix-actor-builtin-skills', '/tmp/shuvix-actor-skills']
    })

    tc.enabledTargets.mockReset()
    tc.enabledTargets.mockReturnValue([{ name: 'notes', target: { dir: '/kb/notes' } }])
    tc.enabledSkillRoots.mockImplementation(() => {
      throw new Error('config unreadable')
    })
    expect(sessionDirExtras('s-skills-broken')).toEqual({
      readWrite: ['/kb/notes'],
      readOnly: ['/tmp/shuvix-actor-builtin-skills']
    })
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
  /** 会话目录外的普通文件：ask-on-external-path#1（ask 档 —— 审查接缝只管这一档） */
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
    vi.mocked(sessionDirsView).mockReset()
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

    // 会话目录照生产的形状给（工作区 + 本会话 artifacts）：真实模块在这里取不到 app.getPath，算出来是空的
    vi.mocked(sessionDirsView).mockImplementation((id, ws) => ({
      sessionDirs: [ws, `${ART}/${id}`],
      sessionReadDirs: []
    }))
    const cases: Array<[ToolContext['agent'], string, string]> = [
      // [ctx.agent, 本会话 artifacts 里的写, 会话目录外的写]
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
        // 拒绝归因到用户那条规则（deny 压过 ask-on-external-path，也压过本会话 artifacts 的豁免）
        expect(verdictOf(own)).toEqual({ effect: 'deny', winning: 'no-spawned-coding-writes#0' })
        expect(verdictOf(outside)).toEqual({
          effect: 'deny',
          winning: 'no-spawned-coding-writes#0'
        })
      } else {
        expect(own.matched, JSON.stringify(agent)).not.toContain('no-spawned-coding-writes#0')
        expect(outside.winning, JSON.stringify(agent)).toBe('ask-on-external-path#1')
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
      winning: 'ask-on-external-path#1'
    })
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: OUTSIDE })).toBe(false)

    expect(reviewer).not.toHaveBeenCalled()
  })

  /**
   * H11-53（P1-11）—— 会话级装配的工具（ctx 带 agentOf、没有固定的 agent）：每次 enforce 按 opts 里这次
   * 调用的 conversationId 现取主体（withCallAgent）。各工具族的 PEP 落在门面的哪个方法上：
   * write / edit / knowledge create → enforcePath('write')；ls / grep / glob / read / knowledge read →
   * enforcePath('read')；bash → enforceCommand；git → enforceGitOp；L1 门 → enforceInvocation。
   * 一份「agent 主体一律 ask」的用户策略让每一族都走到审查接缝，观察点同 TC-SUBJ1。
   */
  describe('H11-53 会话级 ctx 的主体按调用现取', () => {
    const ALWAYS_ASK = [
      '---',
      'shuvix: policy v1',
      'name: h11-always-ask',
      'description: Every agent operation asks (test).',
      'shuvix-policy-scope:',
      '  subject.kind: [agent]',
      '  object.type: [path, command, gitTool, invocation]',
      'shuvix-policy-rules:',
      '  - effect: ask',
      '    action: [read, write, execute]',
      "    match: 'true'",
      '---',
      ''
    ].join('\n')

    const WORK = { profileName: 'work', kind: 'root' as const }
    const owner = { taskId: 3, conversationId: 1 }

    type Gate = ReturnType<typeof getDesktopSecurityContext>
    /** 每一族的一次调用；拥有者缺省是对话 1（P2-06-17 换成别的对话） */
    type Family = (ctx: Gate, id: string, at?: typeof owner) => Promise<unknown>
    const FAMILIES: Array<[string, Family]> = [
      [
        'write（会话目录外）',
        (ctx, id, at = owner) =>
          ctx.enforcePath('write', OUTSIDE, { toolCallId: id, toolName: 'write', ...at })
      ],
      [
        'ls / grep / glob 读（会话目录外）',
        (ctx, id, at = owner) =>
          ctx.enforcePath('read', OUTSIDE, { toolCallId: id, toolName: 'grep', ...at })
      ],
      [
        '没圈住的 bash 命令',
        (ctx, id, at = owner) =>
          ctx.enforceCommand(
            { channel: 'bash', command: 'make build', cwd: WS },
            { toolCallId: id, toolName: 'bash', ...at }
          )
      ],
      [
        'git 操作',
        (ctx, id, at = owner) =>
          ctx.enforceGitOp(
            { gitAction: 'commit', command: 'git commit', force: false, delete: false },
            { toolCallId: id, toolName: 'git', ...at }
          )
      ],
      [
        'knowledge（create 落盘）',
        (ctx, id, at = owner) =>
          ctx.enforcePath('write', OUTSIDE, {
            toolCallId: id,
            toolName: 'knowledge',
            operation: 'create',
            ...at
          })
      ]
    ]

    it.each(FAMILIES)(
      'H11-53 %s：对话 1 上锁着 work → subject 带 work / root；认不出（没有锁）→ 不带档案名键',
      async (_label, call) => {
        tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
        const sessionId = sid('h11-53')
        const seen: SecuritySubject[] = []
        setPermissionReviewer(async (event) => {
          seen.push(event.request.subject)
          return answer('allow')
        })
        let locked = true
        const agentOf = vi.fn((conversationId: number) =>
          locked && conversationId === 1 ? WORK : undefined
        )
        const ctx = getDesktopSecurityContext({ sessionId, agentOf }, cfg)

        await call(ctx, 'h11-53-a')
        locked = false
        await call(ctx, 'h11-53-b')

        expect(agentOf.mock.calls).toEqual([[1], [1]])
        expect(seen).toHaveLength(2)
        expect(seen[0]).toStrictEqual({
          kind: 'agent',
          sessionId,
          agentKind: 'root',
          profileName: 'work'
        })
        expect(seen[1]).toStrictEqual({ kind: 'agent', sessionId, agentKind: 'root' })
      }
    )

    it('H11-53 L1 门（enforceInvocation）同样按调用取主体', async () => {
      tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
      const sessionId = sid('h11-53-l1')
      const seen: SecuritySubject[] = []
      setPermissionReviewer(async (event) => {
        seen.push(event.request.subject)
        return answer('allow')
      })
      const ctx = getDesktopSecurityContext({ sessionId, agentOf: () => WORK }, cfg)
      await ctx.enforceInvocation({ toolCallId: 'h11-53-l1', toolName: 'skill', ...owner })
      expect(seen).toStrictEqual([
        { kind: 'agent', sessionId, agentKind: 'root', profileName: 'work' }
      ])
    })

    // ─── P2-06：派生 agent（含 hook agent）的对话上，主体是它自己 ───

    const IDENTITIES: Record<number, ToolAgentIdentity> = {
      1: WORK,
      2: { profileName: 'explore', kind: 'spawned', callerId: 'sub-a1' },
      3: { profileName: 'permission-reviewer', kind: 'spawned', callerId: 'sub-r1' }
    }

    it.each(FAMILIES)(
      'P2-06-17 %s：对话 2 → spawned / explore，对话 1 → root / work（主体里从不带 callerId）',
      async (_label, call) => {
        tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
        const sessionId = sid('p2-06-17')
        const seen: SecuritySubject[] = []
        setPermissionReviewer(async (event) => {
          seen.push(event.request.subject)
          return answer('allow')
        })
        const agentOf = vi.fn((conversationId: number) => IDENTITIES[conversationId])
        const ctx = getDesktopSecurityContext({ sessionId, agentOf }, cfg)

        await call(ctx, 'p2-06-17-a', { taskId: 3, conversationId: 2 })
        await call(ctx, 'p2-06-17-b', { taskId: 3, conversationId: 1 })

        expect(seen).toStrictEqual([
          { kind: 'agent', sessionId, agentKind: 'spawned', profileName: 'explore' },
          { kind: 'agent', sessionId, agentKind: 'root', profileName: 'work' }
        ])
        expect(agentOf.mock.calls).toEqual([[2], [1]])
      }
    )

    it('P2-06-17 L1 门（enforceInvocation）在审查员的对话上：spawned / permission-reviewer', async () => {
      tc.userPolicies = [userPolicy('h11-always-ask.md', ALWAYS_ASK)]
      const sessionId = sid('p2-06-17-l1')
      const seen: SecuritySubject[] = []
      setPermissionReviewer(async (event) => {
        seen.push(event.request.subject)
        return answer('allow')
      })
      const ctx = getDesktopSecurityContext(
        { sessionId, agentOf: (conversationId) => IDENTITIES[conversationId] },
        cfg
      )
      await ctx.enforceInvocation({
        toolCallId: 'p2-06-17-l1',
        toolName: 'skill',
        taskId: 3,
        conversationId: 3
      })
      expect(seen).toStrictEqual([
        { kind: 'agent', sessionId, agentKind: 'spawned', profileName: 'permission-reviewer' }
      ])
    })
  })

  it('P2-06-18 派生主体驱动用户策略：同一个会话级门，对话 2（派生 explore）被拒、不问人也不审；对话 1 照常审查；evaluate 不按调用取主体', async () => {
    tc.userPolicies = [
      userPolicy(
        'no-spawned-explore-writes.md',
        [
          '---',
          'shuvix: policy v1',
          'name: no-spawned-explore-writes',
          'description: Spawned explore agents may not write files.',
          'shuvix-policy-scope:',
          '  subject.kind: [agent]',
          '  object.type: [path]',
          'shuvix-policy-rules:',
          '  - effect: deny',
          '    action: [write]',
          "    match: subject.profile == 'explore' && subject.agentKind == 'spawned'",
          '---',
          ''
        ].join('\n')
      )
    ]
    const sessionId = sid('p2-06-18')
    const EXPLORE: ToolAgentIdentity = {
      profileName: 'explore',
      kind: 'spawned',
      callerId: 'sub-a1'
    }
    const WORK: ToolAgentIdentity = { profileName: 'work', kind: 'root' }
    const seen: SecuritySubject[] = []
    const reviewer = vi.fn<Reviewer>(async (event) => {
      seen.push(event.request.subject)
      return answer('allow')
    })
    setPermissionReviewer(reviewer)
    const requestUserInput = vi.fn(async () => ({ kind: 'ask' as const, allowed: true }))
    const agentOf = vi.fn((conversationId: number) => (conversationId === 2 ? EXPLORE : WORK))
    const ctx = getDesktopSecurityContext({ sessionId, agentOf, requestUserInput }, cfg)

    await expect(
      ctx.enforcePath('write', OUTSIDE, { toolCallId: 'd-2', toolName: 'write', conversationId: 2 })
    ).rejects.toThrow()
    expect(reviewer).not.toHaveBeenCalled()
    expect(requestUserInput).not.toHaveBeenCalled()

    await expect(
      ctx.enforcePath('write', OUTSIDE, { toolCallId: 'd-1', toolName: 'write', conversationId: 1 })
    ).resolves.toBeUndefined()
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(seen).toStrictEqual([
      { kind: 'agent', sessionId, agentKind: 'root', profileName: 'work' }
    ])
    expect(requestUserInput).not.toHaveBeenCalled()

    // 被动判定按 ctx.agent（这里没有）取主体 = 根的缺省：ask-on-external-path，不问 agentOf
    const lookups = agentOf.mock.calls.length
    expect(verdictOf(ctx.evaluate('write', { type: 'path', path: OUTSIDE }))).toEqual({
      effect: 'ask',
      winning: 'ask-on-external-path#1'
    })
    expect(ctx.evaluateReadOnly('write', { type: 'path', path: OUTSIDE })).toBe(false)
    expect(agentOf.mock.calls.length).toBe(lookups)
  })
})

/**
 * H11-49（P1-11）—— withCallAgent 是纯函数：换上这次调用的 agent，别的什么都不动。
 */
describe('withCallAgent', () => {
  const identity = { profileName: 'work', kind: 'root' as const }
  const base = (): ToolContext => ({
    sessionId: 's1',
    requestUserInput: vi.fn(),
    emitChatEvent: vi.fn(),
    agentOf: vi.fn(() => identity)
  })

  it('H11-49 (a) 调用没给 → 原样交回', () => {
    const ctx = base()
    expect(withCallAgent(ctx, undefined)).toBe(ctx)
    expect(withCallAgent(ctx, {})).toBe(ctx)
    expect(ctx.agentOf).not.toHaveBeenCalled()
  })

  it('H11-49 (b) ctx 没有 agentOf → agent 不变', () => {
    const fixed = { profileName: 'coding', kind: 'spawned' as const }
    const ctx: ToolContext = { sessionId: 's1', agent: fixed }
    expect(withCallAgent(ctx, { conversationId: 1 }).agent).toBe(fixed)
  })

  it('H11-49 (c) 认出来了 → agent 是那份身份；sessionId / requestUserInput / emitChatEvent / agentOf 同一引用；入参不改', () => {
    const ctx = base()
    const snapshot = { ...ctx }
    const out = withCallAgent(ctx, { conversationId: 1 })
    expect(out.agent).toBe(identity)
    expect(out.sessionId).toBe(ctx.sessionId)
    expect(out.requestUserInput).toBe(ctx.requestUserInput)
    expect(out.emitChatEvent).toBe(ctx.emitChatEvent)
    expect(out.agentOf).toBe(ctx.agentOf)
    expect(ctx).toStrictEqual(snapshot)
    expect(ctx.agent).toBeUndefined()
  })

  it('H11-49 (d) agentOf 交回 undefined（或抛错）→ agent 是 ctx.agent', () => {
    const fixed = { profileName: 'coding', kind: 'spawned' as const }
    const none: ToolContext = { sessionId: 's1', agent: fixed, agentOf: () => undefined }
    expect(withCallAgent(none, { conversationId: 1 }).agent).toBe(fixed)
    const throwing: ToolContext = {
      sessionId: 's1',
      agentOf: () => {
        throw new Error('closed')
      }
    }
    expect(withCallAgent(throwing, { conversationId: 1 }).agent).toBeUndefined()
  })

  it('H11-49 (e) agentOf 收到的恰是 call.conversationId', () => {
    const ctx = base()
    withCallAgent(ctx, { conversationId: 7 })
    expect(ctx.agentOf).toHaveBeenCalledTimes(1)
    expect(ctx.agentOf).toHaveBeenCalledWith(7)
  })
})
