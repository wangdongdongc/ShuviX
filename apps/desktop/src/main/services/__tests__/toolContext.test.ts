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
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

const tc = vi.hoisted(() => ({
  getById: vi.fn((_id: string): unknown => undefined),
  projectPick: vi.fn((_id: string, _cols: string[]): unknown => undefined),
  pickSettings: vi.fn((_id: string, _keys: string[]): unknown => undefined),
  getTempWorkspace: vi.fn((_sid: string) => '/tmp/shuvix-actor-ws'),
  getSessionArtifactsDir: vi.fn((id: string) => `/tmp/shuvix-artifacts/${id}`)
}))

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: tc.projectPick } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: tc.pickSettings } }))
// 真实模块 + sessionView 换成透传 spy：不改行为，只多一个观测点（与可按用例替换的返回值）
vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  return { ...actual, sessionView: vi.fn(actual.sessionView) }
})
vi.mock('../sessionService', () => ({
  sessionService: { getById: tc.getById, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({ skillService: { listExternalDirs: () => [] } }))
vi.mock('../policyService', () => ({ policyService: { getUserPolicies: () => [] } }))
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
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import {
  agentActorOf,
  getSessionPathGrants,
  makeDesktopSecurityProvider,
  resolveProjectConfig
} from '../toolContext'
import { sessionView } from '../sandbox'

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

  // sessionArtifactsDir —— ask-on-write / ask-on-read 对它免询问（本会话认领下来的图与交互块）。
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

describe('HG-1 getVars —— 展开 sandbox.sessionView 的六个键', () => {
  const SANDBOX_KEYS = [
    'sandboxActive',
    'sandboxWritableRoots',
    'sandboxWriteDenied',
    'sandboxProtectedPatterns',
    'sandboxReadDenied',
    'sandboxReadAllowed'
  ] as const

  const pickSandboxKeys = (vars: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(SANDBOX_KEYS.filter((k) => k in vars).map((k) => [k, vars[k]]))

  const sessionViewSpy = vi.mocked(sessionView)

  beforeEach(() => {
    sessionViewSpy.mockClear()
    tc.getById.mockReset()
    tc.projectPick.mockReset()
  })

  it('HG-1 sandbox 模块给什么，六个键就是什么；按 ctx.sessionId 与 getConfig() 的工作区去取', () => {
    const fake = {
      sandboxActive: true,
      sandboxWritableRoots: ['/ws', '/private/tmp/shuvix-501/abcd1234'],
      sandboxWriteDenied: ['/ws/.git/hooks'],
      sandboxProtectedPatterns: ['**/.git/config'],
      sandboxReadDenied: ['/Users/u/.ssh'],
      sandboxReadAllowed: ['/Users/u/.shuvix/cli-token']
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

  it('HG-1 真实 sandbox 模块、会话未固定 → 六个键都在且全是「未启用」的值（不去碰 electron app）', () => {
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
      sandboxProtectedPatterns: [],
      sandboxReadDenied: [],
      sandboxReadAllowed: []
    })
    // 六个键一个不少：策略的 vars.sandbox* 指向未设变量会走 fail-safe 并刷告警
    for (const key of SANDBOX_KEYS) expect(vars, key).toHaveProperty(key)
  })
})
