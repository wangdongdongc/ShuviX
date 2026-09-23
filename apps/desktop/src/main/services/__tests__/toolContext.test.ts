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
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'

const tc = vi.hoisted(() => ({
  getById: vi.fn((_id: string): unknown => undefined),
  projectPick: vi.fn((_id: string, _cols: string[]): unknown => undefined),
  getTempWorkspace: vi.fn((_sid: string) => '/tmp/shuvix-actor-ws')
}))

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: tc.projectPick } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: () => undefined } }))
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
  getBuiltinKnowledgeDir: () => '/tmp/shuvix-builtin-knowledge',
  getShuvixKnowledgeRootDir: () => '/tmp/shuvix-knowledge-shuvix'
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { agentActorOf, makeDesktopSecurityProvider, resolveProjectConfig } from '../toolContext'

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
  const vars = (): Record<string, string | string[]> =>
    makeDesktopSecurityProvider(
      { sessionId: 's1', requestUserInput: undefined },
      () => ({ workingDirectory: '/ws' }) as never
    ).getVars() as Record<string, string | string[]>

  it('SEC-6 botsDir 由 getDefaultBotsDir() 填 —— protect-bot-files 指的就是它', () => {
    // 漏填 botsDir 的后果是那份策略静默失效，而它守的是「bot 改写自己那份文件」这条会话中途、
    // 没人看着的写入
    expect(vars().botsDir).toBe('/tmp/shuvix-bots')
    // 工作区来自 getConfig()（每次评估现读），不是构造时的快照
    expect(vars().workspace).toBe('/ws')
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
