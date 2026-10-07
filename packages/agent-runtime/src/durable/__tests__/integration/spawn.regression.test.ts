/**
 * P2-11 · J10：phase-1 的 I1–I7 在有派生 agent 时照样成立（PIN-12：不改 I 用例，这里是「派生在场」的变体；
 * J10-05 的闸门 = 既有的 integration/*.test.ts 原封不动地通过）。
 */
import { InboxDoc, LiveDoc, UsageDoc, type EntryRecord } from '@earendil-works/pi-durable'
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, held, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, systemDeltas } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { bg } from './support/notices'
import { lines } from './support/scriptedModel'
import {
  agentStateOf,
  anchorTasks,
  childOfCall,
  liveTasks,
  ownedBy,
  recordOf,
  registerSpawnCleanup,
  resultOf,
  spawnWorld,
  transcriptOf,
  type SpawnWorld
} from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 15000
const RECOVERY_TIMEOUT = 20000

/** 当前进程里 s1 的注册表装没装某个扩展 */
function hasExtension(sw: SpawnWorld, name: string): boolean {
  return sw.world.t.registryOf('s1')?.snapshot().extension(name) !== undefined
}

async function entriesOf(session: DurableSession, id: number): Promise<EntryRecord[]> {
  return allEntries((await session.harness.conversation(id as never, BG))!)
}

/** 按模型（`provider/model`）累计 assistant 条目的 usage.input */
function assistantInputs(entries: readonly EntryRecord[]): Record<string, number> {
  const sums: Record<string, number> = {}
  for (const entry of entries) {
    const message = entry.model?.[0]
    if (entry.kind !== 'pi.assistant' || message?.role !== 'assistant') continue
    const key = `${message.provider}/${message.model}`
    sums[key] = (sums[key] ?? 0) + message.usage.input
  }
  return sums
}

