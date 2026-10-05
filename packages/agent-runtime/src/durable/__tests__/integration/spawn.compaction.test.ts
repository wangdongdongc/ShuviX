/**
 * P2-11 · J5：派生 agent 的小窗口压缩（真缩放设置，只关重试）。子 agent 用 `smallctx`（tiny：3000 / 输出
 * 1000）：压缩余量按「锁定模型 + 在跑的派生模型」里最小的窗口算（Q-P2-08），压缩只发生在子对话里；后台压缩
 * 不拖住派发工具任务，但在落定之前会话的运行状态仍是忙（PIN-07）。
 */
import {
  CompactionEntry,
  LiveDoc,
  UsageDoc,
  type CompactionStatus,
  type EntryRecord
} from '@earendil-works/pi-durable'
import { afterEach, describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { answer, callTool, held, modelError } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, messageText } from '../support/transcript'
import { waitFor, withTimeout } from '../support/wait'
import { lines, textOf, when } from './support/scriptedModel'
import {
  childOfCall,
  fate,
  releaseHolds,
  resultOf,
  spawnWorld,
  toolTaskOf,
  type SpawnWorld
} from './support/spawnWorld'
import { registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
afterEach(() => releaseHolds())

const TIMEOUT = 20000
const SETTINGS = { retry: { enabled: false } }
const SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const OVERFLOW = 'prompt is too long: 3412 tokens > 3000 maximum'
const ROOT_TEXT = 'root-only request text'

async function entriesOf(session: DurableSession, id: number): Promise<EntryRecord[]> {
  const conversation = await session.harness.conversation(id as never, BG)
  return allEntries(conversation!)
}

function assistantInputSum(list: readonly EntryRecord[]): number {
  return list.reduce((sum, entry) => {
    const message = entry.model?.[0]
    return (
      sum +
      (entry.kind === 'pi.assistant' && message?.role === 'assistant' ? message.usage.input : 0)
    )
  }, 0)
}

/** 记录器里出现过的压缩状态（按对话；同一个压缩任务的多次发布只算一次） */
function compactionsSeen(sw: SpawnWorld, conversationId?: number): CompactionStatus[] {
  const seen = new Map<number, CompactionStatus>()
  for (const doc of sw.world.recorder().live) {
    const matches =
      conversationId === undefined ? doc.conversationId !== 1 : doc.conversationId === conversationId
    if (!matches) continue
    for (const status of doc.value.compactions ?? []) {
      if (!seen.has(status.taskId as number)) seen.set(status.taskId as number, status)
    }
  }
  return [...seen.values()]
}

describe('P2-11 · J5 small-window compaction of a spawned agent', () => {
  it(
    'J5-01 background compaction inside the child: the window is the child model’s, only the child compacts, root finishes first',
    async () => {
      const sw = await spawnWorld({ settings: SETTINGS })
      const { world } = sw
      const session = await sw.open()
      expect(session.effectiveSettings.compaction?.reserveTokens).toBe(10000)
      const summary = held(answer('## Goal\nchild summary'))
      world.model.summary(summary.step)
      world.chat(
        callTool('agent', { name: 'smallctx', prompt: 'probe a lot', description: 'p' }, 'r-agent'),
        answer('root done')
      )
      let rounds = 0
      const probing = when(() => {
        if (compactionsSeen(sw).length > 0 || rounds >= 10) return answer('child done')
        rounds++
        return callTool('probe', { text: 'details '.repeat(125) }, `p${rounds}`)
      })
      world.model.chatIn('smallctx', ...Array.from({ length: 11 }, () => probing))

      const sending = session.submitUser(ROOT_TEXT)
      await withTimeout(summary.reached, 8000, 'summary request')
      expect(session.effectiveSettings.compaction).toEqual({
        reserveTokens: 750,
        backgroundTokens: 750,
        keepRecentTokens: 750
      })
      const request = world.model.summaries[0]!
      expect(request.modelId).toBe('tiny')
      expect(request.options?.maxTokens).toBe(600)
      expect(request.options?.cacheRetention).toBe('none')
      expect(request.messages.map((message) => textOf(message)).join('\n')).not.toContain(
        ROOT_TEXT
      )
      const C = await childOfCall(session, 'r-agent')
      expect(
        compactionsSeen(sw, C).map(({ reason, blocking }) => ({ reason, blocking }))
      ).toEqual([{ reason: 'threshold', blocking: false }])
      expect(compactionsSeen(sw, 1)).toEqual([])

      // 摘要还扣着：根照样拿到回答、发送落定；运行状态在摘要落定之前仍是忙
      expect(await withTimeout(sending, 8000, 'send')).toEqual({})
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('child done')
      expect(session.runState).toBe('busy')

      summary.release()
      await waitFor(
        async () => (await entriesOf(session, C)).at(-1)?.kind === CompactionEntry.kind,
        3000,
        'summary placed'
      )
      const placed = (await entriesOf(session, C)).at(-1)!
      expect((placed.data as { reason?: string }).reason).toBe('threshold')
      expect((await entriesOf(session, 1)).some((entry) => CompactionEntry.is(entry))).toBe(false)
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      await waitFor(
        async () => (await session.harness.snapshot(LiveDoc, C as never, BG))?.compactions === undefined,
        2000,
        'child status removed'
      )
      expect(session.effectiveSettings.compaction?.reserveTokens).toBe(10000)
      const childUsage = await session.harness.snapshot(UsageDoc, C as never, BG)
      expect(childUsage!.models['faux/tiny']!.input).toBeGreaterThan(
        assistantInputSum(await entriesOf(session, C))
      )
      const rootUsage = await session.harness.snapshot(UsageDoc, 1 as never, BG)
      expect(Object.keys(rootUsage!.models)).not.toContain('faux/tiny')
    },
    TIMEOUT
  )

  it(
    'J5-02 overflow inside the child: one blocking compaction between the failing and the retried request; the dispatch completes',
    async () => {
      const sw = await spawnWorld({ settings: SETTINGS })
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTool('agent', { name: 'smallctx', prompt: 'probe', description: 'p' }, 'r-agent'),
        answer('root done')
      )
      world.model.chatIn(
        'smallctx',
        callTool('probe', { text: 'details '.repeat(100) }, 'p1'),
        callTool('probe', { text: 'details '.repeat(100) }, 'p2'),
        modelError(OVERFLOW),
        answer('child ok')
      )
      expect(await withTimeout(session.submitUser('go'), 8000, 'send')).toEqual({})

      const C = await childOfCall(session, 'r-agent')
      expect(
        compactionsSeen(sw, C).map(({ reason, blocking }) => ({ reason, blocking }))
      ).toEqual([{ reason: 'overflow', blocking: true }])
      const kinds = world.model.requests
        .filter((request) => request.lane === 'smallctx' || request.kind === 'summary')
        .map((request) => request.kind)
      expect(kinds.slice(-3)).toEqual(['chat', 'summary', 'chat'])
      expect(world.model.summaries).toHaveLength(1)
      const tail = (await entriesOf(session, C)).filter((entry) => entry.kind !== 'pi.system').slice(-3)
      expect(tail.map((entry) => entry.kind)).toEqual([
        'pi.assistant',
        CompactionEntry.kind,
        'pi.assistant'
      ])
      const failed = tail[0]!.model?.[0]
      expect(failed?.role === 'assistant' && failed.stopReason).toBe('error')
      expect((tail[1]!.data as { reason?: string }).reason).toBe('overflow')
      expect(messageText(tail[2]!.model?.[0])).toBe('child ok')
      const retried = world.model.laneRequests('smallctx').at(-1)!
      expect(lines(retried)[0]!.startsWith(`user:${SUMMARY_PREFIX}`)).toBe(true)
      expect(
        world
          .recorder()
          .live.some((doc) => doc.value.generation?.retry !== undefined)
      ).toBe(false)
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('child ok')
      expect(sw.router.ends()).toEqual([expect.objectContaining({ isError: false })])
      expect(fate((await toolTaskOf(session, 1, 'r-agent')) as never)).toBe('completed')
    },
    TIMEOUT
  )
})
