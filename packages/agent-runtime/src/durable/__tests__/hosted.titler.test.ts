/**
 * 宿主派发 · titler（观察型，P2-08 B 段：05–15、18、20、21；桌面的 16 / 17 / 19 在 desktop 的
 * hostedAgents.integration.test.ts）。
 *
 * 一次 fire = **一个提交**：锚任务（后台、当前对话）+ 它拥有的子对话 + `pi.agent` + 冻结的派生人设 + 派生 agent
 * 记录（`dispatch: 'hook'`、`hook`、深度 1、`canSpawn: false`）。之后 durable 照常跑那条子对话；它与它的锚都
 * 不进运行状态（PIN-02）：侧栏不会因为在起标题而闪一下忙，根的 Esc / `continue()` / `destroyAgent` 碰不到它，
 * 崩溃之后它被打上中止标记、从不续跑（Q-P2-06）；被中断的会话上根本不派发（PIN-07）；没有存储的会话 id
 * 什么都不建（PIN-08）。超时会中止那条子对话（PIN-05）。
 *
 * faux 按内容路由（`queueRoles`）：titler 的请求带 `<hook_event trigger="session.prompt-accepted">`。
 */
import { readdirSync } from 'node:fs'
import type { FauxResponseStep } from '@earendil-works/pi-ai'
import {
  AgentDoc,
  ROOT_CONVERSATION_ID,
  type CommitPublication,
  type ConversationId,
  type TaskId
} from '@earendil-works/pi-durable'
import { describe, expect, it, vi } from 'vitest'
import { renderHookPrompt } from '../../hook/hookPrompt'
import { spawnedAgentRecordOf } from '../agentRecord'
import { SPAWN_ANCHOR_TASK } from '../anchor'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { answer, callTool, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  anchors,
  hookRig,
  promptPayload,
  queueRoles,
  requestsOfRole,
  reviewerOf,
  TITLE_FENCE,
  TITLE_HOOK,
  type HookRig
} from './support/hookRig'
import {
  holdGate,
  liveTasks,
  mentions,
  rec,
  seedAgent,
  submissionByRequest,
  taskRecord,
  tasksOf
} from './support/spawn'
import { allEntries, messageText } from './support/transcript'
import { aborted, deferred, sleep, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID
const TRIGGER = 'session.prompt-accepted'

/** 一次 fire（缺省 promptPayload()） */
function fire(rig: HookRig, payload = promptPayload()): void {
  rig.runner.fire(TRIGGER, payload)
}

/** 第 n 个锚（创建次序）拥有的那条 titler 对话 */
async function titlerConversation(session: DurableSession, n = 0): Promise<ConversationId> {
  let found: ConversationId | undefined
  await waitFor(async () => {
    const list = (await anchors(session)).sort((a, b) => a.id - b.id)
    const anchor = list[n]
    if (anchor === undefined) return false
    found = (await reviewerOf(session, anchor.id))[0]
    return found !== undefined
  })
  return found!
}

/** 转写的条目种类（跳过 pi.system） */
async function kindsOf(session: DurableSession, id: ConversationId): Promise<string[]> {
  const conversation = (await session.harness.conversation(id, BG))!
  return (await allEntries(conversation))
    .filter((entry) => entry.kind !== 'pi.system')
    .map((entry) => entry.kind)
}

/** 一个看得见 signal 落下的 stalled（-18） */
function watchedStall(): {
  step: FauxResponseStep
  reached: Promise<void>
  abortedSeen: () => boolean
} {
  const reached = deferred()
  let seen = false
  const step: FauxResponseStep = async (_context, options) => {
    reached.resolve()
    options!.signal!.addEventListener('abort', () => (seen = true), { once: true })
    return aborted(options!.signal!)
  }
  return { step, reached: reached.promise, abortedSeen: () => seen }
}

describe('P2-08 B · titler dispatch (observe)', () => {
  it('P2-08-05 one commit: anchor + owned conversation + AgentDoc + AgentStateDoc; inside that publication the titler is spawned, the session idle and not interrupted', async () => {
    const rig = await hookRig()
    const session = rig.session
    const seen: {
      changes: CommitPublication['changes']
      identity: string | undefined
      runState: string
      interrupted: boolean
    }[] = []
    const stop = session.harness.subscribeCommits((publication) => {
      const created = publication.changes.find(
        (change) => change.type === 'conversation' && change.value.owner !== undefined
      )
      if (created === undefined || created.type !== 'conversation') return
      seen.push({
        changes: publication.changes,
        identity: session.agentIdentity(created.value.id)?.kind,
        runState: session.runState,
        interrupted: session.isInterrupted()
      })
    })
    queueRoles(rig.kit, { titler: [answer('Hooked title')] })
    fire(rig)
    await waitFor(() => rig.ends().length === 1)
    stop()

    expect(seen).toHaveLength(1)
    const [only] = seen
    expect(only!.identity).toBe('spawned')
    expect(only!.runState).toBe('idle')
    expect(only!.interrupted).toBe(false)
    const changes = only!.changes
    const anchorTask = changes.find(
      (change) => change.type === 'task' && change.value.kind === SPAWN_ANCHOR_TASK
    )
    expect(anchorTask?.type === 'task' && anchorTask.value.background).toBe(true)
    expect(anchorTask?.type === 'task' && anchorTask.value.conversationId).toBe(ROOT)
    const conversation = changes.find((change) => change.type === 'conversation')
    const T = conversation?.type === 'conversation' ? conversation.value.id : undefined
    expect(conversation?.type === 'conversation' && conversation.value.owner).toEqual({
      conversationId: ROOT,
      taskId: anchorTask?.type === 'task' ? anchorTask.value.id : undefined
    })
    const docsOfT = changes
      .filter((change) => change.type === 'document' && change.conversationId === T)
      .map((change) => (change.type === 'document' ? change.record.kind : ''))
    expect(docsOfT).toEqual(
      expect.arrayContaining([AgentDoc.definition.kind, AgentStateDoc.definition.kind])
    )
    const state = changes.find(
      (change) =>
        change.type === 'document' &&
        change.conversationId === T &&
        change.record.kind === AgentStateDoc.definition.kind
    )
    const value = state?.type === 'document' ? (state.value as Record<string, unknown>) : {}
    expect(value).toMatchObject({ kind: 'spawned', dispatch: 'hook', hook: 'auto-title' })
    expect(typeof value.persona).toBe('string')
    expect(rig.t.warnings).toEqual([])
  })

  it('P2-08-06 the record and the configuration: titler profile, lock model, thinking off, depth 1, no resultContract; the request is the rendered hook prompt; root AgentDoc unchanged', async () => {
    const rig = await hookRig()
    const rootBefore = await rig.session.harness.snapshot(AgentDoc, ROOT, BG)
    queueRoles(rig.kit, { titler: [answer('Hooked title')] })
    const payload = promptPayload({ promptText: 'plan the trip' })
    fire(rig, payload)
    await waitFor(() => rig.ends().length === 1)
    const T = await titlerConversation(rig.session)
    const [anchor] = await anchors(rig.session)
    const record = await spawnedAgentRecordOf(rig.session.harness, T, BG)
    expect(record).toMatchObject({
      conversationId: T,
      profileName: 'titler',
      kind: 'spawned',
      model: { provider: 'faux', modelId: 'faux-1' },
      thinkingLevel: 'off',
      toolNames: ['titleProbe'],
      dispatch: 'hook',
      hook: 'auto-title',
      ownerTaskId: anchor!.id,
      parentConversationId: ROOT,
      depth: 1,
      canSpawn: false,
      displayName: 'Titler',
      description: TITLE_HOOK.displayName,
      agentId: expect.stringMatching(/^sub-/)
    })
    expect(record && 'resultContract' in record).toBe(false)
    // hook 派发没有派发卡：记录里没有派发它的 tool_call id
    expect('ownerCallId' in record!).toBe(false)
    const [request] = requestsOfRole(rig.kit, 'titler')
    expect(request!.modelId).toBe('faux-1')
    expect(request!.tools.map((tool) => tool.name)).toEqual(['titleProbe'])
    const lastUser = [...request!.messages].reverse().find((m) => m.role === 'user')
    expect(messageText(lastUser)).toBe(renderHookPrompt(TITLE_HOOK.prompt, TRIGGER, { ...payload }))
    expect(await rig.session.harness.snapshot(AgentDoc, ROOT, BG)).toEqual(rootBefore)
  })

  it('P2-08-07 outcome and events: transcript, ok:true, anchor completed; one register (no parentToolCallId) then one end', async () => {
    const rig = await hookRig()
    queueRoles(rig.kit, {
      titler: [callTool('titleProbe', { title: 'Hooked title' }), answer('Hooked title')]
    })
    const payload = promptPayload()
    fire(rig, payload)
    await waitFor(() => rig.ends().length === 1)
    const T = await titlerConversation(rig.session)
    expect(await kindsOf(rig.session, T)).toEqual([
      'pi.user',
      'pi.assistant',
      'pi.tool-result',
      'pi.assistant'
    ])
    const conversation = (await rig.session.harness.conversation(T, BG))!
    const entries = (await allEntries(conversation)).filter((e) => e.kind !== 'pi.system')
    expect(messageText(entries.at(-1)!.model?.[0])).toBe('Hooked title')
    expect(rig.ends()).toEqual([expect.objectContaining({ ok: true })])
    expect(rig.runner.runningCount()).toBe(0)
    await waitFor(async () => (await anchors(rig.session))[0]!.state.status === 'terminal')
    expect((await anchors(rig.session))[0]!.state).toEqual({
      status: 'terminal',
      outcome: { status: 'completed', result: null }
    })
    const record = await spawnedAgentRecordOf(rig.session.harness, T, BG)
    const registers = rig.router.registers()
    expect(registers).toHaveLength(1)
    expect(registers[0]).toMatchObject({
      sessionId: record!.agentId,
      parentSessionId: 's1',
      subAgentName: 'titler',
      description: TITLE_HOOK.displayName,
      prompt: renderHookPrompt(TITLE_HOOK.prompt, TRIGGER, { ...payload })
    })
    expect('parentToolCallId' in registers[0]!).toBe(false)
    expect(rig.router.ends()).toEqual([
      expect.objectContaining({ sessionId: record!.agentId, isError: false })
    ])
    expect(rig.titleCalls).toEqual([
      { sessionId: 's1', conversationId: T, taskId: expect.any(Number) }
    ])
  })

  it('P2-08-08 every run is fresh: two fires → two anchors, two conversations, two agentIds; no history carried; distinct requestIds hook:<runId>', async () => {
    const rig = await hookRig()
    queueRoles(rig.kit, { titler: [answer('one')] })
    fire(rig)
    await waitFor(() => rig.ends().length === 1)
    queueRoles(rig.kit, { titler: [answer('two')] })
    fire(rig)
    await waitFor(() => rig.ends().length === 2)
    const list = (await anchors(rig.session)).sort((a, b) => a.id - b.id)
    expect(list).toHaveLength(2)
    const T1 = await titlerConversation(rig.session, 0)
    const T2 = await titlerConversation(rig.session, 1)
    expect(T1).not.toBe(T2)
    const r1 = await spawnedAgentRecordOf(rig.session.harness, T1, BG)
    const r2 = await spawnedAgentRecordOf(rig.session.harness, T2, BG)
    expect(r1!.agentId).not.toBe(r2!.agentId)
    expect((await kindsOf(rig.session, T2)).filter((kind) => kind === 'pi.user')).toHaveLength(1)
    const [run1, run2] = rig.starts().map((start) => start.run.runId)
    expect(run1).not.toBe(run2)
    expect(await submissionByRequest(rig.session, T1, `hook:${run1}`)).toBeDefined()
    expect(await submissionByRequest(rig.session, T2, `hook:${run2}`)).toBeDefined()
    expect(await submissionByRequest(rig.session, T2, `hook:${run1}`)).toBeUndefined()
  })

  it('P2-08-09 no runState blip: a whole held titler run adds no state report; every commit sees idle and not busy', async () => {
    const rig = await hookRig()
    const session = rig.session
    const before = rig.t.statesOf('s1')
    const bad: string[] = []
    const stop = session.harness.subscribeCommits(() => {
      if (session.runState !== 'idle' || session.isBusy()) {
        bad.push(`${session.runState}/${session.isBusy()}`)
      }
    })
    const h = held(answer('Hooked title'))
    queueRoles(rig.kit, { titler: [h.step] })
    fire(rig)
    await h.reached
    expect(session.runState).toBe('idle')
    h.release()
    await waitFor(() => rig.ends().length === 1)
    await waitFor(async () => (await liveTasks(session)).length === 0)
    await sleep(20)
    stop()
    expect(bad).toEqual([])
    expect(rig.t.statesOf('s1')).toEqual(before)
  })

  it('P2-08-09 variant: with maxIdleOpen 1 and a second session open, s1 is closed (LRU) within 3 s after the titler ends', async () => {
    const rig = await hookRig({ host: { maxIdleOpen: 1 } })
    const h = held(answer('Hooked title'))
    queueRoles(rig.kit, { titler: [h.step] })
    fire(rig)
    await h.reached
    await rig.open('s2')
    await sleep(20)
    // 还在起标题：不可回收
    expect(rig.t.events).not.toContain('close:s1')
    h.release()
    await waitFor(() => rig.t.events.includes('close:s1'), 3000, 's1 closed by LRU')
  })

  it('P2-08-10 a root run beside the titler: one busy/idle pair; idle comes while the titler and its anchor are still live; releasing the titler reports nothing', async () => {
    const rig = await hookRig()
    const session = rig.session
    const root = held(answer('root done'))
    const titler = held(answer('Hooked title'))
    queueRoles(rig.kit, { root: [root.step], titler: [titler.step] })
    const before = rig.t.statesOf('s1').length
    const sent = session.submitUser('hi')
    await root.reached
    fire(rig)
    await titler.reached
    root.release()
    expect(await sent).toEqual({})
    await waitFor(() => rig.t.statesOf('s1').length === before + 2)
    expect(rig.t.statesOf('s1').slice(before)).toEqual(['busy', 'idle'])
    // idle 报出的那一刻 titler 与锚都还活着
    expect((await anchors(session))[0]!.state.status).toBe('completing')
    const T = await titlerConversation(session)
    expect((await liveTasks(session, T)).length).toBeGreaterThan(0)
    titler.release()
    await waitFor(() => rig.ends().length === 1)
    await waitFor(async () => (await liveTasks(session)).length === 0)
    await sleep(20)
    expect(rig.t.statesOf('s1').slice(before)).toEqual(['busy', 'idle'])
  })

  it('P2-08-11 the exclusion is narrow: a background anchor owning a tool child keeps the session busy; a root tool task owning a live reviewer too', async () => {
    const rig = await hookRig()
    const session = rig.session
    // (a) P2-03-53 的形状：后台锚拥有一条 tool 派发的子对话，它的工作在跑
    const gateName = `p2-08-11-${Math.random()}`
    await seedAgent(session, { record: rec(), hold: gateName })
    session.harness.resume()
    await waitFor(() => session.runState === 'busy')
    holdGate(gateName).resolve()
    await waitFor(async () => (await liveTasks(session)).length === 0)
    await waitFor(() => session.runState === 'idle')
    // (b) 根的 askOp 任务拥有一个活着的审查员
    const reviewer = held(answer('thinking'))
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('after')],
      reviewer: [reviewer.step]
    })
    const sent = session.submitUser('do it')
    await reviewer.reached
    expect(session.runState).toBe('busy')
    reviewer.release()
    await withTimeout(sent, 5000, 'root send')
  })

  it('P2-08-12 Esc leaves the titler alone: root aborted; titler tasks not marked, anchor live; released → done, titleProbe once', async () => {
    const rig = await hookRig()
    const session = rig.session
    const root = held(answer('never'))
    const first = held(callTool('titleProbe', { title: 't' }))
    queueRoles(rig.kit, { root: [root.step], titler: [first.step, answer('Hooked title')] })
    const sent = session.submitUser('hi')
    await root.reached
    fire(rig)
    await first.reached
    await withTimeout(session.abort(), 5000, 'abort')
    expect(await sent).toEqual({})
    const T = await titlerConversation(session)
    const live = await liveTasks(session, T)
    expect(live.length).toBeGreaterThan(0)
    expect(live.every((task) => !task.abortRequested)).toBe(true)
    const [anchor] = await anchors(session)
    expect(anchor!.state.status).not.toBe('terminal')
    expect(anchor!.abortRequested).toBe(false)
    first.release()
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
    expect(rig.titleCalls).toHaveLength(1)
  })

  it('P2-08-13a continue() on an idle session with a held titler resolves {} at once and leaves the titler alone', async () => {
    const rig = await hookRig()
    const h = held(answer('Hooked title'))
    queueRoles(rig.kit, { titler: [h.step] })
    fire(rig)
    await h.reached
    const started = Date.now()
    expect(await withTimeout(rig.session.continue(), 100, 'continue')).toEqual({})
    expect(Date.now() - started).toBeLessThan(100)
    const T = await titlerConversation(rig.session)
    expect((await liveTasks(rig.session, T)).every((task) => !task.abortRequested)).toBe(true)
    h.release()
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
  })

  it(
    'P2-08-13b continue() in process 2 (root interrupted) returns once root is done, while a titler fired meanwhile is still held',
    async () => {
      const rig = await hookRig()
      const stall = stalled()
      queueRoles(rig.kit, { root: [stall.step] })
      void rig.session.submitUser('hi')
      await stall.reached
      const next = await rig.reopen()
      expect(next.session.isInterrupted()).toBe(true)
      const root = held(answer('root done'))
      const titler = held(answer('Hooked title'))
      queueRoles(next.kit, { root: [root.step], titler: [titler.step] })
      const continued = next.session.continue()
      await root.reached
      fire(next)
      await titler.reached
      root.release()
      expect(await withTimeout(continued, 3000, 'continue')).toEqual({})
      expect(next.ends()).toEqual([])
      titler.release()
      await waitFor(() => next.ends().length === 1)
      expect(next.ends()[0]!.ok).toBe(true)
    },
    RESTART_TIMEOUT
  )

  it('P2-08-14 destroyAgent leaves the titler alone: no beforeAbort, titler tasks not marked; released → done', async () => {
    const beforeAbort = vi.fn()
    const rig = await hookRig({ host: { beforeAbort } })
    const h = held(answer('Hooked title'))
    queueRoles(rig.kit, { titler: [h.step] })
    fire(rig)
    await h.reached
    await withTimeout(rig.session.destroyAgent(), 5000, 'destroyAgent')
    expect(beforeAbort).not.toHaveBeenCalled()
    const T = await titlerConversation(rig.session)
    expect((await liveTasks(rig.session, T)).every((task) => !task.abortRequested)).toBe(true)
    h.release()
    await waitFor(() => rig.ends().length === 1)
    expect(rig.ends()[0]!.ok).toBe(true)
  })

  it(
    'P2-08-15 never resumed after a crash: marked at open, idle and not interrupted, no request; the next send ends it aborted; a new fire runs normally',
    async () => {
      const rig = await hookRig()
      const stall = stalled()
      queueRoles(rig.kit, { titler: [stall.step] })
      fire(rig)
      await stall.reached
      const T = await titlerConversation(rig.session)
      const [anchor] = await anchors(rig.session)
      const next = await rig.reopen()
      const session = next.session
      const live = await liveTasks(session, T)
      expect(live.length).toBeGreaterThan(0)
      expect(live.every((task) => task.abortRequested)).toBe(true)
      expect(session.runState).toBe('idle')
      expect(session.isInterrupted()).toBe(false)
      expect(next.t.statesOf('s1')).toEqual(['idle'])
      await sleep(150)
      expect(next.kit.callCount).toBe(0)

      queueRoles(next.kit, { root: [answer('hello back')] })
      expect(await session.submitUser('hi')).toEqual({})
      await waitFor(async () => (await liveTasks(session)).length === 0)
      expect(next.kit.requests).toHaveLength(1)
      expect((await tasksOf(session, T)).map((task) => task.state)).toEqual([
        { status: 'terminal', outcome: { status: 'aborted' } }
      ])
      expect((await taskRecord(session, anchor!.id as TaskId))?.state.status).toBe('terminal')
      expect(rig.titleCalls).toEqual([])

      queueRoles(next.kit, {
        titler: [callTool('titleProbe', { title: 'x' }), answer('Hooked title')]
      })
      fire(next)
      await waitFor(() => next.ends().length === 1)
      expect(next.ends()[0]!.ok).toBe(true)
      expect(rig.titleCalls).toHaveLength(1)
      expect(rig.titleCalls[0]!.conversationId).not.toBe(T)
    },
    RESTART_TIMEOUT
  )

  it('P2-08-18 an observe timeout aborts the conversation: ok:false "timed out after 50ms"; the faux step saw the abort; the generation and the anchor end within 1 s', async () => {
    const rig = await hookRig({ timeoutMs: 50 })
    const stall = watchedStall()
    queueRoles(rig.kit, { titler: [stall.step] })
    fire(rig)
    await stall.reached
    await waitFor(() => rig.ends().length === 1, 2000)
    expect(rig.ends()[0]).toMatchObject({ ok: false, error: 'timed out after 50ms' })
    const T = await titlerConversation(rig.session)
    await waitFor(async () => (await liveTasks(rig.session)).length === 0, 1000, 'all terminal')
    expect(stall.abortedSeen()).toBe(true)
    expect((await tasksOf(rig.session, T)).map((task) => task.state.status)).toEqual(['terminal'])
    expect((await anchors(rig.session))[0]!.state.status).toBe('terminal')
    expect(rig.runner.runningCount()).toBe(0)
  })

  it(
    'P2-08-20 dispatch never resumes an interrupted session (PIN-07): fire and anchor-owned decide are skipped as interrupted; nothing is created; the scheduler stays paused',
    async () => {
      const rig = await hookRig()
      const stall = stalled()
      queueRoles(rig.kit, { root: [stall.step] })
      void rig.session.submitUser('hi')
      await stall.reached
      const next = await rig.reopen()
      const session = next.session
      expect(session.isInterrupted()).toBe(true)
      const conversationsBefore = await session.harness.commit(
        async (tx) => (await tx.scanConversations({}, 256)).items.length,
        BG
      )
      fire(next)
      expect(await next.decide()).toBeNull()
      await sleep(300)
      expect(next.kit.callCount).toBe(0)
      expect((await session.harness.inspect(BG)).scheduling).toBe('paused')
      expect(session.isInterrupted()).toBe(true)
      expect(await anchors(session)).toEqual([])
      expect(
        await session.harness.commit(
          async (tx) => (await tx.scanConversations({}, 256)).items.length,
          BG
        )
      ).toBe(conversationsBefore)
      expect(next.skips().map((skip) => [skip.hook, skip.reason])).toEqual([
        ['auto-title', 'interrupted'],
        ['auto-review', 'interrupted']
      ])
      expect(next.starts()).toEqual([])
      expect(next.infos()).toContainEqual(
        expect.stringContaining('skipped for session s1: interrupted')
      )
    },
    RESTART_TIMEOUT
  )

  it('P2-08-21 no storage, nothing created (PIN-08): a fire for an unknown session never opens it; the run fails with a reason', async () => {
    const rig = await hookRig()
    const listing = readdirSync(rig.t.dir).sort()
    fire(rig, promptPayload({ sessionId: 's9' }))
    await waitFor(() => rig.ends().length + rig.skips().length === 1)
    expect(rig.ends()).toEqual([
      expect.objectContaining({ ok: false, error: 'Session not found: s9' })
    ])
    expect(rig.t.events).not.toContain('open:s9')
    expect(rig.t.host.get('s9')).toBeUndefined()
    expect(readdirSync(rig.t.dir).sort()).toEqual(listing)
    expect(mentions(rig.kit, TITLE_FENCE)).toBe(false)
  })
})
