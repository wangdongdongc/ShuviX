/**
 * SpawnCoordinator · 根 Esc 的级联（P2-03，I 段 50–54）：durable 原生 —— 根的中止经拥有者边到达派发工具
 * 名下的子对话（嵌套、并行都算），也到达面板追问的子对话（PIN-09）；后台锚名下的对话不受影响（fact 3）。
 * 工具自己被中止时协调器交回 `error: 'aborted'`、从不抛出（PIN-18）。
 */
import type { FauxResponseStep } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { answer, callTools, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools } from './support/scenario'
import {
  callAgent,
  conversationIds,
  dispatchTask,
  firstChild,
  hostD,
  liveTasks,
  queueRouted,
  seedAgent,
  startRun,
  submissionByRequest,
  taskRecord,
  tasksOf
} from './support/spawn'
import { aborted, deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

/** 一个永不应答、记下自己 signal 被中止的步骤 */
function watchedStall(): {
  step: FauxResponseStep
  reached: Promise<void>
  aborted: () => boolean
} {
  const reached = deferred()
  let sawAbort = false
  return {
    reached: reached.promise,
    aborted: () => sawAbort,
    step: async (_context, options) => {
      reached.resolve()
      try {
        return await aborted(options!.signal!)
      } finally {
        sawAbort = true
      }
    }
  }
}

describe('SpawnCoordinator · root Esc', () => {
  it('P2-03-50 Esc while the child runs: everything under the root stops; the outcome is error aborted', async () => {
    const step = watchedStall()
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), step.step)
    const sent = d.session.submitUser('go')
    await step.reached
    const C = await firstChild(d.session)
    const record = await spawnedAgentRecordOf(d.session.harness, C, BG)
    await withTimeout(d.session.abort(), 3000, 'abort')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}`)).toMatchObject({
      status: 'unanswered',
      reason: 'aborted'
    })
    expect(step.aborted()).toBe(true)
    expect((await taskRecord(d.session, task))!.state.status).toBe('terminal')
    expect(d.t.kit.callCount).toBe(2)
    expect(d.session.isBusy()).toBe(false)
    await waitFor(() => d.session.runState === 'idle', 3000, 'idle')
    expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
    expect(await spawnedAgentRecordOf(d.session.harness, C, BG)).toEqual(record)
    await waitFor(() => d.outcomes.length > 0, 3000, 'outcome')
    expect(d.outcomes[0]!.error).toBe('aborted')
  })

  it('P2-03-51 nested and parallel: one abort stops G, C and D', async () => {
    const g = stalled()
    const dStep = stalled()
    const d = await hostD()
    queueRouted(d.t.kit, {
      go: [
        callTools([
          ['agent', { name: 'nester', prompt: 'mid', description: 'c' }, 'call-c'],
          ['agent', { name: 'explore', prompt: 'side', description: 'd' }, 'call-d']
        ])
      ],
      mid: [callAgent('explore', 'leaf', { id: 'call-g' })],
      leaf: [g.step],
      side: [dStep.step]
    })
    const sent = d.session.submitUser('go')
    await Promise.all([g.reached, dStep.reached])
    expect(await conversationIds(d.session)).toHaveLength(4)
    await withTimeout(d.session.abort(), 3000, 'abort')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(await liveTasks(d.session)).toEqual([])
    for (const id of (await conversationIds(d.session)).slice(1)) {
      expect((await tasksOf(d.session, id)).at(-1)!.state).toMatchObject({
        outcome: { status: 'aborted' }
      })
    }
  })

  it('P2-03-52 Esc during creation: the resolve is cancelled; nothing is created', async () => {
    const d = await hostD()
    const resolving = deferred()
    d.t.toolHost.beforeResolve = (signal) => {
      resolving.resolve()
      return aborted(signal)
    }
    d.t.kit.queue(callAgent('explore', 'find X'))
    const sent = d.session.submitUser('go')
    await resolving.promise
    await withTimeout(d.session.abort(), 3000, 'abort')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(await conversationIds(d.session)).toEqual([1])
    const agents = d.t
      .registryOf('s1')!
      .snapshot()
      .installed()
      .filter((extension) => extension.name.startsWith('shuvix.agent.'))
    expect(agents.map((extension) => extension.name)).toEqual(['shuvix.agent.1'])
  })

  it('P2-03-53 the background boundary: an anchor-owned child keeps running through root Esc', async () => {
    const anchorStep = held(answer('anchored done'))
    const childStep = stalled()
    const d = await hostD()
    const seeded = await seedAgent(d.session, { settle: true })
    d.t.kit.queue(anchorStep.step)
    const anchored = await startRun(d.session, seeded.conversationId, 'work')
    await anchorStep.reached
    d.t.kit.queue(callAgent('explore', 'find X'), childStep.step)
    const sent = d.session.submitUser('go')
    await childStep.reached
    const C = await firstChild(d.session)
    await withTimeout(d.session.abort(), 3000, 'abort')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    const live = await liveTasks(d.session, seeded.conversationId)
    expect(live).toHaveLength(1)
    expect(live[0]!.abortRequested).toBe(false)
    anchorStep.release()
    expect(await withTimeout(anchored.wait(BG), 3000, 'anchored')).toMatchObject({
      status: 'done'
    })
  })

  it('P2-03-54 Esc reaches a panel-continued child while the root is idle (PIN-09)', async () => {
    const d = await hostD()
    d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const C = d.outcomes[0]!.conversationId!
    const step = stalled()
    d.t.kit.queue(step.step)
    const continued = d.session.agents.continue(C, 'more')
    await step.reached
    await withTimeout(d.session.abort(), 3000, 'abort')
    expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    expect((await withTimeout(continued, 3000, 'continue')).error).toBe('aborted')
  })
})
