/**
 * 运行中插话的说明（docs/task-list-design.md §2，`DurableSession.admitUser`）：受理时会话正忙（或被中断、照
 * 「先让它跑完」排在后面）的 steer，模型文本末尾带一段固定说明，显示侧车里是一枚说明 Token —— 两份侧车记在
 * 同一个 requestId 下。空闲的 steer、follow-up、通知、submitUser（重新生成走它）一律不带。
 *
 *   MRN-D-1  忙时 steer（`steer-session` 的形状：给定 requestId + 来源）：两份侧车都在给定的 requestId 下；
 *            模型文本以说明结尾；投影 = 原文 + 标记、带说明 Token、带来源
 *   MRN-D-2  空闲 steer 带来源：自己起一轮，模型文本就是原文；只写来源侧车；投影是纯文本
 *   MRN-D-3  忙时 follow-up（带来源 / 带空的 composer 秘密）：不带说明，不写显示侧车
 *   MRN-D-4  忙时的通知（notify）：照通知形状写入、不带说明，显示侧车不变；通知形状的 steer 同样（PIN-16）
 *   MRN-D-5  忙时带图的 steer：请求里图片原样、最后是说明文本块；投影带一张图、原文 + 标记
 *   MRN-D-6  被中断的会话（O1）：照「先让它跑完」排在后面的 steer 带说明、两边都不算新请求；
 *            `abort-then-send` 先中止，steer 成了普通请求，不带说明
 *   MRN-D-7  脱敏的次序：说明加在脱敏之后 —— 脱敏看不到说明；模型文本 = 脱敏后原文 + 原样的说明；侧车没有明文
 *   MRN-D-8  被拒的 steer（没配模型、句柄已关）什么都不写
 *   MRN-D-9  两条忙时 steer：各自一份显示侧车，投影各自带说明 Token
 *   MRN-D-11 submitUser（重新生成的发送路径）从不加说明：空闲时如此，忙时排成 follow-up 也如此
 *
 * MRN-D-10（队列里那条 steer 自己写了字面标记、uid 不认识时队列行回退到模型文本）按裁决不写（S7，接受）。
 */
import { createHmac } from 'node:crypto'
import type { ImageContent } from '@earendil-works/pi-ai'
import {
  InboxDoc,
  ROOT_CONVERSATION_ID,
  type JsonObject,
  type UserInput
} from '@earendil-works/pi-durable'
import {
  MID_RUN_NOTE_SEPARATOR,
  MID_RUN_NOTE_TEXT,
  MID_RUN_NOTE_UID,
  midRunNoteDisplay
} from '@shuvix/chat-protocol/midRunNote'
import { startsTaskListRequest } from '@shuvix/chat-protocol/taskList'
import type { ChatMessage } from '@shuvix/chat-protocol/types/chatMessage'
import { makeTokenMarker } from '@shuvix/chat-protocol/utils/inlineTokens'
import { describe, expect, it, vi } from 'vitest'
import { backgroundContext as BG } from '../context'
import { DisplayDoc, SourceDoc } from '../docs'
import type { AdmitResult, DurableSession } from '../durableSession'
import { freshMount } from '../projection/__tests__/projectorSupport'
import type { InterruptedSendPolicy } from '../seams'
import type { RedactionHost } from '../sessionRedaction'
import { taskListEventsOfEntries } from '../taskListReader'
import { testProfile } from './support/agentConfig'
import { bg } from './support/digest'
import { answer, callTool, held, stalled } from './support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from './support/host'
import { holdTool } from './support/tools'
import { allEntries, midRunDisplayed, midRunNoted, requestTexts } from './support/transcript'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const TIMEOUT = 15000
const SUFFIX = `${MID_RUN_NOTE_SEPARATOR}${MID_RUN_NOTE_TEXT}`
const MARKER = makeTokenMarker(MID_RUN_NOTE_UID)
const PARENT = { kind: 'parent-session', sessionId: 'P1', title: '重构 parser' } as const
const IMAGE: ImageContent = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }

