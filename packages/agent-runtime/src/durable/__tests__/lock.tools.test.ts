/**
 * 锁 · 工具（P1-09；裁决 K6–K8）：工具次序由锁拼（内置按归一名单 → agent → skill → MCP 逐台逐个），
 * 内置工具在 `shuvix.builtin`、按 agent 的在 `shuvix.agent.<对话>`；MCP 在创建那一刻惰性连接，连不上的
 * 不记；沙箱钉子来自解析结果，创建时据此重装 `shuvix.builtin`；技能货架随内置工具的构造请求一起交给宿主
 * （货架空了也交 `[]`，LT-13 / WT4-DL-01）。
 *
 * 重新上锁的工具次序（2026-11-06）：对话里已经有模型见过的工具时，按它们的次序排（与重配同一条规则，
 * `orderForMinimalDiff`），没见过的照 K6 的次序跟在后面 ——
 *   LT-B1 见过 [c, a, b]、此刻拼出 [a, b, c, d] → 锁与请求都是 [c, a, b, d]
 *   LT-B2 新对话（新会话、回退到第一条消息）→ K6 的次序
 *   LT-B3 见过、但声明变了的工具排到没变的后面
 *   LT-B4 重配把次序弄成非 K6 的之后，重启 / 回退到后面的消息再发：下一次请求的工具与上一次逐个同名同序
 *   LT-B5 见过、但不再选中的工具不在；其余见过的保持相对次序
 */
import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { AgentCreationError, composeAgentTools } from '../lock'
import {
  DECL_DOCS,
  DECL_RESOLVE,
  E_W,
  scenarioConfig,
  scenarioToolHost
} from './support/agentConfig'
import { answer, requestTools } from './support/faux'
import { makeHost, registerHostCleanup, type TestHost } from './support/host'
import { forkedId } from './support/rollback'
import { extensionTools, piAgent, scenarioW } from './support/scenario'
import { holdTool } from './support/tools'
import { allEntries, systemDeltas, toolDeltaCount } from './support/transcript'
import type { DurableSession } from '../durableSession'

registerHostCleanup()

const names = (tools: readonly { name: string }[]): string[] => tools.map((tool) => tool.name)

