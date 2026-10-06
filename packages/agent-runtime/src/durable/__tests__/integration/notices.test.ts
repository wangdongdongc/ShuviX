/**
 * P1-12 · 场景 6：后台完成通知与自动续跑，端到端（锁住的世界 W，合并窗口 20 ms，自动续跑开关现读）。
 *
 * 五条路：运行中 → 插话（steer）；空闲且允许 → 合并成一轮；空闲但不允许 → 写通知；显式中止之后 → 写通知、
 * 到下一次用户发送为止；被中断 → 推迟，继续时在下一个边界（postTools）落下。通知以 steer / 续跑送达时只能是
 * `pi.user` 条目 —— 它的正文必须让 chat-protocol 的 `isSystemNoticeText` 认得出（不能画成用户气泡）。
 */
import { isSystemNoticeText } from '@shuvix/chat-protocol/systemNoticeContract'
import { InboxDoc } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../context'
import { NoticeEntry, SessionStateDoc } from '../../docs'
import type { DurableSession } from '../../durableSession'
import { answer, callTool } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries, messageText, transcript } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { harnessErrorText } from './support/entries'
import { bg } from './support/notices'
import { lines } from './support/scriptedModel'
import { allow, makeWorld, nextInput, registerWorldCleanup, type World } from './support/world'

registerHostCleanup()
registerWorldCleanup()

const TIMEOUT = 10000
const RECOVERY_TIMEOUT = 20000
const WRITE_ARGS = { path: 'out.txt', content: 'X' }

async function locked(world: World): Promise<DurableSession> {
  const session = await world.open()
  world.chat(answer('ready'))
  expect(await session.submitUser('hello')).toEqual({})
  return session
}

async function userEntries(session: DurableSession): Promise<string[]> {
  return (await allEntries(await session.currentConversation()))
    .filter((entry) => entry.kind === 'pi.user')
    .map((entry) => messageText(entry.model?.[0]))
}

