/**
 * `destroyAgent` 的范围（P2-03，L 段 67–70）：任何非辅助的 run（含面板追问、根闲着时在跑的子 agent，
 * 以及只剩被中断的子 agent）都先中止；所有 `shuvix.agent.*` 一并卸掉；派生 agent 的记录与身份留着，
 * 下次用到时按需重建。只有辅助工作在跑时照旧不中止（P2-01-53 原样通过）。
 */
import type { ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import { answer, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { callAgent, hostD, liveTasks, tasksOf, type HostD } from './support/spawn'
import { waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

async function headline(d: HostD): Promise<ConversationId> {
  d.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await d.session.submitUser('go')).toEqual({})
  return d.outcomes[0]!.conversationId!
}

function agentExtensions(d: HostD): string[] {
  return d.t
    .registryOf('s1')!
    .snapshot()
    .installed()
    .map((extension) => extension.name)
    .filter((name) => name.startsWith('shuvix.agent.'))
}

describe('destroyAgent reach (P2-03)', () => {
  it('P2-03-67 a panel-continued child running beside an idle root is aborted; everything is uninstalled', async () => {
    let aborts = 0
    const d = await hostD({ host: { beforeAbort: () => void aborts++ } })
    const C = await headline(d)
    const stateBefore = await d.session.harness.snapshot(AgentStateDoc, C, BG)
    const step = stalled()
    d.t.kit.queue(step.step)
    const continued = d.session.agents.continue(C, 'more')
    await step.reached
    expect(d.session.isBusy()).toBe(false)
    await withTimeout(d.session.destroyAgent(), 3000, 'destroyAgent')
    expect(aborts).toBe(1)
    expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    expect((await withTimeout(continued, 3000, 'continue')).error).toBe('aborted')
    expect(d.session.lock).toBeUndefined()
    expect(d.t.mirror.at(-1)).toEqual(['s1', false])
    expect(agentExtensions(d)).toEqual([])
    expect(await d.session.harness.snapshot(AgentStateDoc, C, BG)).toEqual(stateBefore)
    expect(d.session.agentIdentity(C)?.kind).toBe('spawned')
  })

  it('P2-03-68 idle children: no abort; every agent extension is uninstalled; a later continue rebuilds', async () => {
    let aborts = 0
    const d = await hostD({ host: { beforeAbort: () => void aborts++ } })
    const C = await headline(d)
    await d.session.destroyAgent()
    expect(aborts).toBe(0)
    expect(agentExtensions(d)).toEqual([])
    await d.session.createAgent()
    d.t.kit.queue(answer('x ok'))
    expect(await withTimeout(d.session.agents.continue(C, 'x'), 3000, 'continue')).toMatchObject({
      result: 'x ok'
    })
    expect(agentExtensions(d).sort()).toEqual(['shuvix.agent.1', `shuvix.agent.${C}`].sort())
  })

  it(
    'P2-03-69 only an interrupted child: destroy aborts it without a model call',
    async () => {
      const first = await hostD()
      const C = await headline(first)
      const step = stalled()
      first.t.kit.queue(step.step)
      void first.session.agents.continue(C, 'more')
      await step.reached
      const d = await first.reopen()
      expect(d.session.isInterrupted()).toBe(true)
      await withTimeout(d.session.destroyAgent(), 5000, 'destroyAgent')
      expect(d.t.kit.callCount).toBe(0)
      await waitFor(async () => (await liveTasks(d.session, C)).length === 0, 3000, 'idle child')
      expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
        outcome: { status: 'aborted' }
      })
      expect((await d.session.harness.inspect(BG)).submissions).toEqual([])
      expect(d.session.isInterrupted()).toBe(false)
      expect(d.session.lock).toBeUndefined()
    },
    RESTART_TIMEOUT
  )
})
