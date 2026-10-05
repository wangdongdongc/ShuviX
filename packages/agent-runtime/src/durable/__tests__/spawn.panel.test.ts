/**
 * SpawnCoordinator · 面板：软停止 / 销毁 / 追问（P2-03，H 段 42–49）。软停止 = 中止子对话、保留部分结果；
 * 销毁 = 硬中止 + 卸掉扩展（转写、记录、身份都留着，PIN-03）；追问 = 没有 requestId、忙就拒绝（PIN-12）。
 */
import { fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { ConversationId, SubmissionRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { AgentStateDoc } from '../docs'
import { answer, assistantWith, callTool, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools } from './support/scenario'
import { callAgent, firstChild, hostD, liveTasks, tasksOf, type HostD } from './support/spawn'
import { askingTool } from './support/tools'
import { transcript } from './support/transcript'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

/** 一次派发跑完（-01 的形状），返回子对话 */
async function headline(d: HostD): Promise<ConversationId> {
  d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await d.session.submitUser('go')).toEqual({})
  return d.outcomes[0]!.conversationId!
}

/** 这段期间有没有提交摸到某对话的任务 */
function taskChanges(
  d: HostD,
  conversationId: ConversationId
): { count: number; stop: () => void } {
  const seen = { count: 0, stop: () => {} }
  seen.stop = d.session.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === 'task' && change.value.conversationId === conversationId) seen.count++
    }
  })
  return seen
}

async function childLines(d: HostD, C: ConversationId): Promise<string[]> {
  return transcript((await d.session.harness.conversation(C, BG))!)
}

describe('SpawnCoordinator · interrupt', () => {
  it('P2-03-42 on an idle child: resolves; nothing touches its tasks', async () => {
    const d = await hostD()
    const C = await headline(d)
    const changes = taskChanges(d, C)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    changes.stop()
    expect(changes.count).toBe(0)
  })

  it.each([999, 1])('P2-03-42 on a non-agent id (%i): resolves without effect', async (id) => {
    const d = await hostD()
    await headline(d)
    const states = d.t.statesOf('s1').length
    await withTimeout(d.session.agents.interrupt(id), 3000, 'interrupt')
    expect(d.t.statesOf('s1')).toHaveLength(states)
    expect(d.session.runState).toBe('idle')
  })

  it('P2-03-42 on a running child: resolves only once it is idle', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await liveTasks(d.session, C)).toEqual([])
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
  })

  it('P2-03-43 interrupt cascades: C waiting on G → G aborted, C inner dispatch aborted; the outer outcome is soft', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(
      callAgent('nester', 'mid'),
      assistantWith(
        [
          fauxText('C partial'),
          fauxToolCall(
            'agent',
            { name: 'explore', prompt: 'leaf', description: 'g' },
            { id: 'call-g' }
          )
        ],
        { stopReason: 'toolUse' }
      ),
      step.step,
      answer('done')
    )
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const G = await firstChild(d.session, C)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect((await tasksOf(d.session, G)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    const inner = (await tasksOf(d.session, C, 'pi.tool')).at(-1)!
    expect(inner.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } })
    const [gOutcome, cOutcome] = d.outcomes
    expect(gOutcome!.error).toBe('aborted')
    expect(cOutcome).toMatchObject({ result: 'C partial\n\n[Note] stopReason=toolUse' })
    expect('error' in cOutcome!).toBe(false)
    expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
      'pi.assistant:done'
    )
  })
})

describe('SpawnCoordinator · destroy', () => {
  it('P2-03-44 destroy during a wait: error aborted; the extension is gone; history and identity stay', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const stateBefore = await d.session.harness.snapshot(AgentStateDoc, C, BG)
    await withTimeout(d.session.agents.destroy(C), 3000, 'destroy')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(d.outcomes[0]!.error).toBe('aborted')
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toBeUndefined()
    expect(await childLines(d, C)).toContain('pi.user:find X')
    expect(await d.session.harness.snapshot(AgentStateDoc, C, BG)).toEqual(stateBefore)
    expect(d.session.agentIdentity(C)?.kind).toBe('spawned')
    expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
      'pi.assistant:done'
    )
  })

  it('P2-03-45 destroy when idle (no abort commit), then continue rebuilds on demand', async () => {
    const d = await hostD()
    const C = await headline(d)
    const changes = taskChanges(d, C)
    await d.session.agents.destroy(C)
    changes.stop()
    expect(changes.count).toBe(0)
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toBeUndefined()
    d.t.kit.queue(answer('more ok'))
    const outcome = await withTimeout(d.session.agents.continue(C, 'more'), 3000, 'continue')
    expect(outcome).toMatchObject({ result: 'more ok', conversationId: C })
    expect(d.t.toolHost.rebuildCalls.at(-1)).toEqual(
      await spawnedAgentRecordOf(d.session.harness, C, BG)
    )
    expect(d.t.toolHost.rebuildContexts.at(-1)).toEqual({ sessionId: 's1', extraTools: [] })
    expect(d.t.kit.requests.at(-1)!.tools.map((tool) => tool.name)).toEqual(['probe'])
  })
})

