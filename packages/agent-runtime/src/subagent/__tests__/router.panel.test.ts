/**
 * 派生 agent 路由 · 面板操作按 agentId（P2-05 E 段，32–38；39 在桌面 agentHandlers.test.ts）：追问空闲的子 agent、
 * 不认识的 id、忙（PIN-08）、中止之后照样能追问（PIN-09）、会话关着用 peek 重开 / 被删就 not found（PIN-11）、
 * 中断与销毁从不打开会话。
 */
import { existsSync } from 'node:fs'
import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../../durable/context'
import { spawnedAgentRecordOf } from '../../durable/agentRecord'
import { AgentStateDoc } from '../../durable/docs'
import type { DurableSession } from '../../durable/durableSession'
import { answer, held, stalled } from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import { extensionTools } from '../../durable/__tests__/support/scenario'
import { callAgent, childOf, dispatchTask } from '../../durable/__tests__/support/spawn'
import { transcript } from '../../durable/__tests__/support/transcript'
import { waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import { hostR, type HostR } from '../../durable/__tests__/support/router'

registerHostCleanup()

async function headline(r: HostR): Promise<{ A: string; C: ConversationId }> {
  r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await r.session.submitUser('go')).toEqual({})
  const [C] = await childOf(r.session, await dispatchTask(r.session))
  return { A: r.registers()[0]!.sessionId, C: C! }
}

async function lines(session: DurableSession, C?: ConversationId): Promise<string[]> {
  const conversation =
    C === undefined
      ? await session.currentConversation()
      : (await session.harness.conversation(C, BG))!
  return transcript(conversation)
}

/** 这段期间有没有提交摸到某对话的任务 */
function taskChanges(session: DurableSession, C: ConversationId): { count: number; stop(): void } {
  const seen = { count: 0, stop: () => {} }
  seen.stop = session.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (change.type === 'task' && change.value.conversationId === C) seen.count++
    }
  })
  return seen
}

describe('router · continue', () => {
  it('P2-05-32 continue an idle child: its transcript grows; root untouched; not busy; resolves undefined', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    const childBefore = await lines(r.session, C)
    const rootBefore = await lines(r.session)
    const step = held(answer('more ok'))
    r.t.kit.queue(step.step)
    const continued = r.router.continueTask({ subSessionId: A, text: 'more' })
    await step.reached
    expect(r.session.isBusy()).toBe(false)
    step.release()
    await expect(withTimeout(continued, 3000, 'continue')).resolves.toBeUndefined()
    expect(await lines(r.session, C)).toEqual([
      ...childBefore,
      'pi.user:more',
      'pi.assistant:more ok'
    ])
    expect(await lines(r.session)).toEqual(rootBefore)
    expect(r.session.isBusy()).toBe(false)
  })

  it('P2-05-33 unknown id: rejects not found; no events, no task change, no peek', async () => {
    const r = await hostR()
    const { A } = await headline(r)
    const events = r.events.length
    const tasks = r.taskBroadcasts.length
    await expect(r.router.continueTask({ subSessionId: 'sub-x', text: 'more' })).rejects.toThrow(
      /Sub-session not found: sub-x/
    )
    expect(r.events).toHaveLength(events)
    expect(r.taskBroadcasts).toHaveLength(tasks)
    expect(r.peeks).toEqual([])
    expect(r.task(A)?.status).toBe('done')
  })

  it('P2-05-34 busy during the initial runTask wait: rejected before any broadcast (PIN-08)', async () => {
    const r = await hostR()
    const stall = stalled()
    r.t.kit.queue(callAgent('explore', 'find X'), stall.step, answer('done'))
    const sent = r.session.submitUser('go')
    await stall.reached
    const A = r.registers()[0]!.sessionId
    const [C] = await childOf(r.session, await dispatchTask(r.session))
    const spy = vi.spyOn(r.session.agents, 'continue')
    const events = r.events.length
    const tasks = r.taskBroadcasts.length
    await expect(r.router.continueTask({ subSessionId: A, text: 'more' })).rejects.toThrow(
      new RegExp(`Sub-session is busy: ${A}`)
    )
    expect(r.events).toHaveLength(events)
    expect(r.userMessages()).toEqual([])
    expect(r.taskBroadcasts).toHaveLength(tasks)
    expect((await lines(r.session, C!)).filter((line) => line.startsWith('pi.user:'))).toEqual([
      'pi.user:find X'
    ])
    expect(spy).not.toHaveBeenCalled()
    await r.router.interrupt(A)
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
  })

  it('P2-05-34 busy during a held continue: the second continue is rejected; one continue call', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    const spy = vi.spyOn(r.session.agents, 'continue')
    const step = held(answer('more ok'))
    r.t.kit.queue(step.step)
    const continued = r.router.continueTask({ subSessionId: A, text: 'more' })
    await step.reached
    const events = r.events.length
    await expect(r.router.continueTask({ subSessionId: A, text: 'again' })).rejects.toThrow(
      new RegExp(`Sub-session is busy: ${A}`)
    )
    expect(r.events).toHaveLength(events)
    expect(r.userMessages()).toEqual([])
    step.release()
    await withTimeout(continued, 3000, 'continue')
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await lines(r.session, C)).filter((line) => line === 'pi.user:again')).toEqual([])
  })

  it('P2-05-35 continue after an Esc abort is accepted: killed → running → done (PIN-09)', async () => {
    const r = await hostR()
    const stall = stalled()
    r.t.kit.queue(callAgent('explore', 'find X'), stall.step)
    const sent = r.session.submitUser('go')
    await stall.reached
    await withTimeout(r.session.abort(), 3000, 'abort')
    await withTimeout(sent, 3000, 'root')
    await waitFor(() => r.ends().length > 0, 3000, 'end')
    const A = r.registers()[0]!.sessionId
    expect(r.task(A)?.status).toBe('killed')
    r.t.kit.queue(answer('ok'))
    await withTimeout(r.router.continueTask({ subSessionId: A, text: 'go on' }), 3000, 'continue')
    expect(r.statuses(A).slice(-3)).toEqual(['killed', 'running', 'done'])
    expect(r.ends().at(-1)).toMatchObject({ sessionId: A, isError: false, result: 'ok' })
  })

  it('P2-05-36 continue on a closed session: one peek reopens it; the record is rebuilt; the answer is broadcast (PIN-11)', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    const record = await spawnedAgentRecordOf(r.session.harness, C, BG)
    await r.t.host.close('s1')
    expect(r.t.host.get('s1')).toBeUndefined()
    r.t.kit.queue(answer('more ok'))
    await withTimeout(r.router.continueTask({ subSessionId: A, text: 'more' }), 5000, 'continue')
    expect(r.peeks).toEqual(['s1'])
    expect(r.t.host.get('s1')).toBeDefined()
    expect(r.t.toolHost.rebuildCalls.at(-1)).toEqual(record)
    expect(r.ends().at(-1)).toMatchObject({ sessionId: A, result: 'more ok', isError: false })
    expect(r.router.locate(A)).toEqual({ sessionId: 's1', conversationId: C })
  })

  it('P2-05-37 a deleted session: not found, the index entry is dropped, no store is created', async () => {
    const r = await hostR()
    const { A } = await headline(r)
    await r.t.host.delete('s1')
    expect(existsSync(r.t.file('s1'))).toBe(false)
    await expect(r.router.interrupt(A)).resolves.toBeUndefined()
    await expect(r.router.continueTask({ subSessionId: A, text: 'more' })).rejects.toThrow(
      /not found/
    )
    expect(r.router.locate(A)).toBeUndefined()
    expect(existsSync(r.t.file('s1'))).toBe(false)
    expect(r.t.host.openSessionIds()).toEqual([])
    await expect(r.router.destroy(A)).resolves.toBeUndefined()
  })
})

