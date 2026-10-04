/**
 * DurableSession 的状态面：当前对话指针（R11 回退）、isBusy（R2，按当前对话）、思考档位
 * （下一次请求生效、持久、从不开启调度器、作用于当前对话）。
 */
import { AgentDoc, ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { answer, callTool, held, stalled, type FauxKit } from './support/faux'
import { makeHost, primeRoot, registerHostCleanup } from './support/host'
import { holdTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

/** 根对话上答一轮，然后在第一条用户消息处 fork 一个无主对话，并把指针指过去 */
async function forkAndPoint(session: DurableSession, kit: FauxKit): Promise<ConversationId> {
  await primeRoot(session, kit)
  kit.queue(answer('a1'))
  await session.submitUser('u1')
  const root = await session.currentConversation()
  const userEntry = (await allEntries(root)).find((entry) => entry.kind === 'pi.user')!
  const fork = await root.fork(userEntry.id, { ownership: { kind: 'ownerless' } }, BG)
  await session.harness.commit(async (tx) => {
    ;(await tx.doc(SessionStateDoc)).currentConversation = fork.id
  }, BG)
  return fork.id
}

describe('current conversation', () => {
  it('CC-01 a fresh session points at the root', async () => {
    const t = await makeHost()
    const session = await t.open()
    expect((await session.currentConversation()).id).toBe(ROOT_CONVERSATION_ID)
  })

  it('CC-02 the pointer moves the target: send, isBusy and abort act on the fork', async () => {
    const t = await makeHost()
    const session = await t.open()
    const forkId = await forkAndPoint(session, t.kit)
    const root = (await session.harness.conversation(ROOT_CONVERSATION_ID, BG))!
    const rootBefore = await transcript(root)

    t.kit.queue(answer('f1'))
    expect(await session.submitUser('on fork')).toEqual({})
    const fork = (await session.harness.conversation(forkId, BG))!
    expect(await transcript(fork)).toEqual(['pi.user:u1', 'pi.user:on fork', 'pi.assistant:f1'])
    expect(await transcript(root)).toEqual(rootBefore)

    const run = held(answer('never'))
    t.kit.queue(run.step)
    const result = session.submitUser('long')
    await run.reached
    await waitFor(() => session.isBusy(), 3000, 'busy on fork')
    await withTimeout(session.abort(), 5000, 'abort fork')
    expect(await result).toEqual({})
    expect(session.isBusy()).toBe(false)
    expect(await transcript(root)).toEqual(rootBefore)
  })

  it('CC-03 the pointer survives a reopen', async () => {
    const t = await makeHost()
    const session = await t.open()
    const forkId = await forkAndPoint(session, t.kit)
    await t.host.close('s1')
    const reopened = await t.open()
    expect((await reopened.currentConversation()).id).toBe(forkId)
  })

  it('CC-04 a pointer to a conversation that does not exist falls back to the root (R11)', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = 999 as ConversationId
    }, BG)
    expect((await session.currentConversation()).id).toBe(ROOT_CONVERSATION_ID)
    expect(t.warnings.some((warning) => warning.includes('999'))).toBe(true)
    await primeRoot(session, t.kit)
    t.kit.queue(answer('ok'))
    expect(await session.submitUser('hello')).toEqual({})
    const root = (await session.harness.conversation(ROOT_CONVERSATION_ID, BG))!
    expect(await transcript(root)).toEqual(['pi.user:hello', 'pi.assistant:ok'])
  })
})

