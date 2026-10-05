/**
 * P3-03 · 派生 agent 的 AgentProjector（设计稿 P3-03-41..44；PIN-20 / PIN-24）：
 *
 *   41 子 agent 视图：键恰好是 PIN-24 那几个；子 agent 的流式是它自己状态上的 `a`；子 agent 的发布不在根
 *      投影上产生修订（根只看得到自己的工具槽位）
 *   42 子 agent 的运行状态按它自己的对话算（busy → idle）；生命周期里子 agent 的一对（带 agentId）嵌在根的
 *      一对里面
 *   43 子 agent 跑到一半崩溃、重开：挂载 = freshMount，run.state interrupted，没有生命周期信号
 *   44 不认识的 agentId → undefined、不挂载；hook agent 可以看（只读，PIN-20）
 *   另：DurableSession 满足 P3-04 SyncHub 的 `SyncSession` 接缝（类型层）
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import type { AgentView } from '@shuvix/chat-protocol/types/sessionView'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { SyncSession } from '../../../sync/syncHub'
import type { DurableSession } from '../../durableSession'
import type { SpawnCreatedInfo } from '../../spawn'
import { answer, fauxKit, held, type FauxKit } from '../../__tests__/support/faux'
import { registerHostCleanup } from '../../__tests__/support/host'
import { callAgent, hookRec, hostD, seedAgent } from '../../__tests__/support/spawn'
import { waitFor, withTimeout } from '../../__tests__/support/wait'
import { freshAgentMount, opsOf, recordLifecycle, settleFrames, under } from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

const streamingKit = (): FauxKit =>
  fauxKit({
    tokensPerSecond: 60,
    models: [
      { id: 'faux-1', contextWindow: 40000 },
      { id: 'faux-2', contextWindow: 8000 }
    ]
  })

const CHILD_TEXT = `gamma ${'delta '.repeat(40)}`

describe('P3-03 · spawned AgentProjector', () => {
  it('the session satisfies the SyncHub seam (type level)', () => {
    expectTypeOf<DurableSession>().toMatchTypeOf<SyncSession>()
  })

  it(
    'P3-03-41/42 child view: PIN-24 keys, child streaming appends on the child state, no root revision from child content; child run state and a nested child pair',
    async () => {
      let created: SpawnCreatedInfo | undefined
      const d = await hostD({
        host: { makeKit: streamingKit },
        dispatch: { onCreated: (info) => (created = info) }
      })
      const session = d.session
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      const child = held(fauxAssistantMessage([fauxText(CHILD_TEXT)]))
      d.t.kit.queue(callAgent('explore', 'look'), child.step, answer('root done'))
      const sending = session.submitUser('go')
      await withTimeout(child.reached, 5000, 'child request')
      const info = created!
      const agent = await session.agentProjector({
        agentId: info.agentId,
        conversationId: info.conversationId
      })
      expect(agent).toBeDefined()
      expect(await session.agentProjector(info.agentId)).toBe(agent)
      const ha = agent!.acquire()
      const childOps = opsOf(ha.state)
      const rootOps = opsOf(h.state)
      expect(Object.keys(ha.state.value).sort()).toEqual(
        [
          'v',
          'agentId',
          'sessionId',
          'conversationId',
          'messages',
          'live',
          'toolRuns',
          'run',
          'context'
        ].sort()
      )
      expect(ha.state.value).toMatchObject({
        v: 1,
        agentId: info.agentId,
        sessionId: 's1',
        conversationId: info.conversationId
      })
      expect(ha.state.value.run.state).toBe('busy')
      child.release()
      expect(await withTimeout(sending, 15000, 'root send')).toEqual({})
      await waitFor(() => session.runState === 'idle', 5000, 'idle')
      await settleFrames()
      // 子 agent 的流式：它自己状态上的追加
      expect(
        childOps
          .allOps()
          .some(({ op }) => op[0] === 'a' && under(op, 'live', 'message', 'blocks', 0, 'text'))
      ).toBe(true)
      expect(ha.state.value.run.state).toBe('idle')
      expect(ha.state.value.messages.at(-1)!.content).toBe(CHILD_TEXT)
      // 根投影：子 agent 的正文只经根自己的工具槽位 / 结果出现，从不作为流式内容
      for (const { op } of rootOps.allOps()) {
        if (under(op, 'live')) expect(JSON.stringify(op)).not.toContain('gamma')
      }
      const busyStates = childOps.revisions.map((r) => r.value.run.state)
      expect(busyStates.at(-1)).toBe('idle')
      // 生命周期：子 agent 的一对嵌在根的一对里面
      const order = lc.signals.map((s) => `${s.kind}:${s.agentId ?? 'root'}`)
      expect(order).toEqual([
        'started:root',
        `started:${info.agentId}`,
        `ended:${info.agentId}`,
        'ended:root'
      ])
      expect(lc.signals[1]).toMatchObject({ conversationId: info.conversationId })
      expect(lc.signals[2]).toMatchObject({ reason: 'ok' })
      childOps.stop()
      rootOps.stop()
      ha.release()
      h.release()
    },
    TIMEOUT
  )

  it(
    'P3-03-43 child reopen after a crash mid-run: mount = freshMount, run interrupted, no lifecycle signal',
    async () => {
      let created: SpawnCreatedInfo | undefined
      const d = await hostD({ dispatch: { onCreated: (info) => (created = info) } })
      const child = held(answer('never'))
      d.t.kit.queue(callAgent('explore', 'look'), child.step)
      void d.session.submitUser('go')
      await withTimeout(child.reached, 5000, 'child request')
      const info = created!
      const next = await d.reopen()
      const session = next.session
      const proj = await session.projector()
      const h = proj.acquire()
      const lc = recordLifecycle(proj)
      const agent = await session.agentProjector(info.agentId)
      const ha = agent!.acquire()
      await settleFrames()
      expect(ha.state.value.run.state).toBe('interrupted')
      expect(ha.state.value).toStrictEqual(
        await freshAgentMount(session, info.agentId, info.conversationId)
      )
      expect(lc.signals).toEqual([])
      ha.release()
      h.release()
    },
    TIMEOUT
  )

  it('P3-03-44 an unknown agentId → undefined, no mount; a hook agent is viewable (PIN-20)', async () => {
    const d = await hostD()
    expect(await d.session.agentProjector('nope')).toBeUndefined()
    expect(await d.session.agentProjector({ agentId: 'nope', conversationId: 1 })).toBeUndefined()
    const seeded = await seedAgent(d.session, { record: hookRec() })
    const agent = await d.session.agentProjector('sub-h1')
    expect(agent?.conversationId).toBe(seeded.conversationId)
    const ha = agent!.acquire()
    const view: AgentView = ha.state.value
    expect(view).toMatchObject({ agentId: 'sub-h1', messages: [], run: { state: 'idle' } })
    ha.release()
    expect(agent!.disposed).toBe(true)
  })
})
