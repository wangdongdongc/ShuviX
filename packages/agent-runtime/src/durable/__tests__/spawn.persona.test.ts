/**
 * SpawnCoordinator · 人设冻结（P2-03，D 段 24–27）：派生人设在创建提交里冻结（渲染块的上下文按 agentId、cwd 为空，
 * Q-P2-13）；活段落按子对话自己的 AgentStateDoc（根会话 id）解析；根一概不受影响。
 *
 *   PK-A13（2026-11-06 人设沿用）：派生 agent 不写 personaKey、每次派生都渲染提示词块；根的摘要不受影响
 *   FRZ-16（2026-11-06 系统提示词冻结）：派生 agent 的文档没有 sections / personaKey，它的段落照旧现解析（来源改了，
 *          下一次请求就是新的）；根的文档不受影响
 */
import type { PromptBlocksCtx } from '../../agentProfile/promptBlocks'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { parseSpawnedAgentRecord } from '../agentRecord'
import { AgentStateDoc } from '../docs'
import type { PromptHost } from '../seams'
import { markerPersona, markerVars, type MarkerVars } from './support/agentConfig'
import { answer } from './support/faux'
import { registerHostCleanup } from './support/host'
import { callAgent, hostD } from './support/spawn'
import { systemDeltas } from './support/transcript'

registerHostCleanup()

/** marker 提示词块，外加记下每次的上下文 */
function recordingVars(contexts: PromptBlocksCtx[]): MarkerVars {
  const base = markerVars('M1')
  return {
    state: base.state,
    promptBlocks: ((ctx: PromptBlocksCtx) => {
      contexts.push(ctx)
      return base.promptBlocks()
    }) as unknown as MarkerVars['promptBlocks']
  }
}