describe('SpawnCoordinator · continue', () => {
  it('P2-03-46 continue after done: appends one turn, no agent: requestId; root untouched; runState busy → idle', async () => {
    const d = await hostD()
    const C = await headline(d)
    const rootBefore = await transcript(await d.session.currentConversation())
    const submissions: SubmissionRecord[] = []
    const stop = d.session.harness.subscribeCommits((publication) => {
      for (const change of publication.changes) {
        if (change.type === 'submission' && change.value.conversationId === C) {
          submissions.push(change.value)
        }
      }
    })
    const busy: boolean[] = []
    const gate = held(answer('more ok'))
    d.t.kit.queue(gate.step)
    const states = d.t.statesOf('s1').length
    const continued = d.session.agents.continue(C, 'more')
    await gate.reached
    busy.push(d.session.isBusy())
    gate.release()
    expect(await withTimeout(continued, 3000, 'continue')).toMatchObject({ result: 'more ok' })
    stop()
    expect(busy).toEqual([false])
    expect((await childLines(d, C)).slice(-2)).toEqual(['pi.user:more', 'pi.assistant:more ok'])
    expect(submissions.length).toBeGreaterThan(0)
    expect(submissions.every((record) => record.requestId === undefined)).toBe(true)
    expect(await transcript(await d.session.currentConversation())).toEqual(rootBefore)
    await waitFor(() => d.t.statesOf('s1').length >= states + 2, 3000, 'states')
    expect(d.t.statesOf('s1').slice(states)).toEqual(['busy', 'idle'])
  })

  it('P2-03-47 continue while busy: error with the busy detail; no second pi.user', async () => {
    const step = stalled()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step, answer('done'))
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const outcome = await d.session.agents.continue(C, 'more')
    expect(outcome.error).toMatch(/busy/i)
    expect((await childLines(d, C)).filter((line) => line.startsWith('pi.user:'))).toHaveLength(1)
    await d.session.abort()
    await withTimeout(sent, 3000, 'root')
  })

  it('P2-03-48 continue after an interrupt reopens inputs: the new ask is accepted and answered', async () => {
    let reopened = 0
    const asked = deferred()
    const d = await hostD({
      host: { onInputsReopened: () => void reopened++ },
      tools: (getSession) => [askingTool('ask', getSession, { onStart: () => asked.resolve() })]
    })
    d.t.kit.queue(callAgent('explore', 'find X'), callTool('ask'), answer('done'))
    const sent = d.session.submitUser('go')
    await asked.promise
    await waitFor(() => d.session.pendingInputCount === 1, 3000, 'first ask')
    const C = await firstChild(d.session)
    await withTimeout(d.session.agents.interrupt(C), 3000, 'interrupt')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(d.session.pendingInputCount).toBe(0)
    const reopenedBefore = reopened
    d.t.kit.queue(callTool('ask', {}, 'ask-2'), answer('asked ok'))
    const continued = d.session.agents.continue(C, 'go on')
    await waitFor(() => d.session.pendingInputCount === 1, 3000, 'second ask')
    expect(d.session.respondToInput('ask-2', { kind: 'ask', allowed: true })).toBe(true)
    const outcome = await withTimeout(continued, 3000, 'continue')
    expect(outcome).toMatchObject({ result: 'asked ok' })
    expect('error' in outcome).toBe(false)
    expect(reopened).toBeGreaterThan(reopenedBefore)
  })

  it('P2-03-49 invalid continue targets: root, an ownerless plain conversation, unknown', async () => {
    const d = await hostD()
    const plain = await d.session.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BG
    )
    const calls = d.t.kit.callCount
    for (const id of [1, plain.id, 999]) {
      const outcome = await d.session.agents.continue(id, 'x')
      expect(outcome.error).toMatch(/not a spawned agent/)
    }
    expect(d.t.kit.callCount).toBe(calls)
    expect(await transcript(plain)).toEqual([])
  })
})
