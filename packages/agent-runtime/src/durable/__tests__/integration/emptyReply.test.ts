/**
 * 空回复追问，端到端（`emptyReply.ts`，挂在 `shuvix.builtin` 的 `pi.generation` onYield 上）：工具跑完之后
 * 模型的回复既没有正文也没有工具调用（只有思考 / 只有空白 / 干脆是空的；stopReason stop，或没有调用的
 * toolUse），这次运行不当作答完 —— 追加一条 `<empty-reply>` 的 user 通知，同一个 run 接着跑。
 *
 *   B1 基本流：T → Ethink → N → done，三次请求、一个运行区间、submitUser 只在 done 之后落定一次
 *   B2 同上，空回复换成 E∅ / 只有空白 / 没有调用的 toolUse
 *   B3 不追问：有正文、length、回复跟在用户插话之后、回复跟在用户消息之后、第二轮的空回复
 *   B4 自我封顶：追问之后再空 → 照常结束（done，不是错误）
 *   B5 每个工具结果至多一次，不是每个 run 一次
 *   B6 用户输入优先：这次边界放下了 followUp / steer 时 pi 忽略 continue
 *   B7 中止：扣住的空回复被中止不追问；追问之后的请求被中止，通知留着，下一次发送照常
 *   B8 模型出错：不重试的错误不追问；可重试的错误夹在工具结果与空回复之间，照样追问（往回找跳过出错的助手消息）
 *   B9 运行生命周期：恰好一对 started / ended ok；视图里追问是一行空回复通知（isSystemNotice + noticeKind）
 *   B10 换进程：追问写下之后的请求被中断，重开后 continue 接着从追问往下走，不重复追问
 *   B11 销毁后重建的 agent 照样追问（创建时重装的 `shuvix.builtin` 带着 hook）
 *
 * 脚本卫生：`registerWorldCleanup` 在脚本被用完（多出一次请求）时让用例失败，所以「不追问」的用例只给
 * 空回复本身排脚本。
 */
