/**
 * SessionHost：打开 / 窥视 / 关闭 / 全部关闭（封存）/ 删除、LRU（R6/R7/R10）、运行状态事件（R2）。
 * 除临时会话外都跑在 SQLite 上（关了再开需要真文件）。
 */
import { existsSync } from 'node:fs'
import { LiveDoc, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { fauxAssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import { SessionClosedError, type DurableSession } from '../durableSession'
import type { RunState } from '../seams'
import { SessionHostSealedError } from '../sessionHost'
import { answer, callTool, fauxKit, held, stalled } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup, type TestHost } from './support/host'
import { wKit } from './support/scenario'
import { hookRec, seedAgent, startRun, TEST_SPAWN_EXTENSION } from './support/spawn'
import { askingTool, holdTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { aborted, deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const ask = {
  id: 'direct',
  kind: 'ask' as const,
  toolName: 'bash',
  command: 'ls',
  createdAt: 0
}

describe('SessionHost open / peek / close', () => {
  it('H-01 open creates the storage once; the current conversation is the root', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    expect(existsSync(t.file('a'))).toBe(true)
    expect((await session.currentConversation()).id).toBe(ROOT_CONVERSATION_ID)
    expect(await t.open('a')).toBe(session)
    expect(t.events.filter((event) => event === 'open:a')).toHaveLength(1)
  })

  it('H-02 after open the scheduler is paused', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
    expect(session.runState).toBe('idle')
  })

  it('H-03 concurrent opens share one instance', async () => {
    const t = await makeHost()
    const [a, b, c] = await Promise.all([t.open('a'), t.open('a'), t.host.peek('a')])
    expect(a).toBe(b)
    expect(c === undefined || c === a).toBe(true)
    expect(t.events.filter((event) => event === 'open:a')).toHaveLength(1)
    expect(t.host.get('a')).toBe(a)
  })

  it('H-04 a failed open clears its slot; a retry succeeds', async () => {
    const t = await makeHost()
    t.failNextOpen.add('a')
    await expect(t.open('a')).rejects.toThrow('injected open failure')
    expect(t.host.get('a')).toBeUndefined()
    const session = await t.open('a')
    expect(session.closed).toBe(false)
  })

  it('H-05 peek of a session without storage → undefined, nothing opened or created', async () => {
    const t = await makeHost()
    expect(await t.host.peek('nofile')).toBeUndefined()
    expect(t.events).toEqual([])
    expect(existsSync(t.file('nofile'))).toBe(false)
  })

  it('H-06 peek opens an existing closed file paused with the same entries, shares open and in-flight instances', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const before = await transcript(await session.currentConversation())
    await t.host.close('a')
    const peeked = await t.host.peek('a')
    expect(peeked).toBeDefined()
    expect(peeked).not.toBe(session)
    expect((await peeked!.harness.inspect(BG)).scheduling).toBe('paused')
    expect(await transcript(await peeked!.currentConversation())).toEqual(before)
    expect(await t.host.peek('a')).toBe(peeked)

    await t.host.close('a')
    const opening = t.open('a')
    const sharing = t.host.peek('a')
    expect(await sharing).toBe(await opening)
  })

  it('H-07 peek of an ephemeral id with no memory storage → undefined, nothing created', async () => {
    const t = await makeHost({ ephemeral: ['e1'] })
    expect(await t.host.peek('e1')).toBeUndefined()
    expect(t.memory.has('e1')).toBe(false)
    expect(t.events).toEqual([])
  })

  it('H-08 an open right after a close waits for it and yields a new instance', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    const closing = t.host.close('a')
    const reopened = await t.open('a')
    await closing
    expect(t.events).toEqual(['open:a', 'close:a', 'open:a'])
    expect(reopened).not.toBe(session)
    expect(session.closed).toBe(true)
    expect(reopened.closed).toBe(false)
  })

  it('H-09 a close during an in-flight open waits for it, closes it, and leaves no orphan', async () => {
    const t = await makeHost()
    const opening = t.open('a')
    const closing = t.host.close('a')
    await withTimeout(closing, 5000, 'close')
    const session = await withTimeout(opening, 5000, 'open')
    // SessionManager 不交出关停中的实例：在途的 open 等关停完再开一个新的
    expect(t.events).toEqual(['open:a', 'close:a', 'open:a'])
    expect(session.closed).toBe(false)
    expect(t.host.get('a')).toBe(session)
    expect(t.host.openSessionIds()).toEqual(['a'])
  })

  it('H-10 closing a busy session resolves; the run persists as interrupted; the submit resolves closed', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    await primeRoot(session, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const result = session.submitUser('hello')
    await stall.reached
    await withTimeout(t.host.close('a'), 5000, 'close busy')
    expect(t.events).toContain('close:a')
    expect(await withTimeout(result, 2000, 'submit')).toEqual({
      error: expect.any(String),
      code: 'closed'
    })
    const reopened = await t.open('a')
    expect(reopened.isInterrupted()).toBe(true)
    expect(reopened.isBusy()).toBe(false)
  })

  it('H-11 closing with a pending ask resolves; the ask is cancelled with reason closed', async () => {
    const ref: { session?: DurableSession } = {}
    let response: InputResponse | undefined
    const tools = [askingTool('askme', () => ref.session!, { onResolved: (r) => (response = r) })]
    const t = await makeHost({ tools })
    const session = (ref.session = await t.open('a'))
    await primeRoot(session, t.kit)
    t.kit.queue(callTool('askme'), answer('after'))
    const result = session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    await withTimeout(t.host.close('a'), 5000, 'close with ask')
    expect(response).toEqual({ kind: 'cancel', reason: 'closed' })
    expect(session.pendingInputCount).toBe(0)
    expect(await withTimeout(result, 2000, 'submit')).toMatchObject({ code: 'closed' })
  })

  it('H-12 a stale handle after close reports closed and never reopens silently', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    await t.host.close('a')
    expect(session.closed).toBe(true)
    expect(await session.submitUser('x')).toEqual({ error: expect.any(String), code: 'closed' })
    expect(await session.steer('x')).toMatchObject({ code: 'closed' })
    expect(await session.followUp('x')).toMatchObject({ code: 'closed' })
    expect(await session.continue()).toMatchObject({ code: 'closed' })
    expect(await session.writeNotice({ text: 'n', kind: 'background' })).toMatchObject({
      status: 'closed'
    })
    await expect(session.currentConversation()).rejects.toBeInstanceOf(SessionClosedError)
    await expect(session.setThinkingLevel('high')).rejects.toBeInstanceOf(SessionClosedError)
    await expect(session.abort()).resolves.toBeUndefined()
    await expect(session.notify('n')).resolves.toBeUndefined()
    expect(await session.requestUserInput(ask)).toEqual({ kind: 'cancel', reason: 'closed' })
    expect(t.events.filter((event) => event === 'open:a')).toHaveLength(1)
    expect(t.host.get('a')).toBeUndefined()
  })

  it('H-13 close of a session that is not open is a no-op; closeAll closes everything and seals the host', async () => {
    const t = await makeHost({ ephemeral: ['e'] })
    await t.host.close('nothing')
    expect(t.events).toEqual([])
    await t.open('a')
    await t.open('b')
    await t.open('e')
    await withTimeout(Promise.all([t.host.closeAll(), t.host.closeAll()]), 5000, 'closeAll')
    for (const id of ['a', 'b', 'e']) {
      expect(t.events.filter((event) => event === `close:${id}`)).toHaveLength(1)
    }
    expect(t.host.sealed).toBe(true)
    await expect(t.open('c')).rejects.toBeInstanceOf(SessionHostSealedError)
    await expect(t.open('a')).rejects.toThrow(/closed/)
    expect(await t.host.peek('a')).toBeUndefined()
    expect(t.host.openSessionIds()).toEqual([])
  })

  it('H-14 reopen undoes the seal: peek sees the same entries again, a later closeAll closes and seals again; reopen of an unsealed host is a no-op', async () => {
    const t = await makeHost()
    t.host.reopen()
    expect(t.host.sealed).toBe(false)
    const session = await t.open('a')
    await primeRoot(session, t.kit)
    t.kit.queue(answer('a1'))
    await session.submitUser('u1')
    const before = await transcript(await session.currentConversation())
    await withTimeout(t.host.closeAll(), 5000, 'closeAll')
    expect(await t.host.peek('a')).toBeUndefined()

    t.host.reopen()
    expect(t.host.sealed).toBe(false)
    const peeked = await t.host.peek('a')
    expect(peeked).toBeDefined()
    expect(peeked).not.toBe(session)
    expect(await transcript(await peeked!.currentConversation())).toEqual(before)
    expect((await t.open('b')).closed).toBe(false)

    await withTimeout(t.host.closeAll(), 5000, 'second closeAll')
    expect(t.host.sealed).toBe(true)
    expect(t.events.filter((event) => event === 'close:a')).toHaveLength(2)
    expect(t.events.filter((event) => event === 'close:b')).toHaveLength(1)
    expect(t.host.openSessionIds()).toEqual([])
    await expect(t.open('c')).rejects.toBeInstanceOf(SessionHostSealedError)
  })

  it('H-15 reopen while closeAll is still in flight: an open of a session being closed waits for that close, then a fresh instance', async () => {
    const t = await makeHost()
    const session = await t.open('a')
    const closing = t.host.closeAll()
    t.host.reopen()
    const reopened = await t.open('a')
    await withTimeout(closing, 5000, 'closeAll')
    expect(session.closed).toBe(true)
    expect(reopened).not.toBe(session)
    expect(reopened.closed).toBe(false)
    expect(t.host.get('a')).toBe(reopened)
    expect(t.events.filter((event) => event.endsWith(':a'))).toEqual([
      'open:a',
      'close:a',
      'open:a'
    ])
  })
})

