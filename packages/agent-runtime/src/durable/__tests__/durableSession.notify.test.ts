/**
 * 后台完成通知的路由（R13，`DurableSession.notify`）：运行中 → steer；空闲且允许 → 合并窗口内攒成
 * 一轮；空闲但不允许 → 写通知；被中断 → 推迟；显式 abort 之后到下一次 submitUser 之前不自动续跑；
 * 窗口内 abort → 写入、close → 保存待送达、delete → 丢弃；窗口内用户发送 → 作为插话汇入。
 */
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { autoResumeAllowed } from '../sessionHost'
import { answer, callTool, stalled } from './support/faux'
import {
  makeHost,
  primeRoot,
  registerHostCleanup,
  type TestHost,
  type TestHostOptions
} from './support/host'
import { holdTool } from './support/tools'
import { transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const WINDOW = 20

async function lines(session: DurableSession): Promise<string[]> {
  return transcript(await session.currentConversation())
}

async function primed(
  options: TestHostOptions = {}
): Promise<{ t: TestHost; session: DurableSession }> {
  const t = await makeHost({ noticeCoalesceMs: WINDOW, ...options })
  const session = await t.open()
  await primeRoot(session, t.kit)
  return { t, session }
}

describe('notify routing', () => {
  it('NT-01 running → steer: the notice joins the run after the tool round', async () => {
    const gate = deferred()
    const running = deferred()
    const { t, session } = await primed({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    await session.notify('<background-task id="t1">done</background-task>')
    gate.resolve()
    expect(await result).toEqual({})
    expect(await lines(session)).toEqual([
      'pi.user:go',
      'pi.assistant:[tool:hold]',
      'pi.tool-result:hold done',
      'pi.user:<background-task id="t1">done</background-task>',
      'pi.assistant:done'
    ])
    expect(t.kit.callCount).toBe(2)
  })

  it("NT-02 idle + allowed → one run with one user entry, texts joined by '\\n\\n'", async () => {
    const { t, session } = await primed()
    t.kit.queue(answer('ack'))
    await session.notify('A')
    await session.notify('B')
    await waitFor(async () => (await lines(session)).length === 2, 3000, 'auto-resumed run')
    expect(await lines(session)).toEqual(['pi.user:A\n\nB', 'pi.assistant:ack'])
    await sleep(WINDOW * 3)
    expect(t.kit.callCount).toBe(1)
  })

  it("NT-03 idle + not allowed → a written notice, no run; the setting is read live; only a trimmed literal 'false' disables", async () => {
    let setting: unknown = ' false\n'
    const { t, session } = await primed({ autoResume: () => setting })
    await session.notify('A')
    await sleep(WINDOW * 3)
    expect(await lines(session)).toEqual(['shuvix.notice:A'])
    expect(t.kit.callCount).toBe(0)

    setting = 'False'
    t.kit.queue(answer('ack'))
    await session.notify('B')
    await waitFor(async () => (await lines(session)).includes('pi.assistant:ack'), 3000, 'run')
    expect((await lines(session)).slice(-2)).toEqual(['pi.user:B', 'pi.assistant:ack'])

    expect(autoResumeAllowed(undefined)).toBe(true)
    expect(autoResumeAllowed('true')).toBe(true)
    expect(autoResumeAllowed('')).toBe(true)
    expect(autoResumeAllowed('garbage')).toBe(true)
    expect(autoResumeAllowed('FALSE')).toBe(true)
    expect(autoResumeAllowed('false')).toBe(false)
    expect(autoResumeAllowed('  false ')).toBe(false)
    expect(autoResumeAllowed(false)).toBe(false)
  })

  it('NT-04 after an explicit abort, idle notices are written, not run, until the next submitUser', async () => {
    const { t, session } = await primed()
    await withTimeout(session.abort(), 3000, 'abort')
    await session.notify('A')
    await sleep(WINDOW * 3)
    expect(await lines(session)).toEqual(['shuvix.notice:A'])
    expect(t.kit.callCount).toBe(0)
    t.kit.queue(answer('u-ack'), answer('b-ack'))
    expect(await session.submitUser('u')).toEqual({})
    await session.notify('B')
    await waitFor(async () => (await lines(session)).includes('pi.assistant:b-ack'), 3000, 'run')
    expect((await lines(session)).slice(-2)).toEqual(['pi.user:B', 'pi.assistant:b-ack'])
  })

  it('NT-05 interrupted → deferred, never run', async () => {
    const first = await makeHost()
    const original = await first.open()
    await primeRoot(original, first.kit)
    const stall = stalled()
    first.kit.queue(stall.step)
    void original.submitUser('hello')
    await stall.reached
    const t = await first.restart({ noticeCoalesceMs: WINDOW })
    const session = await t.open()
    expect(session.isInterrupted()).toBe(true)
    await session.notify('A')
    await sleep(WINDOW * 3)
    expect(t.kit.callCount).toBe(0)
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    const state = await session.harness.snapshot(SessionStateDoc, BG)
    expect(state?.deferredNotices.map((notice) => [notice.text, notice.kind])).toEqual([
      ['A', 'background']
    ])
  })

  it('NT-06 abort during the window → written; close → saved for later; delete → dropped; never a run', async () => {
    const { t, session } = await primed({ noticeCoalesceMs: 200 })
    await session.notify('A')
    await withTimeout(session.abort(), 3000, 'abort in window')
    expect(await lines(session)).toEqual(['shuvix.notice:A'])
    await sleep(250)
    expect(t.kit.callCount).toBe(0)

    // close：合并窗口里的通知存进待送达，不起轮（先发一条解除「显式喊停」，通知才会进窗口）
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('u')).toEqual({})
    await session.notify('B')
    await withTimeout(t.host.close('s1'), 3000, 'close in window')
    await sleep(250)
    const reopened = await t.open()
    const state = await reopened.harness.snapshot(SessionStateDoc, BG)
    expect(state?.deferredNotices.map((notice) => notice.text)).toEqual(['B'])
    const callsBefore = t.kit.callCount

    // delete：丢弃
    await reopened.notify('C')
    await withTimeout(t.host.delete('s1'), 3000, 'delete in window')
    await sleep(250)
    expect(t.kit.callCount).toBe(callsBefore)
    const fresh = await t.open()
    expect(await lines(fresh)).toEqual([])
    expect(await fresh.harness.snapshot(SessionStateDoc, BG)).toEqual({ deferredNotices: [] })
  })

  it("NT-07 a user send during the window: the notices join the user's run as a steer", async () => {
    const gate = deferred()
    const running = deferred()
    const { t, session } = await primed({
      noticeCoalesceMs: 200,
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    t.kit.queue(callTool('hold'), answer('done'))
    await session.notify('N')
    const result = session.submitUser('go')
    await running.promise
    gate.resolve()
    expect(await result).toEqual({})
    expect(await lines(session)).toEqual([
      'pi.user:go',
      'pi.assistant:[tool:hold]',
      'pi.tool-result:hold done',
      'pi.user:N',
      'pi.assistant:done'
    ])
    await sleep(250)
    expect(t.kit.callCount).toBe(2)
  })
})
