/**
 * P1-12 · 场景 3：压缩 —— 锁定 `tiny`（窗口 3000 / 输出 1000），思考关。真设置（PIN-1 之后
 * keepRecentTokens 随窗口缩放）：`{reserveTokens: 750, backgroundTokens: 750, keepRecentTokens: 750}`，
 * 于是阻塞阈值 2250、后台阈值 1500。
 *
 * 不把 token 算术写进期望：发到条件成立为止（有上限），断言结构 —— 条目种类与次序、`head` 的范围、
 * 请求开头的摘要。写死的数字只有 K14 那几个（750 / 600）与用量的不变式。摘要请求与聊天请求可能并发，
 * 所以模型一律是按内容分派的脚本（support/scriptedModel）。
 *
 * 档案工具缺省为空（系统提示词小、算术稳）；I3-03 要一个挂着的工具，用真 ask（卡片等人回答，观察 signal）。
 */
import {
  CompactionEntry,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type CompactionStatus,
  type EntryRecord
} from '@earendil-works/pi-durable'
import type { FauxResponseStep } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import type { ShuviXSettingsOverrides } from '../../settings'
import { answer, callTool, held, modelError } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, messageText } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { lines, textOf, type ScriptedRequest } from './support/scriptedModel'
import { choose, makeWorld, nextInput, registerWorldCleanup, type World } from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 20000

const SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n'
const OVERFLOW = 'prompt is too long: 3412 tokens > 3000 maximum'
const ASK_ARGS = {
  question: 'Which one?',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' }
  ]
}

/** 约 `repeat × 2` 个 token 的回答（'details ' 8 个字符 ≈ 2 token） */
function long(tag: string, repeat = 125): ReturnType<typeof answer> {
  return answer(`${tag} ${'details '.repeat(repeat)}`)
}

async function tinyWorld(
  settings: ShuviXSettingsOverrides,
  tools: string[] = []
): Promise<{ world: World; session: DurableSession }> {
  const world = await makeWorld({
    settings,
    modelId: 'tiny',
    thinkingLevel: 'off',
    tools,
    overlay: []
  })
  const session = await world.open()
  // 没锁：窗口未知 → 32768（K14）
  expect(session.effectiveSettings.compaction?.reserveTokens).toBe(32768)
  return { world, session }
}

function statuses(world: World): CompactionStatus[] {
  return world
    .recorder()
    .livesOf()
    .flatMap((live) => live.compactions ?? [])
}

/** 发到条件成立为止（至多 `max` 轮）；交回用了几轮 */
async function sendUntil(
  world: World,
  session: DurableSession,
  done: () => boolean,
  max = 8,
  reply: (turn: number) => FauxResponseStep = (turn) => long(`a${turn}`)
): Promise<number> {
  for (let turn = 1; turn <= max; turn++) {
    world.chat(reply(turn))
    expect(await withTimeout(session.submitUser(`q${turn}`), 5000, `turn ${turn}`)).toEqual({})
    if (done()) return turn
  }
  throw new Error(`condition not reached within ${max} turns`)
}

const compactionListed = (world: World) => (): boolean => statuses(world).length > 0

function firstMessageText(request: ScriptedRequest): string {
  return textOf(request.messages.find((message) => message.role !== 'system'))
}

async function entries(session: DurableSession): Promise<EntryRecord[]> {
  return allEntries(await session.currentConversation())
}

async function compactions(session: DurableSession): Promise<EntryRecord[]> {
  return (await entries(session)).filter((entry) => CompactionEntry.is(entry))
}