/** 一轮在工具上被扣住的会话：`release()` 之后这一轮跑完 */
async function heldRound(options: TestHostOptions = {}): Promise<{
  t: TestHost
  session: DurableSession
  sending: Promise<unknown>
  release: () => void
}> {
  const gate = deferred()
  const running = deferred()
  const t = await makeHost({
    ...options,
    tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
  })
  const session = await t.open()
  await primeRoot(session)
  t.kit.queue(callTool('hold'), answer('done'))
  const sending = session.submitUser('go')
  await running.promise
  return { t, session, sending, release: () => gate.resolve() }
}

async function displayItems(session: DurableSession): Promise<Record<string, JsonObject>> {
  const conversation = await session.currentConversation()
  return (await session.harness.snapshot(DisplayDoc, conversation.id, BG))?.items ?? {}
}

async function sourceItems(session: DurableSession): Promise<Record<string, JsonObject>> {
  const conversation = await session.currentConversation()
  return (await session.harness.snapshot(SourceDoc, conversation.id, BG))?.items ?? {}
}

async function requestIdOf(session: DurableSession, admitted: AdmitResult): Promise<string> {
  expect(admitted.submissionId).toBeDefined()
  const record = await (await session.harness.submission(admitted.submissionId!, BG))!.status(BG)
  expect(typeof record.requestId).toBe('string')
  return record.requestId!
}

async function settled(session: DurableSession, admitted: AdmitResult): Promise<string> {
  const submission = await session.harness.submission(admitted.submissionId!, BG)
  return (await withTimeout(submission!.wait(BG), 5000, 'submission')).status
}

/** 投影里不是通知的用户消息 */
async function typedUsers(session: DurableSession): Promise<ChatMessage[]> {
  return (await freshMount(session)).messages.filter(
    (message) =>
      message.role === 'user' &&
      (message.metadata as { isSystemNotice?: boolean } | null)?.isSystemNotice !== true
  )
}

async function userWith(session: DurableSession, content: string): Promise<ChatMessage> {
  const found = (await freshMount(session)).messages.filter(
    (message) => message.role === 'user' && message.content === content
  )
  expect(found, `user message ${content}`).toHaveLength(1)
  return found[0]!
}

function meta(message: ChatMessage): Record<string, unknown> {
  return (message.metadata ?? {}) as Record<string, unknown>
}

/** 最后一个请求里的最后一条 user 消息（原样，含图片块） */
function lastUserMessage(t: TestHost): { content: UserInput } {
  const request = t.kit.requests.at(-1)!
  const users = request.messages.filter((message) => message.role === 'user')
  return users.at(-1) as unknown as { content: UserInput }
}

const redactionHost: RedactionHost = {
  signer: { sign: (data) => createHmac('sha256', 'test-key').update(data).digest() },
  vault: {
    seal: (v) => `SEALED:${Buffer.from(v).toString('base64')}`,
    open: (s) => {
      if (!s.startsWith('SEALED:')) throw new Error('cannot open')
      return Buffer.from(s.slice(7), 'base64').toString()
    }
  }
}
const PASSWORD = 'Tr0ub4dor&3xq'
const PLACEHOLDER = /\{\{[A-Z_]+_[a-z2-7]{8}\}\}/