describe('lock · tools', () => {
  it('LT-01 pi.agent.tools = lock.toolNames = request tools = E_W; on win32 powershell takes the shell slot', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(session.lock!.toolNames).toEqual(E_W)
    expect(await piAgent(session)).toMatchObject({ tools: E_W })
    expect(names(requestTools(t.kit, 0))).toEqual(E_W)

    const win = await scenarioW({ toolHost: scenarioToolHost({ platform: 'win32' }) })
    const other = await win.t.open()
    win.t.kit.queue(answer('ok'))
    expect(await other.submitUser('hi')).toEqual({})
    expect(other.lock!.toolNames).toEqual(['powershell', ...E_W.slice(1)])
    expect(names(requestTools(win.t.kit, 0))).toEqual(['powershell', ...E_W.slice(1)])
  })

  it('LT-02 an installed builtin the profile does not name (git) is not offered; a name with no builtin on this platform (powershell on darwin) is skipped silently', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    expect(extensionTools(t, 'shuvix.builtin')).toContain('git')
    expect(session.lock!.toolNames).not.toContain('git')
    expect(session.lock!.toolNames).not.toContain('powershell')
    expect(t.warnings).toEqual([])
  })

  it('LT-03 the agent extension holds [agent, skill, MCP…]; the builtins live in shuvix.builtin', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    expect(extensionTools(t, 'shuvix.agent.1')).toEqual([
      'agent',
      'skill',
      'mcp__ctx__resolve',
      'mcp__ctx__docs'
    ])
    expect(extensionTools(t, 'shuvix.builtin')).toEqual([
      'bash',
      'read',
      'ls',
      'grep',
      'glob',
      'write',
      'edit',
      'ask',
      'session',
      'knowledge',
      'artifact',
      'git'
    ])
  })

  it('LT-04 the skill tool lists every skill the host has enabled and the lock records them; no skill in the names or an empty shelf → no skill tool', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(answer('ok'))
    await session.submitUser('hi')
    // 档案只写 `skill`：货架是宿主启用着的全部技能，没有一本是点名来的
    expect(t.toolHost.resolveCalls[0]!.names.filter((name) => name.startsWith('skill'))).toEqual([
      'skill'
    ])
    const skill = requestTools(t.kit, 0).find((tool) => tool.name === 'skill')!
    expect(skill.description).toContain('builtin:drawing')
    expect(skill.description).toContain('pdf')
    expect(session.lock!.skills).toEqual(['builtin:drawing', 'pdf'])

    // 档案没带 skill：宿主有技能也不上架
    const config = scenarioConfig()
    config.profile = {
      ...config.profile,
      tools: config.profile.tools.filter((name) => name !== 'skill')
    }
    const bare = await scenarioW({ config })
    const other = await bare.t.open()
    await other.createAgent()
    expect(other.lock!.skills).toEqual([])
    expect(other.lock!.toolNames).not.toContain('skill')
    expect(extensionTools(bare.t, 'shuvix.agent.1')).not.toContain('skill')

    // 档案带 skill、宿主一本技能都没启用：货架空，也没有技能工具
    const empty = await scenarioW({ toolHost: scenarioToolHost({ skills: [] }) })
    const third = await empty.t.open()
    await third.createAgent()
    expect(third.lock!.skills).toEqual([])
    expect(third.lock!.toolNames).not.toContain('skill')
    expect(extensionTools(empty.t, 'shuvix.agent.1')).not.toContain('skill')
  })

  it('LT-05 the dispatch tool is there iff the normalized names contain agent', async () => {
    const config = scenarioConfig()
    config.profile = {
      ...config.profile,
      tools: config.profile.tools.filter((name) => name !== 'agent')
    }
    const { t } = await scenarioW({ config })
    const session = await t.open()
    await session.createAgent()
    expect(session.lock!.toolNames).not.toContain('agent')
    expect(extensionTools(t, 'shuvix.agent.1')).toEqual([
      'skill',
      'mcp__ctx__resolve',
      'mcp__ctx__docs'
    ])
  })

  it('LT-06 extra tools on a root lock are rejected (K6) — from the ToolHost or from createAgent()', async () => {
    const next = holdTool('next', Promise.resolve())
    const { t } = await scenarioW({ toolHost: scenarioToolHost({ extraTools: [next] }) })
    const session = await t.open()
    const result = await session.submitUser('hi')
    expect(result.error).toMatch(/extra tools/)
    expect(session.lock).toBeUndefined()
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
    await expect(session.createAgent()).rejects.toMatchObject({ code: 'extra_tools' })
    await expect(session.createAgent({ extraTools: [next] })).rejects.toBeInstanceOf(
      AgentCreationError
    )
    expect(t.kit.callCount).toBe(0)
  })

  it('LT-07 MCP connects lazily at creation; the lock keeps the declarations; two servers are ordered server by server, tool by tool', async () => {
    const config = scenarioConfig()
    config.toolOverlay = ['mcp:ctx', 'mcp:ssh']
    const { t } = await scenarioW({ config })
    const session = await t.open()
    expect(t.toolHost.mcp('ctx').connects).toBe(0)
    await session.createAgent()
    expect(t.toolHost.mcp('ctx').connects).toBe(1)
    expect(t.toolHost.mcp('ssh').connects).toBe(1)
    expect(session.lock!.mcp.ctx).toEqual([DECL_RESOLVE, DECL_DOCS])
    expect(Object.keys(session.lock!.mcp)).toEqual(['ctx', 'ssh'])
    expect(session.lock!.toolNames.slice(-3)).toEqual([
      'mcp__ctx__resolve',
      'mcp__ctx__docs',
      'mcp__ssh__exec'
    ])
  })

  it('LT-08 a server that fails to connect: the agent is still created without it; the ToolHost reported the failure before agent_created (K7)', async () => {
    const config = scenarioConfig()
    config.toolOverlay = ['mcp:broken', 'mcp:ctx']
    const { t } = await scenarioW({ config })
    t.toolHost.mcp('broken').failConnect('port in use')
    const session = await t.open()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(session.lock!.mcp).not.toHaveProperty('broken')
    expect(session.lock!.mcp.ctx).toEqual([DECL_RESOLVE, DECL_DOCS])
    expect(names(requestTools(t.kit, 0)).some((name) => name.startsWith('mcp__broken__'))).toBe(
      false
    )
    expect(names(requestTools(t.kit, 0))).toContain('mcp__ctx__docs')
    const errorIndex = t.broadcasts.findIndex(
      (event) => event.type === 'error' && event.error.includes('broken')
    )
    const createdIndex = t.broadcasts.findIndex((event) => event.type === 'agent_created')
    expect(errorIndex).toBeGreaterThanOrEqual(0)
    expect(createdIndex).toBeGreaterThan(errorIndex)
  })

  it('LT-09 a server the profile declares is connected and offered even when the overlay does not tick it', async () => {
    const config = scenarioConfig()
    config.profile = { ...config.profile, tools: [...config.profile.tools, 'mcp:ssh'] }
    config.toolOverlay = []
    const { t } = await scenarioW({ config })
    const session = await t.open()
    await session.createAgent()
    expect(t.toolHost.mcp('ssh').connects).toBe(1)
    expect(session.lock!.toolNames).toContain('mcp__ssh__exec')
    expect(t.toolHost.mcp('ctx').connects).toBe(0)
  })

  it('LT-10 a configured server nobody selected is never connected', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(answer('ok'))
    await session.submitUser('hi')
    expect(t.toolHost.mcp('other').connects).toBe(0)
    expect(t.toolHost.mcp('ssh').connects).toBe(0)
  })

  it('LT-12 composeAgentTools (pure): builtins in name order → agent → skill → MCP → host tools; extras are removed then appended, and win', () => {
    const tool = (name: string): ReturnType<typeof holdTool> => holdTool(name, Promise.resolve())
    const extraEdit = tool('edit')
    const composed = composeAgentTools({
      names: ['read', 'bash', 'agent', 'nope', 'edit', 'read'],
      builtin: [tool('bash'), tool('read'), tool('edit'), tool('git')],
      set: {
        agent: tool('agent'),
        skill: tool('skill'),
        mcp: [{ server: 'a', tools: [tool('mcp__a__x'), tool('mcp__a__x')] }],
        tools: [tool('probe')]
      },
      extraTools: [extraEdit, tool('probe')]
    })
    expect(composed.toolNames).toEqual([
      'read',
      'bash',
      'agent',
      'skill',
      'mcp__a__x',
      'edit',
      'probe'
    ])
    expect(names(composed.agentTools)).toEqual(['agent', 'skill', 'mcp__a__x', 'edit', 'probe'])
    expect(names(composed.tools)).toEqual(composed.toolNames)
    expect(composed.tools[5]).toBe(extraEdit)
  })

  it('LT-11 the sandbox pin: open builds no builtins (lazy, option A), creation installs them pinned; turn 1 carries exactly one tool delta', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    expect(t.toolHost.builtinCalls).toEqual([])
    expect(t.registryOf('s1')!.snapshot().extension('shuvix.builtin')).toBeUndefined()
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(t.toolHost.builtinCalls).toEqual([
      { sessionId: 's1', sandboxed: true, skills: ['builtin:drawing', 'pdf'] }
    ])
    expect(session.lock!.sandboxed).toBe(true)
    const bash = requestTools(t.kit, 0).find((tool) => tool.name === 'bash')!
    expect(bash.description).toContain('sandboxed=true')
    expect(await toolDeltaCount(await session.currentConversation())).toBe(1)
  })

  it('LT-13 (WT4-DL-01) a profile that shelves no skill: creation hands buildBuiltinTools `skills: []` — the key is there, not left out (left out means "no agent yet")', async () => {
    const config = scenarioConfig()
    config.profile = {
      ...config.profile,
      tools: config.profile.tools.filter((name) => name !== 'skill')
    }
    const { t } = await scenarioW({ config })
    const session = await t.open()
    await session.createAgent()
    expect(t.toolHost.builtinCalls).toHaveLength(1)
    expect(t.toolHost.builtinCalls[0]).toStrictEqual({
      sessionId: 's1',
      sandboxed: true,
      skills: []
    })
    expect(session.lock!.skills).toEqual([])
  })
})