describe('SpawnCoordinator · persona', () => {
  it('P2-03-24 frozen fields and the promptBlocks context (sessionId = agentId, cwd "", rootSessionId = root)', async () => {
    const contexts: PromptBlocksCtx[] = []
    const d = await hostD({ vars: recordingVars(contexts) })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const { conversationId: C, agentId } = d.outcomes[0]!
    expect(await d.session.harness.snapshot(AgentStateDoc, C!, BG)).toMatchObject({
      kind: 'spawned',
      profileName: 'explore',
      rootSessionId: 's1',
      persona: markerPersona('M1', 'You are explorer'),
      promptBlocks: ['environment']
    })
    // rootSessionId = 根会话（ENV-12）：宿主据它给派生 agent 查工作目录与项目
    expect(contexts.at(-1)).toEqual({
      sessionId: agentId,
      rootSessionId: 's1',
      kind: 'spawned',
      cwd: '',
      toolNames: ['probe']
    })
  })

  it('P2-03-25 frozen at creation: a later marker change does not reach a continue; root is byte-identical', async () => {
    const d = await hostD()
    const callsBefore = d.vars.state.calls
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.vars.state.calls).toBe(callsBefore + 1)
    const C = d.outcomes[0]!.conversationId!
    d.vars.state.marker = 'M2'
    d.t.kit.queue(answer('again ok'))
    expect(await d.session.agents.continue(C, 'again')).toMatchObject({ result: 'again ok' })
    expect(d.vars.state.calls).toBe(callsBefore + 1)
    const last = d.t.kit.requests.at(-1)!
    expect(last.systemPrompt).toContain('M1')
    expect(last.systemPrompt).not.toContain('M2')
    // 根：派发前后两次请求的系统提示词逐字节相同，派发不给根带来 pi.system 增量
    expect(d.t.kit.requests[2]!.systemPrompt).toBe(d.t.kit.requests[0]!.systemPrompt)
    expect(await systemDeltas(await d.session.currentConversation())).toHaveLength(1)
  })

  it('P2-03-26 live sections per conversation: resolved for the root session, in golden order', async () => {
    const calls: Record<string, unknown[][]> = {}
    const note = (name: string, args: unknown[]): void => {
      ;(calls[name] ??= []).push(args)
    }
    const promptHost: PromptHost = {
      resolveInstruction: (sessionId, cwd, candidates) => {
        note('resolveInstruction', [sessionId, cwd, [...candidates]])
        return { filename: 'AGENTS.md', content: 'INSTRUCTION BODY' }
      },
      resolveProjectPrompt: (sessionId) => {
        note('resolveProjectPrompt', [sessionId])
        return 'PROJECT BODY'
      },
      resolveKnowledgeBases: (sessionId) => {
        note('resolveKnowledgeBases', [sessionId])
        return 'KNOWLEDGE BODY'
      }
    }
    const d = await hostD({ host: { promptHost } })
    d.t.kit.queue(callAgent('aware', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(calls.resolveInstruction).toContainEqual(['s1', '', ['AGENTS.md']])
    expect(calls.resolveProjectPrompt).toContainEqual(['s1'])
    expect(calls.resolveKnowledgeBases).toContainEqual(['s1'])
    const child = d.t.kit.requests[1]!.systemPrompt
    const order = [
      markerPersona('M1', 'You are aware'),
      'INSTRUCTION BODY',
      'PROJECT BODY',
      'KNOWLEDGE BODY'
    ].map((text) => child.indexOf(text))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // 根的档案不声明这些：根的请求里一段都没有
    for (const request of [d.t.kit.requests[0]!, d.t.kit.requests[2]!]) {
      expect(request.systemPrompt).not.toContain('INSTRUCTION BODY')
      expect(request.systemPrompt).not.toContain('PROJECT BODY')
    }
  })

  it('P2-03-27 no leak to root: the root AgentStateDoc is unchanged and carries no spawned record', async () => {
    const d = await hostD()
    const before = await d.session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const after = await d.session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    expect(after).toEqual(before)
    expect(after).toEqual({
      kind: 'root',
      profileName: 'work',
      rootSessionId: 's1',
      persona: '',
      promptBlocks: [],
      personaKey: expect.stringMatching(/^v2:/),
      // 其余段落冻结在这里（2026-11-06）：宿主 D 的 work 档案只选人设 → 没有别的段落
      sections: {}
    })
    expect(parseSpawnedAgentRecord(after)).toBeUndefined()
  })

  it('PK-A13 spawned agents write no personaKey and ask promptBlocks on every spawn; the root key is untouched', async () => {
    const d = await hostD()
    d.t.kit.queue(answer('warm'))
    expect(await d.session.submitUser('hello')).toEqual({})
    const rootBefore = await d.session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    expect(rootBefore?.personaKey).toMatch(/^v2:/)
    const callsBefore = d.vars.state.calls

    d.t.kit.queue(
      callAgent('explore', 'find X'),
      answer('found X'),
      callAgent('explore', 'find Y', { id: 'call-agent-2' }),
      answer('found Y'),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes).toHaveLength(2)
    expect(d.vars.state.calls).toBe(callsBefore + 2)
    for (const outcome of d.outcomes) {
      const child = await d.session.harness.snapshot(AgentStateDoc, outcome.conversationId!, BG)
      expect(child?.kind).toBe('spawned')
      expect(child?.persona).toBe(markerPersona('M1', 'You are explorer'))
      expect(child).not.toHaveProperty('personaKey')
      expect(child).not.toHaveProperty('sections')
    }
    expect(await d.session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)).toEqual(
      rootBefore
    )
  })

  it('FRZ-16 a spawned agent freezes no sections: its document has neither sections nor personaKey, its sections stay live, the root document is untouched', async () => {
    const values = { project: 'PROJECT V1' }
    const calls: string[] = []
    const promptHost: PromptHost = {
      resolveInstruction: () => ({ filename: 'AGENTS.md', content: 'INSTRUCTION BODY' }),
      resolveProjectPrompt: (sessionId) => {
        calls.push(sessionId)
        return values.project
      },
      resolveKnowledgeBases: () => 'KNOWLEDGE BODY'
    }
    const d = await hostD({ host: { promptHost } })
    const rootBefore = await d.session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)
    d.t.kit.queue(callAgent('aware', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const child = await d.session.harness.snapshot(AgentStateDoc, C, BG)
    expect(child?.kind).toBe('spawned')
    expect(child).not.toHaveProperty('sections')
    expect(child).not.toHaveProperty('personaKey')
    expect(d.t.kit.requests[1]!.systemPrompt).toContain('PROJECT V1')

    values.project = 'PROJECT V2'
    const before = calls.length
    d.t.kit.queue(answer('again ok'))
    expect(await d.session.agents.continue(C, 'again')).toMatchObject({ result: 'again ok' })
    expect(calls.length).toBeGreaterThan(before)
    expect(calls.every((sessionId) => sessionId === 's1')).toBe(true)
    expect(d.t.kit.requests.at(-1)!.systemPrompt).toContain('PROJECT V2')
    expect(await d.session.harness.snapshot(AgentStateDoc, ROOT_CONVERSATION_ID, BG)).toEqual(
      rootBefore
    )
  })
})
