/**
 * 锁 · 销毁（P1-09；裁决 K8、K10、K13）：空闲销毁不中止（残留输入留着、下一次发送带走）；忙 / 被中断
 * 先中止再解锁；挂起的询问被取消；没锁 = 无操作；重建按那一刻的配置；与发送、与在途的创建、与另一次
 * 销毁之间的先后。
 */
import type { FauxResponseStep } from '@earendil-works/pi-ai'
import { InboxDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { DECL_RESOLVE, scenarioConfig, scenarioToolHost } from './support/agentConfig'
import { recordPublications, type PublicationSummary } from './support/commits'
import { answer, callTool, held, modelError, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools, scenarioW, storedLock, W_NOW } from './support/scenario'
import { askingTool, holdTool } from './support/tools'
import { toolDeltaCount, transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const DESTROY_TIMEOUT = 15000

function closingEvents(events: readonly { type: string }[]): unknown[] {
  return events.filter((event) => event.type === 'agent_closing')
}

describe('lock · destroy', () => {
  it('LD-01 idle destroy unlocks without aborting: a leftover queued input stays and goes out with the next send', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const run = held(modelError('boom'))
    t.kit.queue(run.step)
    const failed = session.submitUser('u1')
    await run.reached
    void session.submitUser('F', { whenBusy: 'followUp' })
    await waitFor(async () => {
      const inbox = await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
      return (inbox?.items.length ?? 0) === 1
    })
    run.release()
    expect(await failed).toMatchObject({ code: 'model_error' })
    const builtinBefore = t.registryOf('s1')!.snapshot().extension('shuvix.builtin')
    const stateBefore = await session.harness.snapshot(SessionStateDoc, BG)

    await withTimeout(session.destroyAgent(), 5000, 'idle destroy')
    expect(session.lock).toBeUndefined()
    expect(await storedLock(session)).toBeUndefined()
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
    expect(t.registryOf('s1')!.snapshot().extension('shuvix.builtin')).toBe(builtinBefore)
    expect(t.mirror.at(-1)).toEqual(['s1', false])
    expect(closingEvents(t.broadcasts)).toEqual([
      { type: 'agent_closing', sessionId: 's1', closing: true },
      { type: 'agent_closing', sessionId: 's1', closing: false }
    ])
    const inbox = await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG)
    expect(inbox?.items.map((item) => item.mode)).toEqual(['followUp'])
    const stateAfter = await session.harness.snapshot(SessionStateDoc, BG)
    expect(stateAfter?.currentConversation).toEqual(stateBefore?.currentConversation)
    expect(stateAfter?.deferredNotices).toEqual(stateBefore?.deferredNotices)

    t.kit.queue(answer('after'))
    expect(await session.submitUser('next')).toEqual({})
    expect(session.lock).toBeDefined()
    const lines = await transcript(await session.currentConversation())
    expect(lines).toContain('pi.user:F')
    expect(lines).toContain('pi.user:next')
    expect(t.toolHost.resolveCalls).toHaveLength(2)
  })

  it.each(['held tool', 'stalled request'] as const)(
    'LD-02 destroy on a busy session (%s) aborts first, then unlocks; the pending send resolves {}',
    async (kind) => {
      const gate = deferred()
      const running = deferred()
      const hold = holdTool('hold', gate.promise, { onRun: () => running.resolve() })
      const { t } = await scenarioW({ toolHost: scenarioToolHost({ agentTools: [hold] }) })
      const session = await t.open()
      const recorder = recordPublications(session.harness)
      if (kind === 'held tool') {
        t.kit.queue(callTool('hold'), answer('not reached'))
      } else {
        const stall = stalled()
        t.kit.queue(stall.step)
      }
      const sending = session.submitUser('go')
      if (kind === 'held tool') await running.promise
      else await waitFor(() => t.kit.callCount === 1, 3000, 'request in flight')
      await withTimeout(session.destroyAgent(), 5000, 'busy destroy')
      recorder.stop()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(session.lock).toBeUndefined()
      const lines = await transcript(await session.currentConversation())
      if (kind === 'held tool') {
        expect(lines[0]).toBe('pi.user:go')
        expect(lines.find((line) => line.startsWith('pi.tool-result:'))).toContain(
          'Tool hold was aborted'
        )
      }
      expect(lines.join('\n')).not.toMatch(/unavailable|no_model|No model/)
      // 解锁的提交在中止落定之后
      const lastIndexOf = (match: (p: PublicationSummary) => boolean): number =>
        recorder.publications.reduce((found, p, index) => (match(p) ? index : found), -1)
      const unlock = lastIndexOf((p) => p.docs.includes('shuvix.session-state'))
      const lastEntry = lastIndexOf((p) => p.entries.length > 0)
      expect(unlock).toBeGreaterThan(lastEntry)
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      expect(session.isBusy()).toBe(false)
    },
    DESTROY_TIMEOUT
  )

  it('LD-03 destroy with a pending ask: the ask is cancelled, the tool result is aborted, the session unlocked', async () => {
    const ref: { session?: DurableSession } = {}
    let response: InputResponse | undefined
    const ask = askingTool('askme', () => ref.session!, { onResolved: (r) => (response = r) })
    const { t } = await scenarioW({ toolHost: scenarioToolHost({ agentTools: [ask] }) })
    const session = (ref.session = await t.open())
    t.kit.queue(callTool('askme'), answer('not reached'))
    const sending = session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    await withTimeout(session.destroyAgent(), 5000, 'destroy with ask')
    expect(response).toEqual({ kind: 'cancel', reason: 'aborted' })
    expect(session.pendingInputCount).toBe(0)
    expect(await sending).toEqual({})
    const lines = await transcript(await session.currentConversation())
    expect(lines.find((line) => line.startsWith('pi.tool-result:'))).toContain('aborted')
    expect(session.lock).toBeUndefined()
    expect(t.kit.callCount).toBe(1)
  })

  it(
    'LD-04 destroy on an interrupted session (crash mid tool) aborts the interrupted work: the safe tool never reruns',
    async () => {
      let runs = 0
      const running = deferred()
      const hold = {
        ...holdTool('hold', new Promise(() => {}), {
          onRun: () => {
            runs++
            running.resolve()
          }
        }),
        replay: 'safe' as const
      }
      const first = await scenarioW({ toolHost: scenarioToolHost({ agentTools: [hold] }) })
      const session = await first.t.open()
      first.t.kit.queue(callTool('hold'))
      void session.submitUser('go')
      await running.promise
      const t = await first.t.restart()
      const reopened = await t.open()
      expect(reopened.isInterrupted()).toBe(true)
      expect(reopened.lock).toBeDefined()
      await withTimeout(reopened.destroyAgent(), 5000, 'destroy interrupted')
      expect(t.kit.callCount).toBe(0)
      expect(runs).toBe(1)
      expect(reopened.isInterrupted()).toBe(false)
      expect(reopened.lock).toBeUndefined()
      expect(t.mirror.at(-1)).toEqual(['s1', false])
      const lines = await transcript(await reopened.currentConversation())
      expect(lines.find((line) => line.startsWith('pi.tool-result:'))).toContain(
        'Tool hold was aborted'
      )
    },
    DESTROY_TIMEOUT
  )

  it('LD-05 destroy on an unlocked session is a no-op: no publication, no mirror call, no closing events', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const mirrorAtOpen = t.mirror.length
    const recorder = recordPublications(session.harness)
    await session.destroyAgent()
    recorder.stop()
    expect(recorder.publications).toEqual([])
    expect(t.mirror).toHaveLength(mirrorAtOpen)
    expect(closingEvents(t.broadcasts)).toEqual([])
  })

  it('LD-06 recreating picks up the state of that moment: overlay, model, server tool list, persona; a failed server heals', async () => {
    const config = scenarioConfig()
    config.toolOverlay = ['mcp:ctx', 'skill:pdf', 'mcp:broken']
    const { t, vars, clock } = await scenarioW({ config })
    t.toolHost.mcp('broken').failConnect()
    const session = await t.open()
    t.kit.queue(answer('one'))
    expect(await session.submitUser('u1')).toEqual({})
    expect(Object.keys(session.lock!.mcp)).toEqual(['ctx'])

    config.toolOverlay = ['mcp:ctx', 'skill:pdf', 'mcp:broken', 'mcp:ssh']
    config.model = { provider: 'faux', modelId: 'faux-2' }
    t.toolHost.mcp('ctx').setTools([DECL_RESOLVE])
    t.toolHost.mcp('broken').heal()
    vars.state.marker = 'M2'
    clock.now = W_NOW + 1000
    await session.destroyAgent()
    t.kit.queue(answer('two'))
    expect(await session.submitUser('u2')).toEqual({})

    expect(t.configCalls).toHaveLength(2)
    expect(t.toolHost.resolveCalls).toHaveLength(2)
    expect(t.broadcastsOf('agent_created')).toHaveLength(2)
    const lock = session.lock!
    expect(lock.createdAt).toBe(W_NOW + 1000)
    expect(lock.model).toEqual({ provider: 'faux', modelId: 'faux-2' })
    expect(lock.mcp.ctx).toEqual([DECL_RESOLVE])
    expect(Object.keys(lock.mcp)).toEqual(['ctx', 'broken', 'ssh'])
    expect(lock.toolNames.slice(-3)).toEqual([
      'mcp__ctx__resolve',
      'mcp__broken__noop',
      'mcp__ssh__exec'
    ])
    expect(lock.skills).toEqual(['builtin:drawing', 'pdf'])
    expect(t.kit.requests[1]!.modelId).toBe('faux-2')
    expect(t.kit.requests[1]!.systemPrompt).toBe('You are M2')
    expect(await toolDeltaCount(await session.currentConversation())).toBe(2)
  })

  it(
    'LD-07 destroy (busy) and a send together: the send waits for the destroy, creates a fresh agent and runs — never without a lock',
    async () => {
      const gate = deferred()
      const running = deferred()
      const hold = holdTool('hold', gate.promise, { onRun: () => running.resolve() })
      const { t } = await scenarioW({ toolHost: scenarioToolHost({ agentTools: [hold] }) })
      const session = await t.open()
      t.kit.queue(callTool('hold'))
      const first = session.submitUser('go')
      await running.promise
      let lockedAtRequest: boolean | undefined
      const fresh: FauxResponseStep = async () => {
        lockedAtRequest = session.lock !== undefined
        return answer('fresh')
      }
      t.kit.queue(fresh)
      const destroying = session.destroyAgent()
      const next = session.submitUser('next')
      await withTimeout(destroying, 5000, 'destroy')
      expect(await withTimeout(next, 5000, 'next')).toEqual({})
      expect(await first).toEqual({})
      expect(lockedAtRequest).toBe(true)
      expect(t.toolHost.resolveCalls).toHaveLength(2)
      expect(session.lock).toBeDefined()
      const order = t.broadcasts
        .filter((event) => event.type === 'agent_created' || event.type === 'agent_closing')
        .map((event) => (event.type === 'agent_closing' ? `closing:${event.closing}` : event.type))
      expect(order).toEqual(['agent_created', 'closing:true', 'closing:false', 'agent_created'])
    },
    DESTROY_TIMEOUT
  )

  it('LD-08 destroy during a creation stuck on a slow MCP connect cancels it (K13): unlocked, nothing installed, the send resolves {}', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    const mirrorAtOpen = t.mirror.length
    const hold = t.toolHost.mcp('ctx').holdConnect()
    const sending = session.submitUser('hi')
    await hold.reached
    await withTimeout(session.destroyAgent(), 5000, 'destroy during creation')
    const result = await withTimeout(sending, 5000, 'send')
    expect(result).toEqual({})
    expect(session.lock).toBeUndefined()
    expect(await storedLock(session)).toBeUndefined()
    expect(extensionTools(t, 'shuvix.agent.1')).toBeUndefined()
    expect(t.mirror.slice(mirrorAtOpen).every(([, locked]) => locked === false)).toBe(true)
    const created = t.broadcasts.findIndex((event) => event.type === 'agent_created')
    const closing = t.broadcasts.findIndex((event) => event.type === 'agent_closing')
    if (created >= 0) expect(closing).toBeGreaterThan(created)
    expect(t.kit.callCount).toBe(0)
    hold.release()
  })

  it('LD-09 after a busy destroy a background notice is written, not run — the destroy counts as an explicit stop (K10)', async () => {
    const gate = deferred()
    const running = deferred()
    const hold = holdTool('hold', gate.promise, { onRun: () => running.resolve() })
    const { t } = await scenarioW({
      noticeCoalesceMs: 10,
      toolHost: scenarioToolHost({ agentTools: [hold] })
    })
    const session = await t.open()
    t.kit.queue(callTool('hold'), answer('not reached'))
    const sending = session.submitUser('go')
    await running.promise
    await session.destroyAgent()
    await sending
    const calls = t.kit.callCount
    await session.notify('bg')
    await waitFor(
      async () => {
        const lines = await transcript(await session.currentConversation())
        return lines.includes('shuvix.notice:bg')
      },
      3000,
      'notice written'
    )
    await sleep(50)
    expect(t.kit.callCount).toBe(calls)
    expect(t.toolHost.resolveCalls).toHaveLength(1)
    expect(session.lock).toBeUndefined()
  })

  it('LD-10 two concurrent destroys: one closing pair, one unlock publication', async () => {
    const { t } = await scenarioW()
    const session = await t.open()
    await session.createAgent()
    const recorder = recordPublications(session.harness)
    await Promise.all([session.destroyAgent(), session.destroyAgent()])
    recorder.stop()
    expect(closingEvents(t.broadcasts)).toHaveLength(2)
    expect(recorder.touching('shuvix.session-state')).toHaveLength(1)
    expect(t.mirror.filter(([, locked]) => !locked)).toHaveLength(2)
    expect(t.mirror.at(-1)).toEqual(['s1', false])
  })
})