describe('SessionHost LRU', () => {
  it('L-01 maxIdleOpen 2: opening a third idle session closes the least recently used', async () => {
    const t = await makeHost({ maxIdleOpen: 2 })
    await t.open('a')
    await t.open('b')
    await t.open('c')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed')
    expect(t.host.get('a')).toBeUndefined()
    expect(t.host.get('b')).toBeDefined()
    expect(t.host.get('c')).toBeDefined()
  })

  it('L-02 recency follows use (open again, or any session call)', async () => {
    const t = await makeHost({ maxIdleOpen: 2 })
    const a = await t.open('a')
    await t.open('b')
    await t.open('a')
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    expect(t.host.get('a')).toBe(a)

    // 会话调用同样算「用过」
    await a.setThinkingLevel('low')
    const c = t.host.get('c')!
    await t.open('d')
    await waitFor(() => t.events.includes('close:c'), 3000, 'c closed')
    expect(c.closed).toBe(true)
    expect(a.closed).toBe(false)
  })

  it('L-03 a busy session is exempt, does not take a slot, and completes after release', async () => {
    const t = await makeHost({ maxIdleOpen: 1 })
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    const first = held(answer('done'))
    t.kit.queue(first.step)
    const result = a.submitUser('work')
    await first.reached
    await t.open('b')
    await sleep(30)
    expect(t.events.filter((event) => event.startsWith('close:'))).toEqual([])
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    expect(a.closed).toBe(false)
    first.release()
    expect(await withTimeout(result, 3000, 'busy run')).toEqual({})
    // 忙 → 闲之后它才进入候选（比 c 旧，于是被关）
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed after idle')
  })

  it('L-04 busy comes from durable state, not from session calls (a run on a non-current conversation)', async () => {
    const t = await makeHost({ maxIdleOpen: 1 })
    const a = await t.open('a')
    const other = await a.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await other.configure({ model: t.kit.model }, BG)
    const run = held(answer('side'))
    t.kit.queue(run.step)
    const submission = await other.submit({ type: 'input', content: 'side work' }, BG)
    await run.reached
    await waitFor(() => t.statesOf('a').includes('busy'), 3000, 'busy reported')
    expect(a.isBusy()).toBe(false)
    expect(a.runState).toBe('busy')
    await t.open('b')
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    expect(a.closed).toBe(false)
    run.release()
    expect((await submission.wait(BG)).status).toBe('done')
    await waitFor(() => t.statesOf('a').at(-1) === 'idle', 3000, 'idle reported')
  })

  it('L-05 a pinned session is exempt; once unpinned it is eligible at the next trim', async () => {
    const t = await makeHost({ maxIdleOpen: 1 })
    t.pinned.add('a')
    const a = await t.open('a')
    await t.open('b')
    await sleep(30)
    expect(a.closed).toBe(false)
    expect(t.events.filter((event) => event.startsWith('close:'))).toEqual([])
    t.pinned.delete('a')
    await t.open('c')
    await waitFor(() => t.events.includes('close:a') && t.events.includes('close:b'), 3000, 'a+b')
    expect(t.host.openSessionIds()).toEqual(['c'])
  })

  it('L-06 a pending ask exempts the session', async () => {
    const t = await makeHost({ maxIdleOpen: 1 })
    const a = await t.open('a')
    const pending = a.requestUserInput(ask)
    expect(a.pendingInputCount).toBe(1)
    await t.open('b')
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    expect(a.closed).toBe(false)
    a.respondToInput('direct', { kind: 'ask', allowed: true })
    await pending
    await t.open('d')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed once answered')
  })

  it('L-07 ephemeral sessions are never closed, take no slot, and stay readable', async () => {
    const t = await makeHost({ maxIdleOpen: 1, ephemeral: ['e'] })
    const e = await t.open('e')
    await primeRoot(e, t.kit)
    t.kit.queue(answer('kept'))
    await e.submitUser('hello')
    await t.open('a')
    await sleep(30)
    expect(t.events.filter((event) => event.startsWith('close:'))).toEqual([])
    await t.open('b')
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    expect(t.events).not.toContain('close:e')
    expect(e.closed).toBe(false)
    expect(await transcript(await e.currentConversation())).toEqual([
      'pi.user:hello',
      'pi.assistant:kept'
    ])
  })

  it('L-08 reopening after an LRU close is transparent (entries, current conversation, thinking)', async () => {
    const t = await makeHost({ maxIdleOpen: 1 })
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    t.kit.queue(answer('a1'))
    await a.submitUser('u1')
    const root = await a.currentConversation()
    const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
    const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
    await a.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
    }, BG)
    await a.setThinkingLevel('high')
    const before = await transcript(root)
    await t.open('b')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed')
    const reopened = await t.open('a')
    const current = await reopened.currentConversation()
    expect(current.id).toBe(fork.id)
    expect((await current.agent(BG)).thinkingLevel).toBe('high')
    const reopenedRoot = (await reopened.harness.conversation(ROOT_CONVERSATION_ID, BG))!
    expect(await transcript(reopenedRoot)).toEqual(before)
    expect(await transcript(current)).toEqual(['pi.user:u1'])
  })

  it('L-09 trimming runs on open and on busy → idle (R7)', async () => {
    const t = await makeHost({ maxIdleOpen: 1 })
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    const run = held(answer('done'))
    t.kit.queue(run.step)
    const result = a.submitUser('work')
    await run.reached
    await t.open('b')
    await sleep(30)
    expect(t.events.filter((event) => event.startsWith('close:'))).toEqual([])
    run.release()
    expect(await result).toEqual({})
    await waitFor(() => t.events.includes('close:a'), 3000, 'trim after idle')
    expect(t.host.get('b')).toBeDefined()
  })

  it('L-10 interrupted sessions are evictable (R2)', async () => {
    const first = await makeHost()
    const a = await first.open('a')
    await primeRoot(a, first.kit)
    const stall = stalled()
    first.kit.queue(stall.step)
    void a.submitUser('hello')
    await stall.reached
    const t = await first.restart({ maxIdleOpen: 1 })
    const reopened = await t.open('a')
    expect(reopened.isInterrupted()).toBe(true)
    expect(reopened.runState).toBe('interrupted')
    await t.open('b')
    await waitFor(() => t.events.includes('close:a'), 3000, 'interrupted session closed')
    expect(t.kit.callCount).toBe(0)
  })

  it('L-11 a background compaction counts as busy (R10) — recorded behaviour', async () => {
    const summaryGate = deferred()
    const kit = fauxKit({ contextWindow: 3000 })
    const t = await makeHost({
      kit,
      maxIdleOpen: 1,
      // 窗口来自锁定的 faux 模型（K14）：reserve = background = 750 → 背景压缩从约 1500 tokens 开始；
      // 保留 100 tokens 才找得到切点
      settingsOverrides: { retry: { enabled: false }, compaction: { keepRecentTokens: 100 } }
    })
    let summarized = false
    const respond = async (
      context: TranscriptContext,
      options: { signal?: AbortSignal } | undefined
    ): Promise<ReturnType<typeof fauxAssistantMessage>> => {
      const first = context.messages[0]
      if (
        first?.role === 'system' &&
        typeof first.content === 'string' &&
        first.content.includes('summar')
      ) {
        await Promise.race([summaryGate.promise, aborted(options!.signal!)])
        summarized = true
        return fauxAssistantMessage('## Goal\nsummary')
      }
      return fauxAssistantMessage(`answer ${'details '.repeat(800)}`)
    }
    for (let i = 0; i < 6; i++) kit.queue(respond)
    const a = await t.open('a')
    await primeRoot(a, kit)
    expect(await a.submitUser('first question')).toEqual({})
    expect(await a.submitUser('second question')).toEqual({})
    const conversation = await a.currentConversation()
    const live = await a.harness.snapshot(LiveDoc, conversation.id, BG)
    expect(live?.compactions?.length ?? 0).toBeGreaterThan(0)
    // run 已结束，但压缩还活着：当前对话不算 busy，存储级状态仍是 busy，LRU 不关它
    expect(a.isBusy()).toBe(false)
    expect(a.runState).toBe('busy')
    await t.open('b')
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    expect(a.closed).toBe(false)
    summaryGate.resolve()
    await waitFor(() => summarized && a.runState === 'idle', 5000, 'compaction finished')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed once idle')
  })
})