describe('mid-run note on steers', () => {
  it(
    'MRN-D-1 a busy steer with a given requestId and source (the steer-session shape): both sidecars under that requestId, the model text ends with the note, the projection shows text + marker with the note token and the origin',
    async () => {
      const { t, session, sending, release } = await heldRound()
      const requestId = 'subsession-steer:P1:7'
      const admitted = await session.steer('pivot', { requestId, source: PARENT })
      expect(await requestIdOf(session, admitted)).toBe(requestId)
      expect(await displayItems(session)).toStrictEqual({ [requestId]: midRunNoteDisplay('pivot') })
      expect(await sourceItems(session)).toStrictEqual({ [requestId]: PARENT })
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      expect(requestTexts(t.kit, 1).at(-1)).toBe(`user:${midRunNoted('pivot')}`)
      const user = await userWith(session, `pivot${MARKER}`)
      expect(meta(user).inlineTokens).toMatchObject({
        [MID_RUN_NOTE_UID]: { type: 'note', id: 'mid-run' }
      })
      expect(meta(user).origin).toStrictEqual(PARENT)
    },
    TIMEOUT
  )

  it(
    'MRN-D-2 an idle steer with a source starts its own run: the model text is exactly the text, only the source sidecar is written, the projection is plain text',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      t.kit.queue(answer('ok'))
      const admitted = await session.steer('go', { source: PARENT })
      const requestId = await requestIdOf(session, admitted)
      expect(await settled(session, admitted)).toBe('done')
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:go')
      expect(await sourceItems(session)).toStrictEqual({ [requestId]: PARENT })
      expect(await displayItems(session)).toStrictEqual({})
      const user = await userWith(session, 'go')
      expect(meta(user)).not.toHaveProperty('inlineTokens')
      expect(meta(user).origin).toStrictEqual(PARENT)
    },
    TIMEOUT
  )

  it(
    'MRN-D-3 a busy follow-up — with a source, or with an empty composer secret list — carries no note and writes no display sidecar',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'))
      const first = session.submitUser('u1')
      await run.reached
      const sourced = await session.followUp('F1', { source: PARENT })
      const composed = await session.followUp('F2', { composer: { secrets: [] } })
      expect(sourced.submissionId).toBeDefined()
      expect(composed.submissionId).toBeDefined()
      run.release()
      expect(await first).toEqual({})
      expect(await settled(session, composed)).toBe('done')
      expect(requestTexts(t.kit, 1).slice(-2)).toEqual(['user:F1', 'user:F2'])
      expect(await displayItems(session)).toStrictEqual({})
      const requestId = await requestIdOf(session, sourced)
      expect(await sourceItems(session)).toStrictEqual({ [requestId]: PARENT })
      expect((await typedUsers(session)).map((message) => message.content)).toEqual([
        'u1',
        'F1',
        'F2'
      ])
    },
    TIMEOUT
  )

  it(
    'MRN-D-4 a notice while busy (notify) is written notice-shaped with no note and leaves DisplayDoc unchanged; a notice-shaped steer() while busy gets no note and no display item either (PIN-16)',
    async () => {
      const { t, session, sending, release } = await heldRound({ noticeCoalesceMs: 20 })
      const notice = bg('t1', 'done')
      await session.notify(notice)
      const shaped = bg('t2', 'also done')
      const admitted = await session.steer(shaped)
      expect(admitted.submissionId).toBeDefined()
      expect(await displayItems(session)).toStrictEqual({})
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      const texts = requestTexts(t.kit, 1)
      expect(texts).toContain(`user:${notice}`)
      expect(texts).toContain(`user:${shaped}`)
      expect(texts.some((line) => line.includes(MID_RUN_NOTE_TEXT))).toBe(false)
      expect(await displayItems(session)).toStrictEqual({})
      const users = (await freshMount(session)).messages.filter(
        (message) => message.role === 'user' && message.content !== 'go'
      )
      expect(users.length).toBeGreaterThan(0)
      for (const user of users) {
        expect(meta(user).isSystemNotice).toBe(true)
        expect(meta(user)).not.toHaveProperty('inlineTokens')
        expect(user.content).not.toContain(MARKER)
      }
    },
    TIMEOUT
  )

  it(
    'MRN-D-5 a busy steer with an image: the request keeps the image block and ends with the note text block; the projection has one image and text + marker',
    async () => {
      const { t, session, sending, release } = await heldRound()
      const admitted = await session.steer([{ type: 'text', text: 'look at this' }, IMAGE])
      expect(admitted.submissionId).toBeDefined()
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      expect(lastUserMessage(t).content).toStrictEqual([
        { type: 'text', text: 'look at this' },
        IMAGE,
        { type: 'text', text: SUFFIX }
      ])
      const user = await userWith(session, `look at this${MARKER}`)
      expect(meta(user).images).toHaveLength(1)
      expect(meta(user).inlineTokens).toMatchObject({
        [MID_RUN_NOTE_UID]: { type: 'note', id: 'mid-run' }
      })
    },
    TIMEOUT
  )

  describe('MRN-D-6 an interrupted session (O1)', () => {
    /** 进程 1：发 'hello'，请求挂住时关掉一切；返回进程 2 里打开的会话（被中断） */
    async function interrupted(
      policy: InterruptedSendPolicy
    ): Promise<{ t: TestHost; session: DurableSession }> {
      const first = await makeHost()
      const crashed = await first.open()
      await primeRoot(crashed)
      const stall = stalled()
      first.kit.queue(stall.step)
      void crashed.submitUser('hello')
      await stall.reached
      await withTimeout(first.host.closeAll(), 5000, 'closeAll process 1')
      const t = await first.restart({ interruptedSendPolicy: policy })
      const session = await t.open()
      expect(session.isInterrupted()).toBe(true)
      return { t, session }
    }

    async function requestCount(session: DurableSession): Promise<number> {
      const entries = await allEntries(await session.currentConversation())
      return taskListEventsOfEntries(entries).filter((event) => event.type === 'request').length
    }

    it(
      "continue-then-queue (let it finish first): the steer keeps whenBusy 'steer', gets the note, and starts no new task-list request on either side",
      async () => {
        const { t, session } = await interrupted('continue-then-queue')
        t.kit.queue(answer('old'), answer('after'))
        const admitted = await session.steer('pivot')
        const requestId = await requestIdOf(session, admitted)
        expect(await displayItems(session)).toStrictEqual({
          [requestId]: midRunNoteDisplay('pivot')
        })
        expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
        await waitFor(async () => (await settled(session, admitted)) === 'done', 5000, 'steer')
        const lines = t.kit.requests.flatMap((_request, n) => requestTexts(t.kit, n))
        expect(lines).toContain(`user:${midRunNoted('pivot')}`)
        expect(lines).not.toContain('user:pivot')
        // server：只有 'hello' 起了请求；界面：那条 steer 带说明 Token，不算新请求
        expect(await requestCount(session)).toBe(1)
        const steer = await userWith(session, `pivot${MARKER}`)
        expect(startsTaskListRequest(steer)).toBe(false)
      },
      TIMEOUT
    )

    it(
      'abort-then-send: the interrupted run is aborted first, so the steer is a plain request with no note and no display item',
      async () => {
        const { t, session } = await interrupted('abort-then-send')
        t.kit.queue(answer('fresh'))
        const admitted = await session.steer('pivot')
        expect(await settled(session, admitted)).toBe('done')
        expect(requestTexts(t.kit, 0).at(-1)).toBe('user:pivot')
        expect(await displayItems(session)).toStrictEqual({})
        expect(await requestCount(session)).toBe(2)
        const steer = await userWith(session, 'pivot')
        expect(startsTaskListRequest(steer)).toBe(true)
      },
      TIMEOUT
    )
  })

  describe('MRN-D-7 redaction runs before the note', () => {
    it(
      'maskInput never sees the note; the model text is the masked text + the byte-identical note; the display sidecar is the masked text + marker',
      async () => {
        const { t, session, sending, release } = await heldRound({ redaction: redactionHost })
        const maskInput = vi.spyOn(session.redaction!, 'maskInput')
        const admitted = await session.steer(`use DB_PASSWORD=${PASSWORD}`)
        const requestId = await requestIdOf(session, admitted)
        expect(maskInput).toHaveBeenCalled()
        for (const [content] of maskInput.mock.calls) {
          expect(JSON.stringify(content)).not.toContain(MID_RUN_NOTE_TEXT)
        }
        release()
        expect(await withTimeout(sending, 5000, 'round')).toEqual({})
        const seen = requestTexts(t.kit, 1).at(-1)!
        expect(seen).not.toContain(PASSWORD)
        expect(seen).toMatch(PLACEHOLDER)
        expect(seen.endsWith(SUFFIX)).toBe(true)
        const masked = seen.slice('user:'.length, seen.length - SUFFIX.length)
        expect(masked).toMatch(/^use DB_PASSWORD=\{\{[A-Z_]+_[a-z2-7]{8}\}\}$/)
        const display = (await displayItems(session))[requestId] as { content: string }
        expect(display.content).toBe(`${masked}${MARKER}`)
        expect(JSON.stringify(await displayItems(session))).not.toContain(PASSWORD)
      },
      TIMEOUT
    )

    it(
      'the composer path too: maskComposerInput never sees the note, and the composer secret stays out of the request and the sidecar',
      async () => {
        const { t, session, sending, release } = await heldRound({ redaction: redactionHost })
        const maskComposerInput = vi.spyOn(session.redaction!, 'maskComposerInput')
        const SECRET = 'Steer-Secret-42'
        const admitted = await session.steer(`also try ${SECRET}`, {
          composer: { secrets: [{ value: SECRET, category: 'SECRET' }] }
        })
        const requestId = await requestIdOf(session, admitted)
        expect(maskComposerInput).toHaveBeenCalled()
        for (const call of maskComposerInput.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(MID_RUN_NOTE_TEXT)
        }
        release()
        expect(await withTimeout(sending, 5000, 'round')).toEqual({})
        const seen = requestTexts(t.kit, 1).at(-1)!
        expect(seen).not.toContain(SECRET)
        expect(seen.endsWith(SUFFIX)).toBe(true)
        const display = (await displayItems(session))[requestId] as { content: string }
        expect(display.content.endsWith(MARKER)).toBe(true)
        expect(display.content).not.toContain(SECRET)
      },
      TIMEOUT
    )
  })

  it(
    'MRN-D-8 refused steers write nothing: no model → no_model; a closed session → closed',
    async () => {
      const unconfigured = await makeHost({ agentConfig: { profile: testProfile() } })
      const bare = await unconfigured.open()
      expect(await bare.steer('S')).toMatchObject({ code: 'no_model' })
      expect(await displayItems(bare)).toStrictEqual({})
      expect(await sourceItems(bare)).toStrictEqual({})

      const { t, session, sending, release } = await heldRound()
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      await t.host.close(session.sessionId)
      expect(await session.steer('S', { source: PARENT })).toMatchObject({ code: 'closed' })
      const reopened = await t.open(session.sessionId)
      expect(await displayItems(reopened)).toStrictEqual({})
      expect(await sourceItems(reopened)).toStrictEqual({})
    },
    TIMEOUT
  )

  it(
    'MRN-D-9 two busy steers each get their own display sidecar and each is projected with the note token',
    async () => {
      const { session, sending, release } = await heldRound()
      const a = await session.steer('S1')
      const b = await session.steer('S2')
      const ra = await requestIdOf(session, a)
      const rb = await requestIdOf(session, b)
      expect(ra).not.toBe(rb)
      expect(await displayItems(session)).toStrictEqual({
        [ra]: midRunNoteDisplay('S1'),
        [rb]: midRunNoteDisplay('S2')
      })
      release()
      expect(await withTimeout(sending, 5000, 'round')).toEqual({})
      for (const text of ['S1', 'S2']) {
        const user = await userWith(session, midRunDisplayed(text))
        expect(meta(user).inlineTokens).toMatchObject({
          [MID_RUN_NOTE_UID]: { type: 'note', id: 'mid-run' }
        })
      }
    },
    TIMEOUT
  )

  it(
    'MRN-D-11 submitUser (the regenerate path) never adds a note: not on an idle session with a once-noted text, not when queued as a follow-up while busy',
    async () => {
      const t = await makeHost()
      const session = await t.open()
      await primeRoot(session)
      t.kit.queue(answer('a0'))
      expect(await session.submitUser('pivot')).toEqual({})
      expect(requestTexts(t.kit, 0).at(-1)).toBe('user:pivot')

      const run = held(answer('a1'))
      t.kit.queue(run.step, answer('a2'))
      const first = session.submitUser('u1')
      await run.reached
      const queued = session.submitUser('F', { whenBusy: 'followUp' })
      await waitFor(
        async () =>
          ((await session.harness.snapshot(InboxDoc, ROOT_CONVERSATION_ID, BG))?.items.length ??
            0) === 1,
        3000,
        'queued'
      )
      run.release()
      expect(await first).toEqual({})
      expect(await queued).toEqual({})
      expect(requestTexts(t.kit, 2).at(-1)).toBe('user:F')
      expect(await displayItems(session)).toStrictEqual({})
      expect((await typedUsers(session)).map((message) => message.content)).toEqual([
        'pivot',
        'u1',
        'F'
      ])
    },
    TIMEOUT
  )
})
