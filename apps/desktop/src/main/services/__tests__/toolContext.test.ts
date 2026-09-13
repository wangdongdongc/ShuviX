/**
 * toolContext —— agentActorOf：本工具实例所属 agent 的 OKF actor 字符串
 * （`shuvix-<profile>/<model>`）。模型惰性取（会话中途换模型也跟得上）；元数据缺失时回落
 * `shuvix-agent/unknown` —— 章要盖，但不能编。dao / 服务 / paths 全部 mock（同 askPolicy.test）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../dao/projectDao', () => ({ projectDao: { pick: () => undefined } }))
vi.mock('../../dao/sessionDao', () => ({ sessionDao: { pickSettings: () => undefined } }))
vi.mock('../sessionService', () => ({
  sessionService: { getById: () => undefined, addAllowListPaths: () => {} }
}))
vi.mock('../skillService', () => ({ skillService: { listExternalDirs: () => [] } }))
vi.mock('../policyService', () => ({ policyService: { getUserPolicies: () => [] } }))
vi.mock('../../utils/paths', () => ({
  getTempWorkspace: () => '/tmp/shuvix-actor-ws',
  getToolResultsBase: () => '/tmp/shuvix-actor-tool-results',
  getDefaultSkillsDir: () => '/tmp/shuvix-actor-skills',
  getBuiltinSkillsDir: () => '/tmp/shuvix-actor-builtin-skills',
  getMemoryRootDir: () => '/tmp/shuvix-actor-memory',
  getDefaultBotsDir: () => '/tmp/shuvix-bots',
  getShuvixKnowledgeRootDir: () => '/tmp/shuvix-knowledge-shuvix'
}))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} })
}))

import { agentActorOf, makeDesktopSecurityProvider } from '../toolContext'

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