describe('SessionHost LRU · auxiliary work (P2-01)', () => {
  /**
   * a 上一个 titler（ownerless 的 hook 对话：只看分类，不让根里的锚掺进来，PIN-12）在跑并被扣住；
   * 再开 b、c（maxIdleOpen 1）
   */
  async function titlerHeldWhileOthersOpen(): Promise<{
    t: TestHost
    a: DurableSession
    release: () => void
    done: Promise<unknown>
  }> {
    const t = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION], maxIdleOpen: 1 })
    const a = await t.open('a')
    const seeded = await seedAgent(a, { record: hookRec(), owner: 'none' })
    const run = held(answer('Title'))
    t.kit.queue(run.step)
    const submission = await startRun(a, seeded.conversationId, 'TITLE-ME')
    await run.reached
    await t.open('b')
    await sleep(30)
    expect(t.events.filter((event) => event.startsWith('close:'))).toEqual([])
    await t.open('c')
    await waitFor(() => t.events.includes('close:b'), 3000, 'b closed')
    return { t, a, release: run.release, done: submission.wait(BG) }
  }

  it('P2-01-48 running auxiliary work blocks eviction although the session reports idle', async () => {
    const { t, a, release, done } = await titlerHeldWhileOthersOpen()
    expect(a.closed).toBe(false)
    expect(a.runState).toBe('idle')
    expect(t.events.includes('close:a')).toBe(false)
    release()
    await withTimeout(done, 3000, 'titler run')
  })

  it('P2-01-49 when the auxiliary work ends the host trims again without another open (PIN-07)', async () => {
    const { t, a, release, done } = await titlerHeldWhileOthersOpen()
    expect(a.closed).toBe(false)
    release()
    await withTimeout(done, 3000, 'titler run')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed after the titler ended')
    expect(t.host.get('c')).toBeDefined()
  })

  it('P2-01-50 marked auxiliary work counts as nothing running: the reopened session is evictable', async () => {
    const first = await makeHost({ makeKit: wKit, extensions: [TEST_SPAWN_EXTENSION] })
    const a = await first.open('a')
    const seeded = await seedAgent(a, { record: hookRec() })
    const stall = stalled()
    first.kit.queue(stall.step)
    await startRun(a, seeded.conversationId, 'TITLE-ME')
    await stall.reached
    const t = await first.restart({ maxIdleOpen: 1 })
    const reopened = await t.open('a')
    expect(reopened.isInterrupted()).toBe(false)
    expect(reopened.runState).toBe('idle')
    await t.open('b')
    await waitFor(() => t.events.includes('close:a'), 3000, 'a closed')
    expect(t.kit.callCount).toBe(0)
  }, 15000)
})