describe('router · interrupt and destroy edge rows', () => {
  it('P2-05-38 interrupt: idle child → no commit touches it; unknown id → resolves', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    const changes = taskChanges(r.session, C)
    await withTimeout(r.router.interrupt(A), 3000, 'interrupt')
    changes.stop()
    expect(changes.count).toBe(0)
    await expect(r.router.interrupt('sub-x')).resolves.toBeUndefined()
  })

  it('P2-05-38 interrupt on a closed session: resolves without opening it', async () => {
    const r = await hostR()
    const { A } = await headline(r)
    await r.t.host.close('s1')
    const open = r.t.host.openSessionIds()
    await withTimeout(r.router.interrupt(A), 3000, 'interrupt')
    expect(r.t.host.get('s1')).toBeUndefined()
    expect(r.t.host.openSessionIds()).toEqual(open)
    expect(r.peeks).toEqual([])
  })

  it('P2-05-38 destroy an idle child: extension gone, index and task cleared, history intact; continue → not found', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    const history = await lines(r.session, C)
    const state = await r.session.harness.snapshot(AgentStateDoc, C, BG)
    expect(extensionTools(r.t, `shuvix.agent.${C}`)).toBeDefined()
    await withTimeout(r.router.destroy(A), 3000, 'destroy')
    expect(extensionTools(r.t, `shuvix.agent.${C}`)).toBeUndefined()
    expect(r.router.locate(A)).toBeUndefined()
    expect(r.router.has(A)).toBe(false)
    expect(r.task(A)).toBeUndefined()
    expect(await lines(r.session, C)).toEqual(history)
    expect(await r.session.harness.snapshot(AgentStateDoc, C, BG)).toEqual(state)
    await expect(r.router.continueTask({ subSessionId: A, text: 'more' })).rejects.toThrow(
      /not found/
    )
  })

  it('P2-05-38 destroy on a closed session drops the index without opening; unknown id is a no-op', async () => {
    const r = await hostR()
    const { A } = await headline(r)
    await r.t.host.close('s1')
    await withTimeout(r.router.destroy(A), 3000, 'destroy')
    expect(r.router.has(A)).toBe(false)
    expect(r.task(A)).toBeUndefined()
    expect(r.t.host.get('s1')).toBeUndefined()
    expect(r.peeks).toEqual([])
    const events = r.events.length
    await expect(r.router.destroy('sub-x')).resolves.toBeUndefined()
    expect(r.events).toHaveLength(events)
  })
})