function reasonOf(entry: EntryRecord): unknown {
  return (entry.data as { reason?: unknown } | undefined)?.reason
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

async function ledgerInput(session: DurableSession): Promise<number> {
  const conversation = await session.currentConversation()
  return (
    (await session.harness.snapshot(UsageDoc, conversation.id, BG))?.models['faux/tiny']?.input ?? 0
  )
}

async function liveCompactions(session: DurableSession): Promise<CompactionStatus[] | undefined> {
  const conversation = await session.currentConversation()
  return (await session.harness.snapshot(LiveDoc, conversation.id, BG))?.compactions
}

describe('P1-12 · compaction', () => {
  it(
    'I3-01 background compaction does not block; the summary lands at once when idle and heads the next request',
    async () => {
      const { world, session } = await tinyWorld({ retry: { enabled: false } })
      const summary = held(answer('## Goal\nthe trip'))
      world.model.summary(summary.step)
      await sendUntil(world, session, compactionListed(world))
      expect(session.effectiveSettings.compaction).toEqual({
        reserveTokens: 750,
        backgroundTokens: 750,
        keepRecentTokens: 750
      })

      await withTimeout(summary.reached, 3000, 'summary request')
      expect(statuses(world)[0]).toMatchObject({ reason: 'threshold', blocking: false, attempt: 1 })
      expect(await liveCompactions(session)).toHaveLength(1)
      expect(session.isBusy()).toBe(false)
      await waitFor(() => session.runState === 'busy', 1000, 'background compaction counts as busy')
      const request = world.model.summaries[0]!
      expect(request.options?.maxTokens).toBe(600)
      expect(request.options?.cacheRetention).toBe('none')

      summary.release()
      await waitFor(async () => (await compactions(session)).length === 1, 3000, 'summary placed')
      const all = await entries(session)
      const placed = all.at(-1)!
      expect(CompactionEntry.is(placed)).toBe(true)
      expect(reasonOf(placed)).toBe('threshold')
      const firstUser = all.find((entry) => entry.kind === 'pi.user')!
      expect(placed.head).toBeGreaterThan(firstUser.id)
      await waitFor(
        async () => (await liveCompactions(session)) === undefined,
        2000,
        'status removed'
      )
      await waitFor(() => session.runState === 'idle', 2000, 'idle')

      world.chat(answer('after'))
      expect(await session.submitUser('next')).toEqual({})
      const next = world.model.chats.at(-1)!
      expect(firstMessageText(next).startsWith(SUMMARY_PREFIX)).toBe(true)
      expect(lines(next)).not.toContain('user:q1')
      const finalEntries = await entries(session)
      expect(await ledgerInput(session)).toBeGreaterThan(assistantInputSum(finalEntries))
    },
    TIMEOUT
  )

  it(
    'I3-02 a summary that is ready during a busy run waits in the inbox and lands at the final boundary',
    async () => {
      const { world, session } = await tinyWorld({ retry: { enabled: false } })
      const summary = held(answer('## Goal\nbusy summary'))
      world.model.summary(summary.step)
      const k = await sendUntil(world, session, compactionListed(world))
      await withTimeout(summary.reached, 3000, 'summary request')
      const status = statuses(world)[0]!

      const reply = held(answer(`a${k + 1}`))
      world.chat(reply.step)
      const sending = session.submitUser(`q${k + 1}`)
      await withTimeout(reply.reached, 3000, 'answer requested')
      summary.release()
      const conversation = await session.currentConversation()
      let itemId: number | undefined
      await waitFor(
        async () => {
          const inbox = await session.harness.snapshot(InboxDoc, conversation.id, BG)
          const item = inbox?.items.find(
            (candidate) =>
              candidate.mode === 'write' &&
              (candidate.entry as { kind?: string }).kind === CompactionEntry.kind
          )
          itemId = item?.id as number | undefined
          return item !== undefined
        },
        3000,
        'summary queued as a write'
      )
      const record = await (await session.harness.submission(itemId as never, BG))!.status(BG)
      expect(record.requestId).toBe(`compaction:${status.taskId}`)

      reply.release()
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      const tail = (await entries(session)).slice(-3)
      expect(tail.map((entry) => entry.kind)).toEqual([
        'pi.user',
        'pi.assistant',
        CompactionEntry.kind
      ])
      expect(messageText(tail[0]!.model?.[0])).toBe(`q${k + 1}`)

      world.chat(answer('after'))
      expect(await session.submitUser('next')).toEqual({})
      expect(firstMessageText(world.model.chats.at(-1)!).startsWith(SUMMARY_PREFIX)).toBe(true)
    },
    TIMEOUT
  )

  it(
    'I3-03 a summary ready mid-run lands at the postTools boundary: the same run’s next request keeps the call/result pair',
    async () => {
      const { world, session } = await tinyWorld({ retry: { enabled: false } }, ['ask'])
      const summary = held(answer('## Goal\nmid-run summary'))
      world.model.summary(summary.step)
      const k = await sendUntil(world, session, compactionListed(world))
      await withTimeout(summary.reached, 3000, 'summary request')

      world.chat(callTool('ask', ASK_ARGS, 'c-a'), answer('chose'))
      const sending = session.submitUser(`q${k + 1}`)
      await nextInput(world, 'c-a')
      summary.release()
      const conversation = await session.currentConversation()
      await waitFor(
        async () =>
          ((await session.harness.snapshot(InboxDoc, conversation.id, BG))?.items ?? []).some(
            (item) => item.mode === 'write'
          ),
        3000,
        'summary queued'
      )
      const chatsBefore = world.model.chats.length
      choose(world, 'c-a', ['A'])
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})

      const all = await entries(session)
      const resultIndex = all.findIndex((entry) => entry.kind === 'pi.tool-result')
      expect(all[resultIndex + 1]?.kind).toBe(CompactionEntry.kind)
      const sameRun = world.model.chats[chatsBefore]!
      const rendered = lines(sameRun)
      expect(rendered[0]!.startsWith(`user:${SUMMARY_PREFIX}`)).toBe(true)
      expect(rendered.slice(-3)).toEqual([
        `user:q${k + 1}`,
        'assistant:[tool:ask]',
        'toolResult:User selected: A'
      ])
    },
    TIMEOUT
  )

  it(
    'I3-04 overflow → one blocking compaction → the request is retried once and succeeds',
    async () => {
      const { world, session } = await tinyWorld({
        retry: { enabled: false },
        compaction: { backgroundTokens: 0 }
      })
      world.chat(long('a1', 200))
      expect(await session.submitUser('q1')).toEqual({})
      world.chat(long('a2', 200))
      expect(await session.submitUser('q2')).toEqual({})
      world.chat(modelError(OVERFLOW), answer('a3'))
      expect(await withTimeout(session.submitUser('q3'), 5000, 'q3')).toEqual({})

      expect(statuses(world).map(({ reason, blocking }) => ({ reason, blocking }))).toEqual([
        { reason: 'overflow', blocking: true }
      ])
      expect(world.model.requests.map((request) => request.kind).slice(-3)).toEqual([
        'chat',
        'summary',
        'chat'
      ])
      expect(world.model.summaries).toHaveLength(1)
      const all = await entries(session)
      const tail = all.filter((entry) => entry.kind !== 'pi.system').slice(-4)
      expect(tail.map((entry) => entry.kind)).toEqual([
        'pi.user',
        'pi.assistant',
        CompactionEntry.kind,
        'pi.assistant'
      ])
      expect(messageText(tail[0]!.model?.[0])).toBe('q3')
      const failed = tail[1]!.model?.[0]
      expect(failed?.role === 'assistant' && failed.stopReason).toBe('error')
      expect(failed?.role === 'assistant' && failed.errorMessage).toBe(OVERFLOW)
      expect(reasonOf(tail[2]!)).toBe('overflow')
      expect(messageText(tail[3]!.model?.[0])).toBe('a3')

      const retried = world.model.chats.at(-1)!
      expect(firstMessageText(retried).startsWith(SUMMARY_PREFIX)).toBe(true)
      expect(
        retried.messages.some(
          (message) => message.role === 'assistant' && message.stopReason === 'error'
        )
      ).toBe(false)
      expect(lines(retried).at(-1)).toBe('user:q3')
      expect(
        world
          .recorder()
          .livesOf()
          .some((live) => live.generation?.retry !== undefined)
      ).toBe(false)

      // 用量：报错的那一次请求与摘要都记了账
      expect(failed?.role === 'assistant' && failed.usage.input).toBeGreaterThan(0)
      expect(await ledgerInput(session)).toBeGreaterThan(assistantInputSum(all))
    },
    TIMEOUT
  )

  it(
    'I3-04b the summarizer gets a 503 during the overflow compaction: it retries (attempt 2) and the end state is the same',
    async () => {
      const { world, session } = await tinyWorld({
        retry: { enabled: true, baseDelayMs: 5 },
        compaction: { backgroundTokens: 0 }
      })
      world.model.summary(modelError('503 Service Unavailable'))
      world.chat(long('a1', 200))
      expect(await session.submitUser('q1')).toEqual({})
      world.chat(long('a2', 200))
      expect(await session.submitUser('q2')).toEqual({})
      world.chat(modelError(OVERFLOW), answer('a3'))
      expect(await withTimeout(session.submitUser('q3'), 5000, 'q3')).toEqual({})

      const seen = statuses(world)
      expect(seen.some((status) => status.retry?.error.includes('503'))).toBe(true)
      expect(seen.some((status) => status.attempt === 2)).toBe(true)
      expect(seen.every((status) => status.reason === 'overflow' && status.blocking)).toBe(true)
      expect(world.model.summaries).toHaveLength(2)
      const tail = (await entries(session)).filter((entry) => entry.kind !== 'pi.system').slice(-3)
      expect(tail.map((entry) => entry.kind)).toEqual([
        'pi.assistant',
        CompactionEntry.kind,
        'pi.assistant'
      ])
      expect(reasonOf(tail[1]!)).toBe('overflow')
      expect(messageText(tail[2]!.model?.[0])).toBe('a3')
      expect(await liveCompactions(session)).toBeUndefined()
    },
    TIMEOUT
  )

  it(
    'I3-05 overflow under the real settings (PIN-1: keepRecentTokens scales) compacts and retries instead of failing',
    async () => {
      const { world, session } = await tinyWorld({ retry: { enabled: false } })
      world.chat(long('a1', 200))
      expect(await session.submitUser('q1')).toEqual({})
      world.chat(long('a2', 200))
      expect(await session.submitUser('q2')).toEqual({})
      expect(statuses(world)).toEqual([])
      world.chat(modelError(OVERFLOW), answer('a3'))
      expect(await withTimeout(session.submitUser('q3'), 5000, 'q3')).toEqual({})

      const placed = await compactions(session)
      expect(placed.map(reasonOf)).toEqual(['overflow'])
      expect(world.model.summaries).toHaveLength(1)
      expect(messageText((await entries(session)).at(-1)!.model?.[0])).toBe('a3')
    },
    TIMEOUT
  )

  it(
    'I3-05b with an explicit large keepRecentTokens no cut exists: the overflow ends as model_error, nothing is summarized',
    async () => {
      const { world, session } = await tinyWorld({
        retry: { enabled: false },
        compaction: { keepRecentTokens: 20000 }
      })
      world.chat(long('a1', 200))
      expect(await session.submitUser('q1')).toEqual({})
      world.chat(long('a2', 200))
      expect(await session.submitUser('q2')).toEqual({})
      world.chat(modelError(OVERFLOW))
      expect(await withTimeout(session.submitUser('q3'), 5000, 'q3')).toEqual({
        error: OVERFLOW,
        code: 'model_error'
      })
      expect(await compactions(session)).toEqual([])
      expect(world.model.summaries).toEqual([])
    },
    TIMEOUT
  )

  it(
    'I3-06 above the blocking threshold the request waits for the compaction, then goes out as [summary, a2, q3]',
    async () => {
      const { world, session } = await tinyWorld({
        retry: { enabled: false },
        compaction: { backgroundTokens: 0 }
      })
      world.chat(long('a1', 600))
      expect(await session.submitUser('q1')).toEqual({})
      world.chat(long('a2', 600))
      expect(await session.submitUser('q2')).toEqual({})
      const summary = held(answer('## Goal\nblocking summary'))
      world.model.summary(summary.step)
      world.chat(answer('a3'))
      const chatsBefore = world.model.chats.length
      const sending = session.submitUser('q3')
      await withTimeout(summary.reached, 3000, 'summary request')
      expect(statuses(world)).toEqual([
        expect.objectContaining({ reason: 'threshold', blocking: true })
      ])
      await sleep(100)
      expect(world.model.chats.length).toBe(chatsBefore)
      summary.release()
      expect(await withTimeout(sending, 5000, 'q3')).toEqual({})

      const tail = (await entries(session)).filter((entry) => entry.kind !== 'pi.system').slice(-3)
      expect(tail.map((entry) => entry.kind)).toEqual([
        'pi.user',
        CompactionEntry.kind,
        'pi.assistant'
      ])
      expect(messageText(tail[0]!.model?.[0])).toBe('q3')
      expect(messageText(tail[2]!.model?.[0])).toBe('a3')
      const request = lines(world.model.chats.at(-1)!)
      expect(request).toHaveLength(3)
      expect(request[0]!.startsWith(`user:${SUMMARY_PREFIX}`)).toBe(true)
      expect(request[1]!.startsWith('assistant:a2 ')).toBe(true)
      expect(request[2]).toBe('user:q3')
    },
    TIMEOUT
  )

  it(
    'I3-07 a crash during background compaction: reopen reports idle once (PIN-R); the leftover compaction is abort-marked at open (option A: no work to resume, so the lock goes too) and stays paused; a later write starts the scheduler and it ends aborted without any model call; the next send runs on a freshly created agent',
    async () => {
      const { world, session } = await tinyWorld({ retry: { enabled: false } })
      const summary = held(answer('## Goal\nnever arrives'))
      world.model.summary(summary.step)
      await sendUntil(world, session, compactionListed(world))
      await withTimeout(summary.reached, 3000, 'summary request')
      expect(session.runState).toBe('busy')
      const leftover = statuses(world)[0]!.taskId

      await withTimeout(world.restart(), 10000, 'restart')
      const reopened = await world.open()
      expect(reopened.isInterrupted()).toBe(false)
      expect(reopened.runState).toBe('idle')
      expect(world.t.statesOf('s1')).toEqual(['idle'])
      expect(reopened.lock).toBeUndefined()
      expect(await reopened.taskLiveness(leftover)).toEqual({ live: true, abortRequested: true })
      expect(await liveCompactions(reopened)).toHaveLength(1)
      await sleep(150)
      expect(world.model.requests).toEqual([])
      expect(world.t.kit.callCount).toBe(0)

      // 一条写入的通知开启调度器：打了标记的压缩走中止分支收场，从不调模型
      expect(
        await reopened.writeNotice({ text: 'build finished', kind: 'background' })
      ).toMatchObject({ status: 'submitted' })
      await waitFor(
        async () => (await reopened.taskLiveness(leftover))?.live === false,
        3000,
        'leftover compaction ended'
      )
      await waitFor(
        async () => (await liveCompactions(reopened)) === undefined,
        3000,
        'status removed'
      )
      await sleep(100)
      expect(world.model.requests).toEqual([])
      expect(world.t.kit.callCount).toBe(0)
      expect(reopened.lock).toBeUndefined()

      // 下一次发送按此刻的配置重新创建 agent
      world.chat(answer('resumed'))
      expect(await withTimeout(reopened.submitUser('next'), 5000, 'next')).toEqual({})
      expect(reopened.lock).toBeDefined()
      expect(world.toolHost.resolveCalls).toHaveLength(1)
      expect(world.model.chats).toHaveLength(1)
      await waitFor(() => reopened.runState === 'idle', 5000, 'idle')
    },
    TIMEOUT
  )

  it.todo(
    'I3-07b a background summary that finished but still waits in the inbox suppresses the next threshold compaction (defect, pi-durable generation.ts thresholdCompaction: it only checks `pi.live.compactions`, not queued `pi.compaction` writes — unheld, I3-07 placed two summaries back to back)'
  )
})
