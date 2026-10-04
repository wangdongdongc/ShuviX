/**
 * 锁 · 工具（P1-09；裁决 K6–K8）：工具次序由锁拼（内置按归一名单 → agent → skill → MCP 逐台逐个），
 * 内置工具在 `shuvix.builtin`、按 agent 的在 `shuvix.agent.<对话>`；MCP 在创建那一刻惰性连接，连不上的
 * 不记；沙箱钉子来自解析结果，创建时据此重装 `shuvix.builtin`。
 */
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
import { registerHostCleanup } from './support/host'
import { extensionTools, piAgent, scenarioW } from './support/scenario'
import { holdTool } from './support/tools'
import { toolDeltaCount } from './support/transcript'

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

  it('LT-04 the skill tool lists the skills the agent was given and the lock records them; no skills → no skill tool', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    t.kit.queue(answer('ok'))
    await session.submitUser('hi')
    const skill = requestTools(t.kit, 0).find((tool) => tool.name === 'skill')!
    expect(skill.description).toContain('builtin:drawing')
    expect(skill.description).toContain('pdf')
    expect(session.lock!.skills).toEqual(['builtin:drawing', 'pdf'])

    const config = scenarioConfig()
    config.profile = {
      ...config.profile,
      tools: config.profile.tools.filter((name) => !name.startsWith('skill:'))
    }
    config.toolOverlay = ['mcp:ctx']
    const bare = await scenarioW({ config })
    const other = await bare.t.open()
    await other.createAgent()
    expect(other.lock!.skills).toEqual([])
    expect(other.lock!.toolNames).not.toContain('skill')
    expect(extensionTools(bare.t, 'shuvix.agent.1')).not.toContain('skill')
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
    config.toolOverlay = ['mcp:ctx', 'mcp:ssh', 'skill:pdf']
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

  it('LT-11 the sandbox pin: open installs the builtins unpinned, creation reinstalls them pinned; turn 1 carries exactly one tool delta', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    expect(t.toolHost.builtinCalls).toEqual([{ sessionId: 's1', sandboxed: undefined }])
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hi')).toEqual({})
    expect(t.toolHost.builtinCalls).toEqual([
      { sessionId: 's1', sandboxed: undefined },
      { sessionId: 's1', sandboxed: true }
    ])
    expect(session.lock!.sandboxed).toBe(true)
    const bash = requestTools(t.kit, 0).find((tool) => tool.name === 'bash')!
    expect(bash.description).toContain('sandboxed=true')
    expect(await toolDeltaCount(await session.currentConversation())).toBe(1)
  })
})
