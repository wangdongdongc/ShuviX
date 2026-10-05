/**
 * P2-11 · J9：titler 是辅助工作，跑在一个派生子 agent 旁边。真 hook runner（内置 auto-title md）→ 真路由 →
 * 真协调器派出内置 titler：它的对话归会话当前对话里一个后台锚任务（Q-P2-07），不进运行状态、不算中断、
 * 不进根的转写与摘要。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readTranscriptDigest } from '../../transcriptDigest'
import { answer, callTool, held } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { waitFor, withTimeout } from '../support/wait'
import {
  anchorTasks,
  childOfCall,
  liveTasks,
  ownedBy,
  ownerOf,
  recordOf,
  releaseHolds,
  spawnWorld,
  transcriptOf
} from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
afterEach(() => releaseHolds())

const TIMEOUT = 15000

describe('P2-11 · J9 the titler is auxiliary beside a child', () => {
  it(
    'J9-01 a titler runs beside a dispatched child: anchor-owned, invisible to run state, interruption, transcripts and the digest',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      const statesBefore = world.t.statesOf('s1').length
      const childAnswer = held(answer('found'))
      const rootAnswer = held(answer('done'))
      const titleCall = held(
        callTool('session', { action: 'set-title', title: 'Hooked title' }, 't-s')
      )
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent'),
        rootAnswer.step
      )
      world.model.chatIn('explore', childAnswer.step)
      world.model.chatIn('titler', titleCall.step, answer('ok'))

      const sending = session.submitUser('go')
      sw.fireTitle('go')
      await withTimeout(Promise.all([childAnswer.reached, titleCall.reached]), 3000, 'requests')
      expect(session.isInterrupted()).toBe(false)

      const [anchor] = await anchorTasks(session)
      expect(anchor).toBeDefined()
      expect(anchor!.background).toBe(true)
      expect(anchor!.conversationId).toBe(1)
      const [T] = await ownedBy(session, anchor!.id)
      expect(await ownerOf(session, T!)).toEqual({ conversationId: 1, taskId: anchor!.id })
      const record = (await recordOf(session, T!))!
      expect(record).toMatchObject({
        dispatch: 'hook',
        hook: 'auto-title',
        profileName: 'titler',
        toolNames: ['session']
      })
      const [titlerRequest] = world.model.laneRequests('titler')
      expect(titlerRequest!.modelId).toBe('faux-1')
      expect(titlerRequest!.reasoning).toBeUndefined()

      childAnswer.release()
      await withTimeout(rootAnswer.reached, 3000, 'root final request')
      expect(session.isInterrupted()).toBe(false)
      rootAnswer.release()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      await waitFor(() => world.t.statesOf('s1').at(-1) === 'idle', 2000, 'idle')
      // 那次 idle 发出时 titler 与它的锚都还活着
      const live = await liveTasks(session)
      expect(live.some((task) => task.conversationId === T)).toBe(true)
      expect(live.some((task) => task.id === anchor!.id)).toBe(true)
      expect(session.isInterrupted()).toBe(false)

      titleCall.release()
      await waitFor(() => sw.ends('auto-title').length === 1, 3000, 'titler end')
      expect(sw.ends('auto-title')[0]).toMatchObject({ ok: true })
      await waitFor(async () => (await liveTasks(session)).length === 0, 2000, 'no live tasks')
      expect(world.t.statesOf('s1').slice(statesBefore)).toEqual(['busy', 'idle'])
      expect(session.isInterrupted()).toBe(false)

      expect(sw.sessionCalls).toEqual([
        {
          action: 'set-title',
          title: 'Hooked title',
          conversationId: T,
          identity: expect.objectContaining({
            kind: 'spawned',
            profileName: 'titler',
            callerId: record.agentId
          })
        }
      ])

      const C = await childOfCall(session, 'r-agent')
      const registers = sw.router.registers()
      expect(registers).toHaveLength(2)
      expect(registers.find((r) => r.subAgentName === 'explore')?.parentToolCallId).toBe('r-agent')
      expect(registers.find((r) => r.subAgentName === 'titler')?.parentToolCallId).toBeUndefined()
      expect(sw.router.ends().map((end) => end.isError)).toEqual([false, false])
      expect(sw.router.tasks?.runningCount('s1', 'agent')).toBe(0)

      for (const id of [1, C]) {
        expect((await transcriptOf(session, id)).join('\n')).not.toContain('<hook_event')
      }
      const digest = await readTranscriptDigest(session)
      expect(digest.items.filter((item) => item.kind === 'user')).toEqual([
        expect.objectContaining({ text: 'go' })
      ])
      expect(JSON.stringify(digest)).not.toContain('Hooked title')
      expect(JSON.stringify(digest)).not.toContain('hook_event')
      expect(
        (await transcriptOf(session, T!)).filter((line) => line.startsWith('pi.user:'))
      ).toHaveLength(1)
    },
    TIMEOUT
  )
})