describe('P1-12 · notices', () => {
  it(
    'I6-01a running: a notice during a pending ask is a steer, placed right after the tool result in the same run',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      const t1 = bg('t1', 'done')
      world.chat(callTool('write', WRITE_ARGS, 'c-w'), answer('noted'))
      const saving = session.submitUser('save')
      await nextInput(world, 'c-w')
      await session.notify(t1)
      const conversation = await session.currentConversation()
      expect(
        (await session.harness.snapshot(InboxDoc, conversation.id, BG))?.items.map(
          (item) => item.mode
        )
      ).toEqual(['steer'])
      allow(world, 'c-w')
      expect(await withTimeout(saving, 5000, 'save')).toEqual({})

      expect(lines(world.model.chats.at(-1)!).slice(-2)).toEqual([
        expect.stringMatching(/^toolResult:/),
        `user:${t1}`
      ])
      const users = await userEntries(session)
      expect(users.at(-1)).toBe(t1)
      expect(isSystemNoticeText(users.at(-1)!)).toBe(true)
      await waitFor(() => world.t.statesOf('s1').length >= 5, 1000, 'run states')
      expect(world.t.statesOf('s1')).toEqual(['idle', 'busy', 'idle', 'busy', 'idle'])
    },
    TIMEOUT
  )

  it(
    'I6-01b idle and allowed: two notices within the window start one run with one joined user entry',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      const chatsBefore = world.model.chats.length
      const t2 = bg('t2', 'two')
      const t3 = bg('t3', 'three')
      world.chat(answer('resumed'))
      await session.notify(t2)
      await session.notify(t3)
      await waitFor(
        async () =>
          (await transcript(await session.currentConversation())).at(-1) === 'pi.assistant:resumed',
        3000,
        'auto-resume run'
      )
      expect(world.model.chats.length - chatsBefore).toBe(1)
      const users = await userEntries(session)
      expect(users.at(-1)).toBe(`${t2}\n\n${t3}`)
      expect(isSystemNoticeText(users.at(-1)!)).toBe(true)
      expect(world.t.configCalls).toHaveLength(1)
      expect(world.toolHost.resolveCalls).toHaveLength(1)
    },
    TIMEOUT
  )

  it(
    'I6-01c auto-resume off (" false "): the notice is written, no request; the next send carries it before the user text',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      world.autoResume.value = ' false '
      const chatsBefore = world.model.chats.length
      const t4 = bg('t4', 'four')
      await session.notify(t4)
      const conversation = await session.currentConversation()
      await waitFor(
        async () => (await allEntries(conversation)).some((entry) => NoticeEntry.is(entry)),
        2000,
        'notice written'
      )
      const notice = (await allEntries(conversation)).find((entry) => NoticeEntry.is(entry))!
      expect(notice.data).toMatchObject({ kind: 'background' })
      expect(messageText(notice.model?.[0])).toBe(t4)
      await sleep(60)
      expect(world.model.chats.length).toBe(chatsBefore)

      world.chat(answer('saw it'))
      expect(await session.submitUser('u')).toEqual({})
      expect(lines(world.model.chats.at(-1)!).slice(-2)).toEqual([`user:${t4}`, 'user:u'])
    },
    TIMEOUT
  )

  it(
    'I6-01d after an explicit abort notices are written, not run — until the next user send',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      await session.abort()
      const chatsBefore = world.model.chats.length
      const t5 = bg('t5', 'five')
      await session.notify(t5)
      const conversation = await session.currentConversation()
      await waitFor(
        async () => (await allEntries(conversation)).some((entry) => NoticeEntry.is(entry)),
        2000,
        'notice written'
      )
      await sleep(60)
      expect(world.model.chats.length).toBe(chatsBefore)

      world.chat(answer('v done'))
      expect(await session.submitUser('v')).toEqual({})
      const t6 = bg('t6', 'six')
      world.chat(answer('resumed after v'))
      await session.notify(t6)
      await waitFor(
        async () => (await transcript(conversation)).at(-1) === 'pi.assistant:resumed after v',
        3000,
        'auto-resume after the user spoke again'
      )
      expect((await userEntries(session)).at(-1)).toBe(t6)
    },
    TIMEOUT
  )

  it(
    'I6-02 an interrupted tool round + a deferred notice + the date: the notice lands at the postTools boundary after the interrupted result',
    async () => {
      const world = await makeWorld()
      const session = await locked(world)
      world.chat(callTool('write', WRITE_ARGS, 'c-w'))
      void session.submitUser('save')
      await nextInput(world, 'c-w')
      await withTimeout(world.restart(), 10000, 'restart')

      const reopened = await world.open()
      const t7 = bg('t7', 'seven')
      await reopened.notify(t7)
      const state = await reopened.harness.snapshot(SessionStateDoc, BG)
      expect(state?.deferredNotices.map((notice) => notice.kind)).toEqual(['background'])
      expect(world.t.kit.callCount).toBe(0)

      world.chat(answer('after the crash'))
      expect(await withTimeout(reopened.continue(), 5000, 'continue')).toEqual({})
      const conversation = await reopened.currentConversation()
      const tail = (await transcript(conversation)).slice(-4)
      expect(tail).toEqual([
        'pi.assistant:[tool:write]',
        `pi.tool-result:${harnessErrorText('Tool write was interrupted and may have partially run')}`,
        `shuvix.notice:${t7}`,
        'pi.assistant:after the crash'
      ])
      expect(lines(world.model.chats[0]!).slice(-2)).toEqual([
        `toolResult:${harnessErrorText('Tool write was interrupted and may have partially run')}`,
        `user:${t7}`
      ])
      expect((await reopened.harness.snapshot(SessionStateDoc, BG))?.deferredNotices).toEqual([])
      expect(world.fs.writes).toEqual([])

      // 第二天：日期通知排在用户这句之前
      world.clock.setToday('2026-10-05')
      world.chat(answer('good morning'))
      expect(await reopened.submitUser('next day')).toEqual({})
      const last = (await allEntries(conversation))
        .filter((entry) => entry.kind !== 'pi.system')
        .slice(-3)
      expect(last.map((entry) => entry.kind)).toEqual([NoticeEntry.kind, 'pi.user', 'pi.assistant'])
      expect(last[0]!.data).toMatchObject({ kind: 'date', date: '2026-10-05' })
      expect(messageText(last[1]!.model?.[0])).toBe('next day')
    },
    RECOVERY_TIMEOUT
  )
})