describe('P2-11 · J10 phase-1 invariants with spawned agents present', () => {
  it(
    'J10-01 (I1-07) end-of-story invariants after a dispatch and a titler run',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      const lockBefore = structuredClone(session.lock)
      world.chat(
        callTool('mcp__ctx__whoami', {}, 'r-who'),
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn(
        'explore',
        callTool('read', { path: 'notes.txt' }, 'c-read'),
        answer('found')
      )
      world.model.chatIn(
        'titler',
        callTool('session', { action: 'set-title', title: 'Hooked title' }, 't-s'),
        answer('ok')
      )
      sw.fireTitle('go')
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})
      await waitFor(() => sw.ends('auto-title').length === 1, 3000, 'titler end')
      await waitFor(async () => (await liveTasks(session)).length === 0, 2000, 'no live tasks')

      const C = await childOfCall(session, 'r-agent')
      const [anchor] = await anchorTasks(session)
      const [T] = await ownedBy(session, anchor!.id)
      for (const id of [1, C, T!]) {
        const usage = await session.harness.snapshot(UsageDoc, id as never, BG)
        const ledger = Object.fromEntries(
          Object.entries(usage?.models ?? {}).map(([model, row]) => [model, row.input])
        )
        expect(ledger, `usage of conversation ${id}`).toEqual(
          assistantInputs(await entriesOf(session, id))
        )
        const live = (await session.harness.snapshot(LiveDoc, id as never, BG)) ?? {}
        for (const key of ['run', 'generation', 'tools']) {
          expect(Object.keys(live), `live of ${id}`).not.toContain(key)
        }
      }
      expect(session.lock).toEqual(lockBefore)
      const rootTools = world.model.laneRequests('root').map((request) => request.tools)
      expect(new Set(rootTools.map((tools) => JSON.stringify(tools))).size).toBe(1)
      expect(await systemDeltas(await session.currentConversation())).toHaveLength(1)
      const states = world.t.statesOf('s1')
      for (let index = 1; index < states.length; index++) {
        expect(states[index]).not.toBe(states[index - 1])
      }
    },
    TIMEOUT
  )

  it(
    'J10-02 (I5-01 / I5-03) a crash with an idle child: open rebuilds only the root lock; continue and a later send never rebuild the child; an idle restart clears the root lock (option A) and the next send creates it again, still without the child',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      const rootLock = structuredClone(session.lock)
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn('explore', answer('found'))
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})
      const C = await childOfCall(session, 'r-agent')
      expect(hasExtension(sw, `shuvix.agent.${C}`)).toBe(true)
      const preCrashTools = world.model.laneRequests('root').at(-1)!.tools
      const stall = stalled()
      world.chat(stall.step)
      void session.submitUser('second')
      await withTimeout(stall.reached, 3000, 'second turn requested')
      await withTimeout(sw.restart(), 10000, 'restart')

      const reopened = await sw.open()
      expect(world.toolHost.rebuildCalls).toEqual([rootLock])
      expect(hasExtension(sw, `shuvix.agent.${C}`)).toBe(false)
      expect(reopened.agentIdentity(C)).toMatchObject({ kind: 'spawned', profileName: 'explore' })
      expect(reopened.isInterrupted()).toBe(true)
      // 完整初始化：根锁记着的服务器当场连上（子 agent 的不连）
      expect([...world.mcp.connects.values()].reduce((sum, n) => sum + n, 0)).toBe(
        Object.keys(rootLock!.mcp).length
      )

      world.chat(answer('resumed'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(world.model.laneRequests('root').at(-1)!.tools).toEqual(preCrashTools)
      expect(world.toolHost.rebuildCalls).toEqual([rootLock])

      // 空闲时再换一次进程（option A：锁清掉、什么都不建），然后发送：按配置重新创建根 agent，照样不重建 C
      await withTimeout(sw.restart(), 10000, 'idle restart')
      // world.open：不经 sw.open 的「没锁就先建」，好看见打开本身清掉了锁
      const third = await world.open()
      expect(third.lock).toBeUndefined()
      world.chat(answer('more'))
      expect(await withTimeout(third.submitUser('more'), 5000, 'send')).toEqual({})
      expect(world.toolHost.rebuildCalls).toEqual([])
      expect(world.toolHost.resolveCalls).toHaveLength(1)
      expect(third.lock).toBeDefined()
      expect(hasExtension(sw, `shuvix.agent.${C}`)).toBe(false)
    },
    RECOVERY_TIMEOUT
  )

  it(
    'J10-03 (I6-01a) a notice while a child runs steers the root only, after the dispatch result',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      const t1 = bg('t1', 'done')
      const childAnswer = held(answer('found'))
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent'),
        answer('noted')
      )
      world.model.chatIn('explore', childAnswer.step)
      const rootRunsBefore = world.t.statesOf('s1').filter((state) => state === 'busy').length
      const sending = session.submitUser('go')
      await withTimeout(childAnswer.reached, 3000, 'child request')
      const C = await childOfCall(session, 'r-agent')
      await session.notify(t1)
      expect(
        (await session.harness.snapshot(InboxDoc, 1 as never, BG))?.items.map((item) => item.mode)
      ).toEqual(['steer'])
      expect((await session.harness.snapshot(InboxDoc, C, BG))?.items ?? []).toEqual([])

      childAnswer.release()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      expect(lines(world.model.laneRequests('root').at(-1)!).slice(-2)).toEqual([
        'toolResult:found',
        `user:${t1}`
      ])
      for (const request of world.model.laneRequests('explore')) {
        expect(JSON.stringify(request.messages)).not.toContain('t1')
      }
      const users = (await transcriptOf(session, 1)).filter((line) => line.startsWith('pi.user:'))
      expect(users.at(-1)).toBe(`pi.user:${t1}`)
      expect(isSystemNoticeText(t1)).toBe(true)
      await waitFor(() => world.t.statesOf('s1').at(-1) === 'idle', 1000, 'idle')
      expect(
        world.t.statesOf('s1').filter((state) => state === 'busy').length - rootRunsBefore
      ).toBe(1)
    },
    TIMEOUT
  )

  it(
    'J10-04 (I7-01) destroy with a running child, then recreate from a new selection: the next dispatch follows the new caller model',
    async () => {
      let beforeAbort = 0
      const sw = await spawnWorld({ host: { beforeAbort: () => void beforeAbort++ } })
      const { world } = sw
      const session = await sw.open()
      const childAnswer = held(answer('found'))
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent')
      )
      world.model.chatIn('explore', childAnswer.step)
      const sending = session.submitUser('go')
      await withTimeout(childAnswer.reached, 3000, 'child request')
      const C = await childOfCall(session, 'r-agent')
      const recordC = (await recordOf(session, C))!
      const stateBefore = await agentStateOf(session, C)
      expect(hasExtension(sw, 'shuvix.agent.1')).toBe(true)
      expect(hasExtension(sw, `shuvix.agent.${C}`)).toBe(true)

      await withTimeout(session.destroyAgent(), 3000, 'destroy')
      expect(await withTimeout(sending, 2000, 'send settles')).toEqual({})
      expect(beforeAbort).toBe(1)
      await waitFor(() => sw.router.ends().length === 1, 2000, 'router end')
      expect(sw.router.ends()).toEqual([
        expect.objectContaining({
          sessionId: recordC.agentId,
          result: 'ABORTED_NOTE',
          isError: true
        })
      ])
      expect(sw.router.task(recordC.agentId)?.status).toBe('killed')
      expect(session.lock).toBeUndefined()
      expect(hasExtension(sw, 'shuvix.agent.1')).toBe(false)
      expect(hasExtension(sw, `shuvix.agent.${C}`)).toBe(false)
      expect(
        world.t
          .broadcastsOf('agent_closing')
          .map((event) => (event as { closing: boolean }).closing)
      ).toEqual([true, false])
      expect(await agentStateOf(session, C)).toEqual(stateBefore)

      world.config.model = { provider: 'faux', modelId: 'tiny' }
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'again', description: 'look' }, 'r-agent2'),
        answer('recreated')
      )
      world.model.chatIn('explore', answer('found again'))
      expect(await withTimeout(session.submitUser('again'), 5000, 'again')).toEqual({})
      expect(session.lock?.model).toEqual({ provider: 'faux', modelId: 'tiny' })
      const D = await childOfCall(session, 'r-agent2')
      expect(D).not.toBe(C)
      expect((await recordOf(session, D))?.model).toEqual({ provider: 'faux', modelId: 'tiny' })
      expect((await recordOf(session, C))?.model).toEqual({ provider: 'faux', modelId: 'faux-1' })
      expect((await resultOf(session, 1, 'r-agent2')).text).toBe('found again')
      await sleep(0)
    },
    TIMEOUT
  )
})
