/**
 * SpawnCoordinator · 人设冻结（P2-03，D 段 24–27）：派生人设在创建提交里冻结（变量表按 agentId、cwd 为空，
 * Q-P2-13）；活段落按子对话自己的 AgentStateDoc（根会话 id）解析；根一概不受影响。
 */
import type { PromptVarsCtx } from '../../agentProfile/promptVars'
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { parseSpawnedAgentRecord } from '../agentRecord'
import { AgentStateDoc } from '../docs'
import type { PromptHost } from '../seams'
import { markerVars, type MarkerVars } from './support/agentConfig'
import { answer } from './support/faux'
import { registerHostCleanup } from './support/host'
import { callAgent, hostD } from './support/spawn'
import { systemDeltas } from './support/transcript'

registerHostCleanup()

/** marker 变量表，外加记下每次的上下文 */
function recordingVars(contexts: PromptVarsCtx[]): MarkerVars {
  const base = markerVars('M1')
  return {
    state: base.state,
    promptVars: ((ctx: PromptVarsCtx) => {
      contexts.push(ctx)
      return base.promptVars()
    }) as unknown as MarkerVars['promptVars']
  }
}

describe('SpawnCoordinator · persona', () => {
  it('P2-03-24 frozen fields and the promptVars context (sessionId = agentId, cwd "")', async () => {
    const contexts: PromptVarsCtx[] = []
    const d = await hostD({ vars: recordingVars(contexts) })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const { conversationId: C, agentId } = d.outcomes[0]!
    expect(await d.session.harness.snapshot(AgentStateDoc, C!, BG)).toMatchObject({
      kind: 'spawned',
      profileName: 'explore',
      rootSessionId: 's1',
      persona: 'You are M1 explorer',
      instructionFiles: []
    })
    expect(contexts.at(-1)).toEqual({
      sessionId: agentId,
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
      },
      resolveProjectMemory: (sessionId) => {
        note('resolveProjectMemory', [sessionId])
        return 'MEMORY BODY'
      }
    }
    const d = await hostD({ host: { promptHost } })
    d.t.kit.queue(callAgent('aware', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(calls.resolveInstruction).toContainEqual(['s1', '', ['AGENTS.md']])
    expect(calls.resolveProjectPrompt).toContainEqual(['s1'])
    expect(calls.resolveKnowledgeBases).toContainEqual(['s1'])
    expect(calls.resolveProjectMemory).toContainEqual(['s1'])
    const child = d.t.kit.requests[1]!.systemPrompt
    const order = [
      'You are M1 aware',
      'INSTRUCTION BODY',
      'PROJECT BODY',
      'KNOWLEDGE BODY',
      'MEMORY BODY'
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
      instructionFiles: []
    })
    expect(parseSpawnedAgentRecord(after)).toBeUndefined()
  })
})