import { fauxText, fauxThinking, type AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import type { DurableSession } from '../../durableSession'
import { EMPTY_REPLY_NOTICE_TEXT as N } from '../../emptyReply'
import type { ShuviXSettingsOverrides } from '../../settings'
import { answer, assistantWith, callTool, held, modelError, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, messageText, midRunNoted, transcript } from '../support/transcript'
import { waitFor, withTimeout } from '../support/wait'
import { bare, recordLifecycle, settleFrames } from '../../projection/__tests__/projectorSupport'
import { lines } from './support/scriptedModel'
import { allow, makeWorld, nextInput, registerWorldCleanup, type World } from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 10000
const RECOVERY_TIMEOUT = 20000

const READ = { path: 'notes.txt' }
const T = (id = 'c1'): AssistantMessage => callTool('read', READ, id)
const Ethink = (): AssistantMessage => assistantWith([fauxThinking('I will read it')])
const E0 = (): AssistantMessage => assistantWith([])
const USER_N = `user:${N}`

/** 当前对话的转写（`<kind>:<text>`，不含 pi.system） */
async function tx(session: DurableSession): Promise<string[]> {
  return transcript(await session.currentConversation())
}

/** 当前对话里正文是追问的 pi.user 条目数 */
async function noticeCount(session: DurableSession): Promise<number> {
  return (await allEntries(await session.currentConversation())).filter(
    (entry) => entry.kind === 'pi.user' && messageText(entry.model?.[0]) === N
  ).length
}

/** 运行状态镜像里的「busy → idle」区间数 */
function runSpans(world: World, sessionId = 's1'): number {
  const states = world.t.statesOf(sessionId)
  let spans = 0
  for (let i = 1; i < states.length; i++) {
    if (states[i - 1] === 'busy' && states[i] !== 'busy') spans++
  }
  return spans
}

async function settled(world: World, spans: number, sessionId = 's1'): Promise<void> {
  await waitFor(
    () => runSpans(world, sessionId) >= spans && world.session(sessionId).runState === 'idle',
    3000,
    `${spans} run span(s)`
  )
}

describe('empty reply after tool results · the nudge', () => {
  it(
    'B1 T → Ethink → N → done: three requests, the third ends with the empty reply then N; one run span; submitUser settles once after done',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T(), Ethink(), answer('done'))
      let settledAt: string[] | undefined
      const sending = session.submitUser('go').then(async (result) => {
        settledAt = await tx(session)
        return result
      })
      expect(await withTimeout(sending, 5000, 'send')).toEqual({})

      const transcriptLines = await tx(session)
      expect(transcriptLines).toEqual([
        'pi.user:go',
        'pi.assistant:[tool:read]',
        expect.stringMatching(/^pi\.tool-result:/),
        'pi.assistant:',
        `pi.user:${N}`,
        'pi.assistant:done'
      ])
      // 落定那一刻 done 已经写下（不是在空回复处落定、之后才续上）
      expect(settledAt?.at(-1)).toBe('pi.assistant:done')

      expect(world.model.chats).toHaveLength(3)
      const third = lines(world.model.chats[2]!)
      expect(third.slice(-2)).toEqual(['assistant:', USER_N])
      expect(third.at(-3)).toMatch(/^toolResult:/)
      expect(await session.lastAnswer()).toEqual({ text: 'done' })
      await settled(world, 1)
      expect(runSpans(world)).toBe(1)
      expect(world.t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
      expect(world.t.warnings).toEqual([])
    },
    TIMEOUT
  )

  it(
    'B9 the run lifecycle: exactly one started and one ended{ok}; the view shows N as an empty-reply notice, not a user message',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      const projector = await session.projector()
      const handle = projector.acquire()
      const lifecycle = recordLifecycle(projector, handle.state)
      world.chat(T(), Ethink(), answer('done'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      await settleFrames()
      expect(
        bare(lifecycle.signals).map((signal) => [
          signal.kind,
          'reason' in signal ? signal.reason : undefined
        ])
      ).toEqual([
        ['started', undefined],
        ['ended', 'ok']
      ])
      const view = handle.state.value
      const notice = view.messages.find((message) => message.content === N)
      expect(notice).toMatchObject({
        role: 'user',
        type: 'text',
        metadata: { isSystemNotice: true, noticeKind: 'empty-reply' }
      })
      expect(view.messages.at(-1)!.content).toBe('done')
      lifecycle.stop()
      handle.release()
    },
    TIMEOUT
  )

  it.each([
    ['a completely empty reply', E0],
    ['whitespace-only text', () => answer('  \n')],
    [
      'toolUse with no calls (thinking only)',
      () => assistantWith([fauxThinking('x')], { stopReason: 'toolUse' })
    ]
  ])(
    'B2 %s after a tool result is nudged exactly like B1',
    async (_label, empty) => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T(), empty(), answer('done'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      const transcriptLines = await tx(session)
      expect(transcriptLines.slice(-2)).toEqual([`pi.user:${N}`, 'pi.assistant:done'])
      expect(await noticeCount(session)).toBe(1)
      expect(world.model.chats).toHaveLength(3)
      expect(lines(world.model.chats[2]!).at(-1)).toBe(USER_N)
      expect(await session.lastAnswer()).toEqual({ text: 'done' })
      await settled(world, 1)
      expect(runSpans(world)).toBe(1)
      expect(world.t.warnings).toEqual([])
    },
    TIMEOUT
  )
})

describe('empty reply · no nudge', () => {
  it.each([
    ['(a) visible text after the tool', () => answer('all done')],
    ['(b) thinking + text', () => assistantWith([fauxThinking('t'), fauxText('all done')])],
    [
      '(c) length with only thinking (the run ends normally)',
      () => assistantWith([fauxThinking('t')], { stopReason: 'length' })
    ]
  ])(
    'B3 %s: one run, no <empty-reply> entry',
    async (_label, reply) => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T(), reply())
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(await noticeCount(session)).toBe(0)
      expect(world.model.chats).toHaveLength(2)
      await settled(world, 1)
      expect(runSpans(world)).toBe(1)
    },
    TIMEOUT
  )

  it(
    'B3 (d) a user steer queued while the tool runs is placed after the tool result; an empty reply to it is not nudged (it follows a user message)',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(callTool('write', { path: 'out.txt', content: 'X' }, 'c-w'), Ethink())
      const saving = session.submitUser('save')
      await nextInput(world, 'c-w')
      expect((await session.steer('also Y')).error).toBeUndefined()
      allow(world, 'c-w')
      expect(await withTimeout(saving, 5000, 'save')).toEqual({})
      expect(world.model.chats).toHaveLength(2)
      // 插话受理时会话正忙 → 模型文本带插话说明
      expect(lines(world.model.chats[1]!).slice(-2)).toEqual([
        expect.stringMatching(/^toolResult:/),
        `user:${midRunNoted('also Y')}`
      ])
      expect(await noticeCount(session)).toBe(0)
      expect((await tx(session)).slice(-2)).toEqual([
        `pi.user:${midRunNoted('also Y')}`,
        'pi.assistant:'
      ])
      await settled(world, 1)
      expect(runSpans(world)).toBe(1)
    },
    TIMEOUT
  )

  it(
    'B3 (e) the first reply to a user message is empty (no tool): not nudged',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(Ethink())
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(await noticeCount(session)).toBe(0)
      expect(world.model.chats).toHaveLength(1)
      expect(await session.lastAnswer()).toEqual({ text: '' })
    },
    TIMEOUT
  )

  it(
    'B3 (f) a second run whose reply to the new user message is empty is not nudged, although run 1 used a tool',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T(), answer('read it'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'run 1')).toEqual({})
      world.chat(E0())
      expect(await withTimeout(session.submitUser('more'), 5000, 'run 2')).toEqual({})
      expect(await noticeCount(session)).toBe(0)
      expect(world.model.chats).toHaveLength(3)
      expect((await tx(session)).slice(-2)).toEqual(['pi.user:more', 'pi.assistant:'])
      await settled(world, 2)
      expect(runSpans(world)).toBe(2)
    },
    TIMEOUT
  )
})