describe('isBusy', () => {
  it('B-01 false idle, true while a request is held, false right after the answer and after abort', async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    expect(session.isBusy()).toBe(false)
    const run = held(answer('a1'))
    t.kit.queue(run.step)
    const result = session.submitUser('u1')
    await run.reached
    await waitFor(() => session.isBusy(), 3000, 'busy')
    run.release()
    expect(await result).toEqual({})
    expect(session.isBusy()).toBe(false)

    const stall = stalled()
    t.kit.queue(stall.step)
    const second = session.submitUser('u2')
    await stall.reached
    expect(session.isBusy()).toBe(true)
    await withTimeout(session.abort(), 5000, 'abort')
    expect(session.isBusy()).toBe(false)
    expect(await second).toEqual({})
  })

  it('B-02 isBusy follows the current conversation; the host-level state still sees others', async () => {
    const t = await makeHost()
    const session = await t.open()
    const other = await session.harness.createConversation({ ownership: { kind: 'ownerless' } }, BG)
    await other.configure({ model: t.kit.model }, BG)
    const run = held(answer('side'))
    t.kit.queue(run.step)
    const submission = await other.submit({ type: 'input', content: 'side' }, BG)
    await run.reached
    expect(session.isBusy()).toBe(false)
    expect(session.runState).toBe('busy')
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(SessionStateDoc)).currentConversation = other.id
    }, BG)
    expect(session.isBusy()).toBe(true)
    run.release()
    expect((await submission.wait(BG)).status).toBe('done')
    expect(session.isBusy()).toBe(false)
  })
})

describe('thinking level', () => {
  it('T-01 applies from the next request (changed during a held tool round)', async () => {
    const gate = deferred()
    const running = deferred()
    const t = await makeHost({
      tools: [holdTool('hold', gate.promise, { onRun: () => running.resolve() })]
    })
    const session = await t.open()
    await primeRoot(session, t.kit)
    await session.setThinkingLevel('low')
    t.kit.queue(callTool('hold'), answer('done'))
    const result = session.submitUser('go')
    await running.promise
    await session.setThinkingLevel('high')
    gate.resolve()
    expect(await result).toEqual({})
    expect(t.kit.requests[0]!.options?.reasoning).toBe('low')
    expect(t.kit.requests[1]!.options?.reasoning).toBe('high')
  })

  it("T-02 'off' sends no reasoning option", async () => {
    const t = await makeHost()
    const session = await t.open()
    await primeRoot(session, t.kit)
    await session.setThinkingLevel('off')
    t.kit.queue(answer('plain'))
    await session.submitUser('hi')
    expect(t.kit.requests[0]!.options?.reasoning).toBeUndefined()
  })

  it('T-03 persisted in pi.agent across a reopen', async () => {
    const t = await makeHost()
    const session = await t.open()
    await session.setThinkingLevel('medium')
    await t.host.close('s1')
    const reopened = await t.open()
    expect((await (await reopened.currentConversation()).agent(BG)).thinkingLevel).toBe('medium')
    expect(await reopened.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, BG)).toMatchObject({
      thinkingLevel: 'medium'
    })
  })

  it('T-04 setting it on an interrupted session does not resume anything', async () => {
    const first = await makeHost()
    const session = await first.open()
    await primeRoot(session, first.kit)
    const stall = stalled()
    first.kit.queue(stall.step)
    void session.submitUser('hello')
    await stall.reached
    const t = await first.restart()
    const reopened = await t.open()
    expect(reopened.isInterrupted()).toBe(true)
    await reopened.setThinkingLevel('high')
    await sleep(50)
    expect((await reopened.harness.inspect(BG)).scheduling).toBe('paused')
    expect(reopened.isInterrupted()).toBe(true)
    expect(t.kit.callCount).toBe(0)
  })

  it('T-05 applies to the current conversation (a fork), not the root', async () => {
    const t = await makeHost()
    const session = await t.open()
    const forkId = await forkAndPoint(session, t.kit)
    await session.setThinkingLevel('high')
    const fork = (await session.harness.conversation(forkId, BG))!
    const root = (await session.harness.conversation(ROOT_CONVERSATION_ID, BG))!
    expect((await fork.agent(BG)).thinkingLevel).toBe('high')
    expect((await root.agent(BG)).thinkingLevel).toBe('off')
  })
})