/** 按 agent 的测试工具（描述可换：同名、声明不同） */
function plainTool(name: string, description = `${name} tool`): ToolRegistration {
  return defineTool({
    name,
    description,
    parameters: Type.Object({}),
    execute: async () => ({ output: [{ type: 'text', text: `${name} ok` }] })
  })
}

async function sendOne(t: TestHost, session: DurableSession, text: string): Promise<void> {
  t.kit.queue(answer(`re:${text}`))
  expect(await session.submitUser(text)).toEqual({})
}

const lastOffered = (t: TestHost): string[] => names(t.kit.requests.at(-1)!.tools)

describe('lock · tool order on re-lock (2026-11-06)', () => {
  it('LT-B1 the model saw [c, a, b]; the canonical order is now [a, b, c, d] → the lock, pi.agent and the request are [c, a, b, d]; only d is added', async () => {
    const tools = [plainTool('c'), plainTool('a'), plainTool('b')]
    const t = await makeHost({ tools })
    const session = await t.open()
    await sendOne(t, session, 'u1')
    expect(lastOffered(t)).toEqual(['c', 'a', 'b'])

    tools.splice(0, tools.length, tools[1]!, tools[2]!, tools[0]!, plainTool('d'))
    await session.destroyAgent()
    await sendOne(t, session, 'u2')
    expect(session.lock!.toolNames).toEqual(['c', 'a', 'b', 'd'])
    expect(await piAgent(session)).toMatchObject({ tools: ['c', 'a', 'b', 'd'] })
    expect(lastOffered(t)).toEqual(session.lock!.toolNames)
    const deltas = await systemDeltas(await session.currentConversation())
    expect(deltas.at(-1)).toMatchObject({ toolsAdded: ['d'], toolsRemoved: [] })
  })

  it('LT-B2 a fresh conversation keeps the K6 order: a new session, and a rollback to the first message', async () => {
    const tools = [plainTool('a'), plainTool('b'), plainTool('c'), plainTool('d')]
    const t = await makeHost({ tools })
    const fresh = await t.open('s2')
    await sendOne(t, fresh, 'hi')
    expect(fresh.lock!.toolNames).toEqual(['a', 'b', 'c', 'd'])
    expect(lastOffered(t)).toEqual(['a', 'b', 'c', 'd'])

    tools.splice(0, tools.length, tools[2]!, tools[0]!, tools[1]!)
    const session = await t.open('s1')
    await sendOne(t, session, 'u1')
    expect(lastOffered(t)).toEqual(['c', 'a', 'b'])
    tools.splice(0, tools.length, tools[1]!, tools[2]!, tools[0]!, plainTool('d'))
    const firstUser = (await allEntries(await session.currentConversation())).find(
      (entry) => entry.kind === 'pi.user'
    )!
    forkedId(await session.rollbackTo(firstUser.id as number))
    await sendOne(t, session, 'again')
    expect(session.lock!.toolNames).toEqual(['a', 'b', 'c', 'd'])
    expect(lastOffered(t)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('LT-B3 a seen tool whose declaration changed moves after the unchanged seen tools (same rule as orderForMinimalDiff)', async () => {
    const tools = [plainTool('a'), plainTool('b'), plainTool('c')]
    const t = await makeHost({ tools })
    const session = await t.open()
    await sendOne(t, session, 'u1')
    tools.splice(1, 1, plainTool('b', 'b tool, reworded'))
    await session.destroyAgent()
    await sendOne(t, session, 'u2')
    expect(session.lock!.toolNames).toEqual(['a', 'c', 'b'])
    expect(lastOffered(t)).toEqual(['a', 'c', 'b'])
    expect(t.kit.requests.at(-1)!.tools.find((tool) => tool.name === 'b')!.description).toBe(
      'b tool, reworded'
    )
  })

  it('LT-B5 a seen tool no longer selected is absent; the remaining seen tools keep their relative order', async () => {
    const tools = [plainTool('c'), plainTool('a'), plainTool('b'), plainTool('e')]
    const t = await makeHost({ tools })
    const session = await t.open()
    await sendOne(t, session, 'u1')
    tools.splice(0, tools.length, tools[2]!, tools[3]!, tools[1]!)
    await session.destroyAgent()
    await sendOne(t, session, 'u2')
    expect(session.lock!.toolNames).toEqual(['a', 'b', 'e'])
    expect(lastOffered(t)).toEqual(['a', 'b', 'e'])
  })

  it.each(['restart', 'rollback'] as const)(
    'LT-B4 a live reconfigure appended a server out of K6 order; after a %s the next request offers exactly the previous request’s tools, by name and order',
    async (how) => {
      const config = scenarioConfig()
      const { t } = await scenarioW({ config })
      const session = await t.open()
      await sendOne(t, session, 'u1')
      // 中途勾上 new，勾选里排在 ctx 前面：K6 会把它排在 ctx 前，重配把它追加在最后
      config.toolOverlay = ['mcp:new', 'mcp:ctx']
      expect((await session.reconfigureAgent()).applied).toBe(true)
      await sendOne(t, session, 'u2')
      await sendOne(t, session, 'u3')
      const previous = t.kit.requests.at(-1)!.tools.map((tool) => tool.name)
      expect(previous).toEqual([...E_W, 'mcp__new__fresh'])
      const previousTools = t.kit.requests.at(-1)!.tools

      // 对照：同一份设置的新会话是 K6 的次序（new 在 ctx 前）
      const canonical = await t.open('fresh')
      await canonical.createAgent()
      expect(canonical.lock!.toolNames).not.toEqual(previous)
      expect(canonical.lock!.toolNames.indexOf('mcp__new__fresh')).toBeLessThan(
        canonical.lock!.toolNames.indexOf('mcp__ctx__resolve')
      )

      let next: TestHost = t
      let target: DurableSession = session
      if (how === 'restart') {
        next = await t.restart()
        target = await next.open()
        expect(target.lock).toBeUndefined()
      } else {
        const users = (await allEntries(await session.currentConversation())).filter(
          (entry) => entry.kind === 'pi.user'
        )
        forkedId(await session.rollbackTo(users[2]!.id as number))
      }
      await sendOne(next, target, 'after')
      const request = next.kit.requests.at(-1)!
      expect(request.tools.map((tool) => tool.name)).toEqual(previous)
      expect(request.tools).toEqual(previousTools)
      expect(target.lock!.toolNames).toEqual(previous)
    },
    20000
  )
})