describe('empty reply · limits', () => {
  it(
    'B4 self-limiting: T → Ethink → N → Ethink ends the run normally (done, not an error) with one N and an empty last answer',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T(), Ethink(), Ethink())
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(world.model.chats).toHaveLength(3)
      expect(await noticeCount(session)).toBe(1)
      expect((await tx(session)).slice(-3)).toEqual([
        'pi.assistant:',
        `pi.user:${N}`,
        'pi.assistant:'
      ])
      expect(await session.lastAnswer()).toEqual({ text: '' })
      await settled(world, 1)
      expect(runSpans(world)).toBe(1)
      expect(world.t.warnings).toEqual([])
    },
    TIMEOUT
  )

  it(
    'B5 once per tool result, not per run: T → E∅ → N → T2 → E∅ → N → ok (two notices, five requests, one run)',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T('c1'), E0(), T('c2'), E0(), answer('ok'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(world.model.chats).toHaveLength(5)
      expect(await noticeCount(session)).toBe(2)
      expect(lines(world.model.chats[2]!).at(-1)).toBe(USER_N)
      expect(lines(world.model.chats[4]!).at(-1)).toBe(USER_N)
      expect(await session.lastAnswer()).toEqual({ text: 'ok' })
      await settled(world, 1)
      expect(runSpans(world)).toBe(1)
    },
    TIMEOUT
  )

  it(
    'B5 a tool call answering the notice, then text: exactly one notice',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T('c1'), E0(), T('c2'), answer('ok'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(world.model.chats).toHaveLength(4)
      expect(await noticeCount(session)).toBe(1)
      expect(await session.lastAnswer()).toEqual({ text: 'ok' })
    },
    TIMEOUT
  )
})

