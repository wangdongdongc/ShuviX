/**
 * P4-09b · 投影上的结构共享与按引用跳过（真会话，faux 驱动）：
 *
 *   PS-01 守卫：别人往投影的状态里写了一笔（状态的根值换了），下一次修订退回整棵比较 —— 那一笔被纠正，
 *         状态 = freshMount；之后照常修订
 *   PS-02 接线：根会话与派生 agent 的流式帧都整段沿用历史（memo 命中），结束时两份状态 = freshMount
 */
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai'
import type { InputRequest } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { SpawnCreatedInfo } from '../../spawn'
import { answer, fauxKit, held, type FauxKit } from '../../__tests__/support/faux'
import { makeHost, primeRoot, registerHostCleanup } from '../../__tests__/support/host'
import { callAgent, hostD } from '../../__tests__/support/spawn'
import { withTimeout } from '../../__tests__/support/wait'
import type { ProjectionMemo } from '../project'
import { freshAgentMount, freshMount, settleFrames } from './projectorSupport'

registerHostCleanup()

const TIMEOUT = 25000

const ask = (id: string): InputRequest =>
  ({ id, kind: 'ask', toolName: 'ask', question: `${id}?`, createdAt: 0 }) as unknown as InputRequest

/** 投影的 memo 上「整段历史沿用」的次数 */
function historyHits(projector: object): () => number {
  const memo = (projector as { memo: ProjectionMemo }).memo
  const spy = vi.spyOn(memo, 'cachedHistory')
  return () =>
    spy.mock.results.filter((result) => result.type === 'return' && result.value !== undefined)
      .length
}

describe('P4-09b · projector structural sharing', () => {
  it(
    'PS-01 a write to the state by anyone but the projector drops the identity skip for the next revision',
    async () => {
      const t = await makeHost({ ephemeral: ['s1'] })
      const session = await t.open('s1')
      await primeRoot(session)
      t.kit.queue(answer('one'))
      expect(await session.submitUser('u1')).toEqual({})
      const proj = await session.projector()
      const h = proj.acquire()
      await settleFrames()
      expect(h.state.value).toStrictEqual(await freshMount(session))

      const bogus = { ...h.state.value.messages[0]!, id: 'bogus', content: 'not the projector' }
      h.state.change(BG, (draft) => {
        draft.messages.push(bogus)
        draft.context = { usedTokens: 424242 }
      })
      // 一次只改询问的修订：消息列表整段沿用（memo 命中、与上一份视图同一引用）—— 没有守卫的话那一笔会一直留着
      const hits = historyHits(proj)
      const pending = session.requestUserInput(ask('R1'))
      await settleFrames()
      expect(hits()).toBeGreaterThan(0)
      expect(h.state.value.messages.map((message) => message.id)).not.toContain('bogus')
      expect(h.state.value.context.usedTokens).not.toBe(424242)
      expect(h.state.value).toStrictEqual(await freshMount(session))

      session.respondToInput('R1', { kind: 'allow' } as never)
      await pending
      t.kit.queue(answer('two'))
      expect(await session.submitUser('u2')).toEqual({})
      await settleFrames()
      expect(h.state.value.messages.map((message) => message.content)).toEqual([
        'u1',
        'one',
        'u2',
        'two'
      ])
      expect(h.state.value).toStrictEqual(await freshMount(session))
      h.release()
    },
    TIMEOUT
  )

  it(
    'PS-02 streaming frames reuse the whole history on the root and on a spawned agent; both states end equal to freshMount',
    async () => {
      const streamingKit = (): FauxKit =>
        fauxKit({
          tokensPerSecond: 60,
          models: [
            { id: 'faux-1', contextWindow: 40000 },
            { id: 'faux-2', contextWindow: 8000 }
          ]
        })
      let created: SpawnCreatedInfo | undefined
      const d = await hostD({
        host: { makeKit: streamingKit },
        dispatch: { onCreated: (info) => (created = info) }
      })
      const session = d.session
      const proj = await session.projector()
      const h = proj.acquire()
      const rootHits = historyHits(proj)
      const child = held(fauxAssistantMessage([fauxText(`gamma ${'delta '.repeat(30)}`)]))
      d.t.kit.queue(
        callAgent('explore', 'look'),
        child.step,
        answer(`root done ${'word '.repeat(30)}`)
      )
      const sending = session.submitUser('go')
      await withTimeout(child.reached, 5000, 'child request')
      const info = created!
      const agent = await session.agentProjector({
        agentId: info.agentId,
        conversationId: info.conversationId
      })
      const ha = agent!.acquire()
      const childHits = historyHits(agent!)
      child.release()
      expect(await withTimeout(sending, TIMEOUT, 'send')).toEqual({})
      await settleFrames()
      expect(childHits()).toBeGreaterThan(0)
      expect(rootHits()).toBeGreaterThan(0)
      expect(h.state.value).toStrictEqual(await freshMount(session))
      expect(ha.state.value).toStrictEqual(
        await freshAgentMount(session, info.agentId, info.conversationId)
      )
      ha.release()
      h.release()
    },
    TIMEOUT
  )
})
