/**
 * SpawnCoordinator · 深度与 canSpawn（P2-03，B 段 12–16）：深度按调用方对话的 `AgentStateDoc.depth`
 * （宽松读）+1；超限按旧文案拒绝；`canSpawn = depth < max` 决定给不给 `agent`。
 */
import {
  AgentDoc,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { AgentStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import type { SpawnOutcome } from '../spawn'
import { answer, callTool } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  callAgent,
  childOf,
  conversationIds,
  dispatch,
  dispatchTask,
  hostD,
  PROFILES,
  type HostD
} from './support/spawn'
import { transcript } from './support/transcript'

registerHostCleanup()

const depthText = (max: number, depth: number): string =>
  `Agent depth limit reached (max ${max}): this agent is already at depth ${depth} and cannot spawn further agents. Complete the task directly instead.`

/** 宿主 D + 一份不受 canSpawn 门控的 `force_agent`（结果推进 `forced`） */
async function forceHost(
  extra: Parameters<typeof hostD>[0] = {}
): Promise<HostD & { forced: SpawnOutcome[] }> {
  const forced: SpawnOutcome[] = []
  const d = await hostD({
    ...extra,
    tools: (getSession: () => DurableSession): ToolRegistration[] => [
      dispatch({ getSession, profiles: PROFILES, outcomes: forced, name: 'force_agent' })
    ]
  })
  return { ...d, forced }
}

const force = (prompt: string, id = 'call-force'): ReturnType<typeof callTool> =>
  callTool('force_agent', { name: 'explore', prompt, description: 'deep' }, id)

function offered(d: HostD, n: number): string[] {
  return d.t.kit.requests[n]!.tools.map((tool) => tool.name)
}

describe('SpawnCoordinator · depth', () => {
  it('P2-03-12 root caller: depth 1, canSpawn true, the child is offered agent', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('nester', 'mid'), answer('mid done'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const record = await spawnedAgentRecordOf(d.session.harness, C, BG)
    expect(record).toMatchObject({ depth: 1, canSpawn: true })
    expect(d.t.toolHost.resolveCalls.at(-1)!.canSpawn).toBe(true)
    expect(offered(d, 1)).toContain('agent')
  })

  it('P2-03-13 nested: C (nester) spawns G at depth 2 without agent; answers bubble up', async () => {
    const d = await hostD()
    d.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('nester', 'leaf', { id: 'call-g' }),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const [gOutcome, cOutcome] = d.outcomes
    const C = cOutcome!.conversationId!
    const G = gOutcome!.conversationId!
    const cTask = await dispatchTask(d.session, 'call-g', C)
    const record = await spawnedAgentRecordOf(d.session.harness, G, BG)
    expect(record).toMatchObject({
      depth: 2,
      canSpawn: false,
      parentConversationId: C,
      ownerTaskId: cTask
    })
    expect(d.t.toolHost.resolveCalls.at(-1)!.canSpawn).toBe(false)
    expect(offered(d, 2)).not.toContain('agent')
    expect(gOutcome!.result).toBe('leaf done')
    expect(cOutcome!.result).toBe('mid done')
    expect(await conversationIds(d.session)).toHaveLength(3)
    expect(await childOf(d.session, await dispatchTask(d.session))).toEqual([C])
    expect(await childOf(d.session, cTask)).toEqual([G])
    const child = (await d.session.harness.conversation(C, BG))!
    expect(await transcript(child)).toContain('pi.tool-result:leaf done')
  })

  it('P2-03-14 depth limit: G (depth 2) calling force_agent is refused with the old text', async () => {
    const d = await forceHost()
    d.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('nester', 'leaf', { id: 'call-g' }),
      force('deep'),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    const resolves = (): number => d.t.toolHost.resolveCalls.length
    let atG = 0
    let varsAtG = 0
    d.t.toolHost.beforeResolve = () => {
      atG = resolves()
      varsAtG = d.vars.state.calls
    }
    expect(await d.session.submitUser('go')).toEqual({})
    const text = depthText(2, 2)
    expect(d.forced).toEqual([{ result: text, error: text }])
    expect(await conversationIds(d.session)).toHaveLength(3)
    // G 的那次解析之后没有再解析、没有再算变量表
    expect(resolves()).toBe(atG)
    expect(d.vars.state.calls).toBe(varsAtG + 1)
  })

  it('P2-03-15 maxAgentDepth 1: the child cannot spawn; its force_agent gets the (max 1) text', async () => {
    const d = await forceHost({ host: { maxAgentDepth: 1 } })
    d.t.kit.queue(callAgent('nester', 'mid'), force('deep'), answer('mid done'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const record = await spawnedAgentRecordOf(d.session.harness, d.outcomes[0]!.conversationId!, BG)
    expect(record).toMatchObject({ depth: 1, canSpawn: false })
    expect(offered(d, 1)).not.toContain('agent')
    const text = depthText(1, 1)
    expect(d.forced).toEqual([{ result: text, error: text }])
  })

  it('P2-03-15 maxAgentDepth 3: G can spawn and is offered agent', async () => {
    const d = await hostD({ host: { maxAgentDepth: 3 } })
    d.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('nester', 'leaf', { id: 'call-g' }),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const G = d.outcomes[0]!.conversationId!
    expect(await spawnedAgentRecordOf(d.session.harness, G, BG)).toMatchObject({
      depth: 2,
      canSpawn: true
    })
    expect(offered(d, 2)).toContain('agent')
  })

  /** 一个 ownerless 的旁支对话：模型 faux-1、选中根的扩展（带 force_agent） */
  async function sideConversation(d: HostD): Promise<ConversationId> {
    const registry = d.t.registryOf('s1')!.snapshot()
    const side = await d.session.harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          model: { provider: 'faux', modelId: 'faux-1' },
          extensions: [
            registry.extension('shuvix.builtin')!,
            registry.extension('shuvix.agent.1')!
          ],
          tools: null
        }
      },
      BG
    )
    return side.id
  }

  it('P2-03-16 caller depth from an ownerless side conversation with an empty AgentStateDoc → depth 1', async () => {
    const d = await forceHost()
    const side = await sideConversation(d)
    d.t.kit.queue(force('deep'), answer('deep done'), answer('side done'))
    const conversation = (await d.session.harness.conversation(side, BG))!
    await (await conversation.submit({ type: 'input', content: 'go' }, BG)).wait(BG)
    const outcome = d.forced[0]!
    expect(outcome.error).toBeUndefined()
    const record = await spawnedAgentRecordOf(d.session.harness, outcome.conversationId!, BG)
    expect(record).toMatchObject({ depth: 1, parentConversationId: side })
  })

  it('P2-03-16 caller depth is read leniently: depth 2 with a malformed record is refused', async () => {
    const d = await forceHost()
    const side = await sideConversation(d)
    await d.session.harness.commit(async (tx) => {
      const state = await tx.doc(AgentStateDoc, side)
      state.kind = 'spawned'
      state.profileName = 'explore'
      state.depth = 2
      state.agentId = 'sub-x'
    }, BG)
    d.t.kit.queue(force('deep'), answer('side done'))
    const conversation = (await d.session.harness.conversation(side, BG))!
    await (await conversation.submit({ type: 'input', content: 'go' }, BG)).wait(BG)
    const text = depthText(2, 2)
    expect(d.forced).toEqual([{ result: text, error: text }])
    expect(await conversationIds(d.session)).toEqual([ROOT_CONVERSATION_ID, side])
    expect(await d.session.harness.snapshot(AgentDoc, side, BG)).toBeDefined()
  })
})