describe('SessionHost run state events', () => {
  it('R-01 one busy/idle pair per run, tool round included (no flicker)', async () => {
    const gate = deferred()
    const t = await makeHost({ tools: [holdTool('hold', gate.promise)] })
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    t.kit.queue(callTool('hold'), answer('done'))
    const result = a.submitUser('go')
    await waitFor(() => t.statesOf('a').includes('busy'), 3000, 'busy')
    gate.resolve()
    expect(await result).toEqual({})
    await waitFor(() => t.statesOf('a').length === 3, 3000, 'idle')
    await sleep(20)
    // 打开时报一次 idle（PIN-R），之后一轮恰一对 busy / idle
    expect(t.statesOf('a')).toEqual(['idle', 'busy', 'idle'])
  })

  it('R-02 follow-up runs are reported; the final state is idle', async () => {
    const t = await makeHost()
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    const first = held(answer('a1'))
    t.kit.queue(first.step, answer('a2'))
    const result = a.submitUser('u1')
    await first.reached
    const queued = await a.followUp('f1')
    expect(queued.submissionId).toBeDefined()
    first.release()
    expect(await result).toEqual({})
    await withTimeout(
      (await a.harness.submission(queued.submissionId!, BG))!.wait(BG),
      3000,
      'follow-up'
    )
    await waitFor(() => t.statesOf('a').at(-1) === 'idle', 3000, 'final idle')
    const states = t.statesOf('a')
    expect(states[0]).toBe('idle')
    expect(states).not.toContain('interrupted')
    // 打开时报一次 idle（PIN-R）；结束与起跑在同一提交里：连续 busy
    expect(states).toEqual(['idle', 'busy', 'idle'])
  })

  it('R-03 closeAll during a held run emits nothing more; reopen reports interrupted', async () => {
    const t = await makeHost()
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    void a.submitUser('hello')
    await stall.reached
    await waitFor(() => t.statesOf('a').includes('busy'), 3000, 'busy')
    const count = t.states.length
    await withTimeout(t.host.closeAll(), 5000, 'closeAll')
    await sleep(50)
    expect(t.states).toHaveLength(count)
    const next = await t.restart()
    const reopened = await next.open('a')
    await waitFor(() => next.statesOf('a').includes('interrupted'), 3000, 'interrupted reported')
    expect(next.statesOf('a')).toEqual(['interrupted'])
    expect(reopened.isBusy()).toBe(false)
    expect(reopened.isInterrupted()).toBe(true)
  })

  it('R-05 PIN-R: every open reports the current state once, idle included — a busy marker a crash left behind heals', async () => {
    const first = await makeHost()
    const a = await first.open('a')
    await primeRoot(a, first.kit)
    first.kit.queue(answer('a1'))
    expect(await a.submitUser('u1')).toEqual({})
    // the DB marker as a crash between the final commit and the idle microtask would leave it
    const marker = new Map<string, RunState>([['a', 'busy']])
    const t = await first.restart({ onRunStateChange: (id, state) => marker.set(id, state) })
    const reopened = await t.open('a')
    expect(reopened.runState).toBe('idle')
    expect(t.statesOf('a')).toEqual(['idle'])
    expect(marker.get('a')).toBe('idle')
    await sleep(30)
    expect(t.statesOf('a')).toEqual(['idle'])
  })

  it('R-04 a throwing listener breaks neither the host nor the run', async () => {
    const t = await makeHost({
      onRunStateChange: () => {
        throw new Error('listener boom')
      }
    })
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    t.kit.queue(answer('fine'), answer('again'))
    expect(await a.submitUser('one')).toEqual({})
    expect(await a.submitUser('two')).toEqual({})
    await waitFor(() => t.warnings.some((w) => w.includes('listener boom')), 3000, 'logged')
    expect(await t.open('b')).toBeDefined()
  })
})

