/**
 * 自动脱敏出口的策略判定（services/redactionPolicy.ts，docs/auto-redaction-design.md §3.2）：真的安全模块 + 内置策略
 * （redact-sensitive）+ 用户策略。
 *
 *   RP-1 只有内置：适用脱敏；EMAIL 等保持占位符，USERNAME / HOSTNAME / IP / BUCKET 照发
 *   RP-2 provider 是设置里显示的名字：内置服务商 = slug，自定义服务商 = 用户起的名字；信任它的 force-allow 让请求不适用脱敏
 *   RP-3 第二层的用户策略：某一类照发、按值放行测试 key、某一类绝不发
 *   RP-4 第一层 deny：整个请求不发
 *   RP-5 主体：有对话时按它认 agent，没有就按根 agent
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  AgentIdentity,
  EgressDecision,
  ProviderRow,
  UserPolicyFile
} from '@shuvix/agent-runtime'
import { parsePolicyDefinitionFile } from '@shuvix/agent-runtime'

const state = vi.hoisted(() => ({
  userPolicies: [] as UserPolicyFile[],
  contexts: [] as Array<{ sessionId: string; agent?: { kind: string; profileName?: string } }>,
  providers: [] as Array<Pick<ProviderRow, 'id' | 'name' | 'isBuiltin'>>
}))

vi.mock('../toolContext', async () => {
  const { createSecurityContext } = await import('@shuvix/agent-runtime')
  const { createInlinePolicyMdReader } =
    await import('@shuvix/agent-runtime/security/builtinPolicies/inlineSources')
  const reader = createInlinePolicyMdReader()
  return {
    getDesktopSecurityContext: (ctx: {
      sessionId: string
      agent?: { kind: 'root' | 'spawned'; profileName?: string }
    }) => {
      state.contexts.push(ctx)
      return createSecurityContext(
        {
          kind: 'agent',
          sessionId: ctx.sessionId,
          agentKind: ctx.agent?.kind ?? 'root',
          ...(ctx.agent?.profileName ? { profileName: ctx.agent.profileName } : {})
        },
        { host: 'desktop' },
        {
          host: 'desktop',
          pathSep: '/',
          getVars: () => ({}),
          readBuiltinPolicyMd: reader,
          getUserPolicies: () => state.userPolicies
        }
      )
    }
  }
})

vi.mock('../models/providerCredentialPort', () => ({
  providerCredentialPort: { listProviders: () => state.providers }
}))

const { desktopRedactionPolicy } = await import('../redactionPolicy')

const userPolicy = (rules: string, name = 'mine'): UserPolicyFile => {
  const parsed = parsePolicyDefinitionFile(
    `---\nshuvix: policy v1\nname: ${name}\nshuvix-policy-rules:\n${rules}\n---\n`,
    name
  )
  expect(parsed, rules).not.toBeNull()
  return { ...parsed!, fileName: `${name}.md` }
}

const noAgent = (): AgentIdentity | undefined => undefined

function judge(provider = 'anthropic', model = 'claude-x'): EgressDecision {
  return desktopRedactionPolicy({ sessionId: 's1', provider, model }, noAgent)
}

const item = (
  category: string,
  value = 'v-1234567890'
): { category: string; rule: string; value: string } => ({ category, rule: 'r', value })

function reset(policies: UserPolicyFile[] = []): void {
  state.userPolicies = policies
  state.contexts = []
  state.providers = [
    { id: 'row-anthropic', name: 'Anthropic', isBuiltin: true },
    { id: 'row-home', name: 'home-server', isBuiltin: false }
  ]
}

describe('自动脱敏的策略判定', () => {
  it('RP-1 只有内置：适用脱敏；四类照发，其余保持占位符', () => {
    reset()
    const decision = judge()
    expect(decision.blocked).toBeUndefined()
    expect(decision.applies).toBe(true)
    for (const category of ['API_KEY', 'SECRET', 'EMAIL', 'PHONE', 'PRIVATE_KEY']) {
      expect(decision.disclose(item(category)), category).toBe('redact')
    }
    for (const category of ['USERNAME', 'HOSTNAME', 'IP', 'BUCKET']) {
      expect(decision.disclose(item(category)), category).toBe('send')
    }
  })

  it('RP-2 provider 按设置里显示的名字认；信任它的 force-allow 让请求不适用脱敏', () => {
    reset([
      userPolicy(`  - effect: force-allow
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.provider == 'home-server'"`)
    ])
    // 自定义服务商在 pi 里的 id 是行 id
    expect(judge('row-home').applies).toBe(false)
    expect(judge('anthropic').applies).toBe(true)
    // 认不出的 provider 原样交给策略
    expect(judge('home-server').applies).toBe(false)
  })

  it('RP-3 第二层：某一类照发、测试 key 照发、某一类绝不发', () => {
    reset([
      userPolicy(`  - effect: force-allow
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'EMAIL' || object.value.startsWith('sk-test-')"
  - effect: deny
    subject.kind: [agent]
    action: [disclose]
    object.type: [sensitive]
    match: "object.category == 'PRIVATE_KEY'"`)
    ])
    const decision = judge()
    expect(decision.disclose(item('EMAIL', 'alice.wong@acme-corp.cn'))).toBe('send')
    expect(decision.disclose(item('API_KEY', 'sk-test-0123456789abcdef'))).toBe('send')
    expect(decision.disclose(item('API_KEY', 'sk-live-0123456789abcdef'))).toBe('redact')
    expect(decision.disclose(item('PRIVATE_KEY'))).toBe('block')
  })

  it('RP-4 第一层 deny：整个请求不发', () => {
    reset([
      userPolicy(`  - effect: deny
    subject.kind: [agent]
    action: [send]
    object.type: [modelRequest]
    match: "object.model == 'claude-x'"`)
    ])
    expect(judge('anthropic', 'claude-x').blocked).toBe(true)
    expect(judge('anthropic', 'claude-y').blocked).toBeUndefined()
  })

  it('RP-5 主体：有对话时按它认 agent，没有就按根 agent', () => {
    reset()
    const asked: Array<[string, number]> = []
    const agentOf = (sessionId: string, conversationId: number): AgentIdentity => {
      asked.push([sessionId, conversationId])
      return { kind: 'spawned', profileName: 'explorer' } as AgentIdentity
    }
    desktopRedactionPolicy(
      { sessionId: 's1', conversationId: 7, provider: 'anthropic', model: 'm' },
      agentOf
    )
    desktopRedactionPolicy({ sessionId: 's1', provider: 'anthropic', model: 'm' }, agentOf)
    expect(asked).toEqual([['s1', 7]])
    expect(state.contexts.map((ctx) => ctx.agent?.kind)).toEqual(['spawned', undefined])
  })
})