describe('empty reply · user input wins', () => {
  it.each(['followUp', 'steer'] as const)(
    'B6 a %s admitted while the post-tool empty reply is held is placed at that boundary: no N, the queued text follows the empty reply',
    async (mode) => {
      const world = await makeWorld()
      const session = await world.open()
      const empty = held(Ethink())
      world.chat(T(), empty.step, answer('next done'))
      const sending = session.submitUser('go')
      await empty.reached
      const admitted =
        mode === 'followUp' ? await session.followUp('next') : await session.steer('next')
      expect(admitted.error).toBeUndefined()
      empty.release()

      expect(await withTimeout(sending, 5000, 'send')).toEqual({})
      if (admitted.submissionId !== undefined) {
        const submission = await session.harness.submission(admitted.submissionId, BG)
        expect(await withTimeout(submission!.wait(BG), 5000, mode)).toMatchObject({
          status: 'done'
        })
      }
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      expect(await noticeCount(session)).toBe(0)
      expect(world.model.chats).toHaveLength(3)
      // 忙时受理的插话带插话说明；followUp 不带
      const next = mode === 'steer' ? midRunNoted('next') : 'next'
      expect(lines(world.model.chats[2]!).slice(-2)).toEqual(['assistant:', `user:${next}`])
      expect((await tx(session)).slice(-3)).toEqual([
        'pi.assistant:',
        `pi.user:${next}`,
        'pi.assistant:next done'
      ])
      // 放在最终边界的输入接着同一个 run 跑（运行状态镜像只有一个 busy 区间）
      expect(world.t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
      expect(world.t.warnings).toEqual([])
    },
    TIMEOUT
  )
})

describe('empty reply · aborts and errors', () => {
  it(
    'B7 (a) an abort while the post-tool empty reply is pending: no N, the run is aborted',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      const empty = held(Ethink())
      world.chat(T(), empty.step)
      const sending = session.submitUser('go')
      await empty.reached
      await withTimeout(session.abort(), 2000, 'abort')
      expect(await withTimeout(sending, 2000, 'send')).toEqual({})
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      expect(await noticeCount(session)).toBe(0)
      expect(world.model.chats).toHaveLength(2)
      // 扣住的那次回复被中止，什么都没写下：转写停在工具结果
      expect((await tx(session)).at(-1)).toMatch(/^pi\.tool-result:/)
      expect(world.t.statesOf('s1')).toEqual(['idle', 'busy', 'idle'])
    },
    TIMEOUT
  )

  it(
    'B7 (b) an abort while the post-nudge request is stalled: the run is aborted, N stays; the next send carries N before the new user message',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      const stall = stalled()
      world.chat(T(), Ethink(), stall.step)
      const sending = session.submitUser('go')
      await stall.reached
      await withTimeout(session.abort(), 2000, 'abort')
      expect(await withTimeout(sending, 2000, 'send')).toEqual({})
      await waitFor(() => session.runState === 'idle', 3000, 'idle')
      expect(await noticeCount(session)).toBe(1)
      expect(lines(world.model.chats[2]!).at(-1)).toBe(USER_N)

      world.chat(answer('fine'))
      expect(await withTimeout(session.submitUser('u'), 5000, 'next send')).toEqual({})
      expect(lines(world.model.chats.at(-1)!).slice(-3)).toEqual(['assistant:', USER_N, 'user:u'])
      expect(await noticeCount(session)).toBe(1)
      expect(await session.lastAnswer()).toEqual({ text: 'fine' })
    },
    TIMEOUT
  )

  it(
    'B8 (a) a non-retried model error after a tool result: the run fails, no N, no extra request',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(T(), modelError('boom'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({
        error: 'boom',
        code: 'model_error'
      })
      expect(world.model.chats).toHaveLength(2)
      expect(await noticeCount(session)).toBe(0)
    },
    TIMEOUT
  )

  it(
    'B8 (b) a retried error between the tool result and the empty reply is skipped when looking back: N is written, then ok',
    async () => {
      const retry: ShuviXSettingsOverrides = {
        retry: { baseDelayMs: 5 },
        compaction: { enabled: false }
      }
      const world = await makeWorld({ settings: retry })
      const session = await world.open()
      world.chat(T(), modelError('overloaded_error: Overloaded'), E0(), answer('ok'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(world.model.chats).toHaveLength(4)
      const kinds = (await allEntries(await session.currentConversation()))
        .filter((entry) => entry.kind !== 'pi.system')
        .map((entry) => {
          const message = entry.model?.[0]
          if (message?.role === 'assistant' && message.stopReason === 'error') return 'error'
          return `${entry.kind}:${messageText(message)}`
        })
      expect(kinds.slice(2)).toEqual([
        expect.stringMatching(/^pi\.tool-result:/),
        'error',
        'pi.assistant:',
        `pi.user:${N}`,
        'pi.assistant:ok'
      ])
      expect(await session.lastAnswer()).toEqual({ text: 'ok' })
    },
    TIMEOUT
  )
})

describe('empty reply · across a restart and a recreate', () => {
  it(
    'B10 the request after N is interrupted by a restart: continue resumes from N (no second notice) and finishes',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      const stall = stalled()
      world.chat(T(), Ethink(), stall.step)
      void session.submitUser('go')
      await stall.reached
      expect(await noticeCount(session)).toBe(1)

      await withTimeout(world.restart(), 10000, 'restart')
      const reopened = await world.open()
      expect(reopened.isInterrupted()).toBe(true)
      world.chat(answer('resumed'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      expect(world.model.chats).toHaveLength(1)
      expect(lines(world.model.chats[0]!).at(-1)).toBe(USER_N)
      expect(await noticeCount(reopened)).toBe(1)
      expect(await reopened.lastAnswer()).toEqual({ text: 'resumed' })
    },
    RECOVERY_TIMEOUT
  )

  it(
    'B11 after destroyAgent the recreated agent is nudged too',
    async () => {
      const world = await makeWorld()
      const session = await world.open()
      world.chat(answer('ready'))
      expect(await session.submitUser('hello')).toEqual({})
      await withTimeout(session.destroyAgent(), 3000, 'destroy')
      expect(session.lock).toBeUndefined()

      world.chat(T(), Ethink(), answer('done'))
      expect(await withTimeout(session.submitUser('go'), 5000, 'send')).toEqual({})
      expect(session.lock).toBeDefined()
      expect(world.model.chats).toHaveLength(4)
      expect(lines(world.model.chats[3]!).at(-1)).toBe(USER_N)
      expect(await noticeCount(session)).toBe(1)
      expect(await session.lastAnswer()).toEqual({ text: 'done' })
    },
    TIMEOUT
  )
})