describe('SessionHost delete', () => {
  it('X-01 delete of an open idle session closes it before deleting; afterwards peek is undefined and open is fresh', async () => {
    const t = await makeHost()
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    t.kit.queue(answer('a1'))
    await a.submitUser('u1')
    await a.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).deferredNotices.push({
        requestId: 'r',
        text: 'n',
        kind: 'background'
      })
    }, BG)
    await withTimeout(t.host.delete('a'), 5000, 'delete')
    expect(t.events).toEqual(['open:a', 'close:a', 'delete:a'])
    expect(existsSync(t.file('a'))).toBe(false)
    expect(existsSync(`${t.file('a')}-wal`)).toBe(false)
    expect(await t.host.peek('a')).toBeUndefined()
    const fresh = await t.open('a')
    expect(await transcript(await fresh.currentConversation())).toEqual([])
    expect(await fresh.harness.snapshot(SessionStateDoc, BG)).toEqual({ deferredNotices: [] })
  })

  it('X-02 delete of a busy session resolves; storage is gone; no callbacks afterwards', async () => {
    const t = await makeHost()
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    const stall = stalled()
    t.kit.queue(stall.step)
    const result = a.submitUser('hello')
    await stall.reached
    await waitFor(() => t.statesOf('a').includes('busy'), 3000, 'busy')
    const count = t.states.length
    await withTimeout(t.host.delete('a'), 5000, 'delete busy')
    expect(existsSync(t.file('a'))).toBe(false)
    expect(await result).toMatchObject({ code: 'closed' })
    await sleep(50)
    expect(t.states).toHaveLength(count)
  })

  it('X-03 delete of a session that is not open deletes without opening', async () => {
    const t = await makeHost()
    await t.open('a')
    await t.host.close('a')
    t.events.length = 0
    await withTimeout(t.host.delete('a'), 5000, 'delete closed')
    expect(t.events).toEqual(['delete:a'])
    expect(existsSync(t.file('a'))).toBe(false)
  })

  it('X-04 delete of an ephemeral session drops its memory storage', async () => {
    const t = await makeHost({ ephemeral: ['e'] })
    await t.open('e')
    expect(t.memory.has('e')).toBe(true)
    await withTimeout(t.host.delete('e'), 5000, 'delete ephemeral')
    expect(t.memory.has('e')).toBe(false)
    expect(await t.host.peek('e')).toBeUndefined()
  })

  it('X-05 delete during an in-flight open waits, closes and deletes; the next instance is fresh', async () => {
    const t = await makeHost()
    const a = await t.open('a')
    await primeRoot(a, t.kit)
    t.kit.queue(answer('a1'))
    await a.submitUser('u1')
    await t.host.close('a')
    t.events.length = 0
    const opening = t.open('a')
    const deleting = t.host.delete('a')
    await withTimeout(deleting, 5000, 'delete')
    const session = await withTimeout(opening, 5000, 'open')
    expect(t.events).toEqual(['open:a', 'close:a', 'delete:a', 'open:a'])
    expect(await transcript(await session.currentConversation())).toEqual([])
    const next = await t.open('a')
    expect(next).toBe(session)
  })

  it('X-06 delete with a pending ask cancels the ask and completes', async () => {
    const ref: { session?: DurableSession } = {}
    let response: InputResponse | undefined
    const tools = [askingTool('askme', () => ref.session!, { onResolved: (r) => (response = r) })]
    const t = await makeHost({ tools })
    const session = (ref.session = await t.open('a'))
    await primeRoot(session, t.kit)
    t.kit.queue(callTool('askme'), answer('after'))
    void session.submitUser('go')
    await waitFor(() => session.pendingInputCount === 1, 3000, 'ask pending')
    await withTimeout(t.host.delete('a'), 5000, 'delete with ask')
    expect(response).toEqual({ kind: 'cancel', reason: 'closed' })
    expect(existsSync(t.file('a'))).toBe(false)
  })
})
