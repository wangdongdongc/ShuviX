/**
 * 宿主派发 · 权限审查员（判定型，P2-08 C 段：22–30、33；31 / 32 的桌面标记在 desktop，34 / 35 在桌面集成）。
 *
 * 审查员那条对话归**提问的那个工具任务**所有（Q16，`ownerTaskId`）：它随那次工具调用的中止原生级联，那个任务
 * 等它收场才算完（fact 4）—— 所以判定超时 / 外部 signal 落下时协调器**中止那条对话**，工具任务因此不会以
 * completing 挂住根的这一轮。没有 taskId 时归一个后台锚任务。每次判定一条新的对话（PIN-04，从不重新挂上），
 * 崩溃之后不续跑（unsafe 工具：工具以「interrupted … may have partially run」收场、名下的审查员随之中止；safe
 * 工具：重跑再派一个新的）。拥有者已经死了（打了中止标记）→ 创建被拒、什么都不建（PIN-13）。
 * 拒绝计数仍是进程内、按会话的（安全模块），不进任何文档。
 */
import { Type, type FauxResponseStep } from '@earendil-works/pi-ai'
import {
  ROOT_CONVERSATION_ID,
  defineTool,
  type ConversationId,
  type TaskId,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import {
  PERMISSION_VERDICT_SCHEMA,
  type PermissionDecision,
  type PermissionVerdict
} from '@shuvix/chat-protocol/types/permissionReview'
import type { InputRequest, InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import { executeDecision } from '../../security/enforce'
import { clearReviewState, reviewSuspended } from '../../security/reviewState'
import type { SecurityDecision, SecurityHostProvider } from '../../security/types'
import { clearSessionDecisions } from '../../security/decisionLog'
import { spawnedAgentRecordOf } from '../agentRecord'
import { backgroundContext as BG } from '../context'
import { AgentStateDoc, SessionStateDoc } from '../docs'
import type { DurableSession } from '../durableSession'
import { answer, callTool, held, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  anchors,
  ASKER,
  hookRig,
  permissionPayload,
  queueRoles,
  REVIEW_HOOK,
  requestsOfRole,
  reviewerOf,
  rigConfig,
  type HookRig
} from './support/hookRig'
import {
  callAgent,
  dispatchTask,
  HoldTask,
  holdGate,
  liveTasks,
  submissionByRequest,
  taskRecord,
  tasksOf
} from './support/spawn'
import { allEntries, messageText } from './support/transcript'
import { aborted, deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000
const ROOT = ROOT_CONVERSATION_ID

function verdict(decision: PermissionDecision = 'allow'): PermissionVerdict {
  return { decision, risk: 'low', summary: `${decision} it`, reason: `because ${decision}` }
}

/** 审查员交卷：一次 `next` */
function next(decision: PermissionDecision = 'allow'): ReturnType<typeof callTool> {
  return callTool('next', { ...verdict(decision) }, 'call-next')
}

/** 某对话里 pi.user 的条数 */
async function userCount(session: DurableSession, id: ConversationId): Promise<number> {
  const conversation = (await session.harness.conversation(id, BG))!
  return (await allEntries(conversation)).filter((entry) => entry.kind === 'pi.user').length
}

/** 根对话里最后一条工具结果的文本 */
async function lastToolResult(session: DurableSession): Promise<string> {
  const conversation = (await session.harness.conversation(ROOT, BG))!
  const results = (await allEntries(conversation)).filter((e) => e.kind === 'pi.tool-result')
  return messageText(results.at(-1)?.model?.[0])
}

/** 一个看得见 signal 落下的 stalled */
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

/** 全部对话数 */
async function conversationCount(session: DurableSession): Promise<number> {
  return session.harness.commit(
    async (tx) => (await tx.scanConversations({}, 256)).items.length,
    BG
  )
}

/** askOp 那次调用的任务（根里，callId `call-askOp`） */
function askTask(session: DurableSession): Promise<TaskId> {
  return dispatchTask(session, 'call-askOp')
}

describe('P2-08 C · reviewer dispatch (decide)', () => {
  it('P2-08-22 the owner is the asking tool task: one reviewer owned by it, no anchor; the record; verdict:allow; the tool task completes', async () => {
    const rig = await hookRig()
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('root done')],
      reviewer: [next('allow')]
    })
    expect(await rig.session.submitUser('clean the build directory')).toEqual({})
    const task = await askTask(rig.session)
    const owned = await reviewerOf(rig.session, task)
    expect(owned).toHaveLength(1)
    const R = owned[0]!
    const record = await rig.session.harness.commit((tx) => tx.conversation(R), BG)
    expect(record?.owner).toEqual({ conversationId: ROOT, taskId: task })
    expect(await anchors(rig.session)).toEqual([])
    expect(await spawnedAgentRecordOf(rig.session.harness, R, BG)).toMatchObject({
      dispatch: 'hook',
      hook: 'auto-review',
      ownerTaskId: task,
      parentConversationId: ROOT,
      profileName: 'permission-reviewer',
      thinkingLevel: 'low',
      toolNames: ['next'],
      depth: 1,
      canSpawn: false,
      resultContract: { schema: PERMISSION_VERDICT_SCHEMA, sourceLabel: 'auto-review' }
    })
    expect(rig.askCalls).toEqual([{ sessionId: 's1', taskId: task, result: 'verdict:allow' }])
    expect(await lastToolResult(rig.session)).toContain('verdict:allow')
    expect((await taskRecord(rig.session, task))?.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'completed' }
    })
    expect(await liveTasks(rig.session)).toEqual([])
  })

  it('P2-08-23 a review asked from a spawned child: owned by the child tool task (parent = child, depth 1); root abort while held → aborted natively, decide null, everything terminal', async () => {
    const rig = await hookRig({ dispatchProfiles: { asker: ASKER } })
    const review = held(next('allow'))
    queueRoles(rig.kit, {
      root: [callAgent('asker', 'go'), callTool('askOp')],
      reviewer: [review.step]
    })
    const sent = rig.session.submitUser('delegate it')
    await review.reached
    // 子 agent 的对话：根的派发工具任务拥有的那条
    const dispatchId = await dispatchTask(rig.session)
    const [C] = await reviewerOf(rig.session, dispatchId)
    const childAsk = await dispatchTask(rig.session, 'call-askOp', C!)
    const [R] = await reviewerOf(rig.session, childAsk)
    expect(await spawnedAgentRecordOf(rig.session.harness, R!, BG)).toMatchObject({
      ownerTaskId: childAsk,
      parentConversationId: C,
      depth: 1,
      dispatch: 'hook'
    })
    await withTimeout(rig.session.abort(), 5000, 'abort')
    expect(await sent).toEqual({})
    await waitFor(() => rig.askCalls.length === 1)
    expect(rig.askCalls[0]!.result).toBe('asked-human')
    await waitFor(async () => (await liveTasks(rig.session)).length === 0)
    expect((await tasksOf(rig.session, R!)).map((task) => task.state)).toEqual([
      { status: 'terminal', outcome: { status: 'aborted' } }
    ])
  })

  it('P2-08-24 no taskId → anchor-owned: a new anchor in the current conversation owns the reviewer; the session never reports busy', async () => {
    const rig = await hookRig()
    const before = rig.t.statesOf('s1')
    queueRoles(rig.kit, { reviewer: [next('deny')] })
    expect(await rig.decide()).toEqual({ result: verdict('deny'), hook: 'auto-review' })
    const [anchor] = await anchors(rig.session)
    expect(anchor?.background).toBe(true)
    expect(anchor?.conversationId).toBe(ROOT)
    const [R] = await reviewerOf(rig.session, anchor!.id)
    expect((await spawnedAgentRecordOf(rig.session.harness, R!, BG))?.ownerTaskId).toBe(anchor!.id)
    await waitFor(async () => (await liveTasks(rig.session)).length === 0)
    expect(rig.t.statesOf('s1')).toEqual(before)
  })

  it('P2-08-25 Q16 keys across sessions: s1 and s2 ask from the same task id at once; each reviewer lives in its own storage; allow in s1, deny in s2', async () => {
    const rig = await hookRig()
    const s2 = await rig.open('s2')
    const gate = deferred()
    let reached = 0
    // 审查员按 payload 里的会话 id 交卷（两个同时在跑）；两个都到了才放行
    const reviewer: FauxResponseStep = async (context) => {
      reached++
      await gate.promise
      const text = context.messages.map((m) => messageText(m as never)).join('\n')
      return text.includes('sessionId: s2') ? next('deny') : next('allow')
    }
    queueRoles(rig.kit, {
      root: [callTool('askOp'), callTool('askOp'), answer('done'), answer('done')],
      reviewer: [reviewer, reviewer]
    })
    const sent1 = rig.session.submitUser('go')
    const sent2 = s2.submitUser('go')
    await waitFor(() => reached === 2)
    gate.resolve()
    expect(await sent1).toEqual({})
    expect(await sent2).toEqual({})
    const t1 = await askTask(rig.session)
    const t2 = await askTask(s2)
    expect(t1).toBe(t2)
    const [R1] = await reviewerOf(rig.session, t1)
    const [R2] = await reviewerOf(s2, t2)
    const r1 = await spawnedAgentRecordOf(rig.session.harness, R1!, BG)
    const r2 = await spawnedAgentRecordOf(s2.harness, R2!, BG)
    expect(r1!.agentId).not.toBe(r2!.agentId)
    // 各自的存储里只有自己的那一个审查员
    const reviewersIn = async (session: DurableSession): Promise<string[]> => {
      const ids = await session.harness.commit(
        async (tx) => (await tx.scanConversations({}, 256)).items.map((c) => c.id),
        BG
      )
      const found: string[] = []
      for (const id of ids) {
        const state = await session.harness.snapshot(AgentStateDoc, id, BG)
        if (state?.dispatch === 'hook') found.push(String(state.agentId))
      }
      return found
    }
    expect(await reviewersIn(rig.session)).toEqual([r1!.agentId])
    expect(await reviewersIn(s2)).toEqual([r2!.agentId])
    expect(rig.askCalls.map((call) => [call.sessionId, call.result]).sort()).toEqual([
      ['s1', 'verdict:allow'],
      ['s2', 'verdict:deny']
    ])
  })

  it('P2-08-26 one fresh conversation per decide run: one task asking twice → two reviewers it owns; two matching hooks → two reviewers (auto-review, strict); all requestIds distinct', async () => {
    const STRICT = { ...REVIEW_HOOK, name: 'strict', displayName: 'Strict' }
    const askTwice = (sessionId: string, rig: () => HookRig): ToolRegistration[] => [
      defineTool({
        name: 'askTwice',
        description: 'askTwice: a read gate, then a write gate',
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
          const opts = { signal: context.abortSignal!, ownerTaskId: api.taskId }
          const read = await rig().runner.decide(
            'permission.request',
            permissionPayload({ sessionId }),
            opts
          )
          const write = await rig().runner.decide(
            'permission.request',
            permissionPayload({ sessionId }),
            opts
          )
          return { content: [{ type: 'text', text: `${read?.hook}/${write?.hook}` }] }
        }
      })
    ]
    const rig = await hookRig({ tools: askTwice, config: rigConfig({}, ['askTwice']) })
    queueRoles(rig.kit, {
      root: [callTool('askTwice'), answer('done')],
      reviewer: [next('allow'), next('allow')]
    })
    expect(await rig.session.submitUser('go')).toEqual({})
    const task = await dispatchTask(rig.session, 'call-askTwice')
    const owned = await reviewerOf(rig.session, task)
    expect(owned).toHaveLength(2)
    for (const id of owned) expect(await userCount(rig.session, id)).toBe(1)

    // 两份判定型 hook 同时命中
    const both = await hookRig({ hooks: [REVIEW_HOOK, STRICT] })
    queueRoles(both.kit, {
      root: [callTool('askOp'), answer('done')],
      reviewer: [next('allow'), next('allow')]
    })
    expect(await both.session.submitUser('go')).toEqual({})
    const askId = await askTask(both.session)
    const reviewers = await reviewerOf(both.session, askId)
    expect(reviewers).toHaveLength(2)
    const hooks = await Promise.all(
      reviewers.map(async (id) => (await spawnedAgentRecordOf(both.session.harness, id, BG))!.hook)
    )
    expect(hooks.sort()).toEqual(['auto-review', 'strict'])
    // requestId = hook:<runId>，每次 run 一个
    const runIds = both.starts().map((start) => start.run.runId)
    expect(new Set(runIds).size).toBe(2)
    let matched = 0
    for (const id of reviewers) {
      for (const runId of runIds) {
        if ((await submissionByRequest(both.session, id, `hook:${runId}`)) !== undefined) matched++
      }
    }
    expect(matched).toBe(2)
  })

  it('P2-08-27 a decide timeout aborts the reviewer conversation: null at ~50 ms, asked-human; the generation aborted (faux saw it); the tool task completes; root finishes', async () => {
    const rig = await hookRig({ decideTimeoutMs: 50 })
    const stall = watchedStall()
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('root done')],
      reviewer: [stall.step]
    })
    const started = Date.now()
    const sent = rig.session.submitUser('go')
    await stall.reached
    expect(await withTimeout(sent, 2000, 'root send')).toEqual({})
    expect(rig.askCalls[0]!.result).toBe('asked-human')
    expect(Date.now() - started).toBeLessThan(2000)
    const task = await askTask(rig.session)
    const [R] = await reviewerOf(rig.session, task)
    await waitFor(async () => (await liveTasks(rig.session)).length === 0)
    expect(stall.abortedSeen()).toBe(true)
    expect((await tasksOf(rig.session, R!)).map((t) => t.state)).toEqual([
      { status: 'terminal', outcome: { status: 'aborted' } }
    ])
    const runId = rig.starts()[0]!.run.runId
    const submission = await submissionByRequest(rig.session, R!, `hook:${runId}`)
    expect(submission).toMatchObject({ status: 'unanswered', reason: 'aborted' })
    expect((await taskRecord(rig.session, task))?.state).toMatchObject({
      status: 'terminal',
      outcome: { status: 'completed' }
    })
    expect(rig.ends()[0]).toMatchObject({ ok: false, error: 'timed out after 50ms' })
    await waitFor(() => rig.runner.runningCount() === 0)
  })

  it('P2-08-27 / PIN-13 a dead owner (abort-marked task): the create commit is refused, nothing is created, decide null', async () => {
    const rig = await hookRig()
    const session = rig.session
    const gateName = `p2-08-27-${Math.random()}`
    const owner = await session.harness.commit(
      (tx) =>
        tx.createTask(
          HoldTask,
          { gate: gateName },
          { ownership: { kind: 'conversation' }, conversationId: ROOT }
        ),
      BG
    )
    await session.harness.abortTask(owner, BG)
    const conversations = await conversationCount(session)
    expect(await rig.decide(permissionPayload(), { ownerTaskId: owner })).toBeNull()
    expect(await conversationCount(session)).toBe(conversations)
    expect(await anchors(session)).toEqual([])
    expect(rig.kit.callCount).toBe(0)
    expect(rig.ends()).toEqual([expect.objectContaining({ ok: false })])
    expect(rig.warns().some((line) => /run=hkr-\S+ failed: /.test(line))).toBe(true)
    holdGate(gateName).resolve()
  })

  it('P2-08-28 an outer signal aborts the reviewer conversation: null within 500 ms; the reviewer aborted; the root run continues and completes', async () => {
    const controller = new AbortController()
    const rig = await hookRig({ askSignal: () => controller.signal })
    const review = held(next('allow'))
    queueRoles(rig.kit, {
      root: [callTool('askOp'), answer('root done')],
      reviewer: [review.step]
    })
    const sent = rig.session.submitUser('go')
    await review.reached
    const aborted = Date.now()
    controller.abort()
    await waitFor(() => rig.askCalls.length === 1, 500)
    expect(Date.now() - aborted).toBeLessThan(500)
    expect(rig.askCalls[0]!.result).toBe('asked-human')
    expect(await withTimeout(sent, 3000, 'root send')).toEqual({})
    const [R] = await reviewerOf(rig.session, await askTask(rig.session))
    await waitFor(async () => (await liveTasks(rig.session)).length === 0)
    expect((await tasksOf(rig.session, R!)).map((t) => t.state)).toEqual([
      { status: 'terminal', outcome: { status: 'aborted' } }
    ])
  })

  it(
    'P2-08-29 crash during review, unsafe tool: R marked at open, the session interrupted; continue() settles the tool as interrupted and R ends aborted without a request',
    async () => {
      const rig = await hookRig()
      const stall = stalled()
      queueRoles(rig.kit, { root: [callTool('askOp')], reviewer: [stall.step] })
      void rig.session.submitUser('go')
      await stall.reached
      const task = await askTask(rig.session)
      const [R] = await reviewerOf(rig.session, task)
      const next2 = await rig.reopen()
      const session = next2.session
      expect((await liveTasks(session, R!)).every((t) => t.abortRequested)).toBe(true)
      expect(session.isInterrupted()).toBe(true)
      queueRoles(next2.kit, { root: [answer('root after')] })
      expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
      const result = await lastToolResult(session)
      expect(result).toMatch(/interrupted/i)
      expect(result).toMatch(/partially/i)
      expect(requestsOfRole(next2.kit, 'reviewer')).toEqual([])
      await waitFor(async () => (await liveTasks(session)).length === 0)
      expect((await tasksOf(session, R!)).map((t) => t.state)).toEqual([
        { status: 'terminal', outcome: { status: 'aborted' } }
      ])
      expect(await reviewerOf(session, task)).toEqual([R])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-08-30 crash during review, safe tool: continue() reruns execute → a second reviewer R2; R1 is never resumed; R2 allows; root completes',
    async () => {
      const rig = await hookRig({ askReplay: 'safe' })
      const stall = stalled()
      queueRoles(rig.kit, { root: [callTool('askOp')], reviewer: [stall.step] })
      void rig.session.submitUser('go')
      await stall.reached
      const task = await askTask(rig.session)
      const [R1] = await reviewerOf(rig.session, task)
      const next2 = await rig.reopen()
      const session = next2.session
      queueRoles(next2.kit, { root: [answer('root after')], reviewer: [next('allow')] })
      expect(await withTimeout(session.continue(), 5000, 'continue')).toEqual({})
      const owned = await reviewerOf(session, task)
      expect(owned).toHaveLength(2)
      expect(owned[0]).toBe(R1)
      const R2 = owned[1]!
      expect((await tasksOf(session, R1!)).map((t) => t.state)).toEqual([
        { status: 'terminal', outcome: { status: 'aborted' } }
      ])
      // R1 的那一轮从没在进程 2 里发过请求：唯一的审查员请求是 R2 的
      expect(requestsOfRole(next2.kit, 'reviewer')).toHaveLength(1)
      expect(await userCount(session, R2)).toBe(1)
      expect(await lastToolResult(session)).toContain('verdict:allow')
      expect(rig.askCalls.at(-1)!.result).toBe('verdict:allow')
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-08-33 denial counters stay per session, in memory: three denials (one from a spawned child) suspend s1 — the fourth ask skips the reviewer and shows the card; s2 unaffected; survives close/reopen; clearReviewState resets; no document gains a field',
    async () => {
      const cards: InputRequest[] = []
      const decides: number[] = []
      /** 经真执行层（executeDecision）的一道 ask 门：审查接缝 = 这条会话的 runner.decide（ownerTaskId = 这次调用的 task） */
      const gated = (sessionId: string, rig: () => HookRig): ToolRegistration[] => [
        defineTool({
          name: 'gatedOp',
          description: 'gatedOp: an operation behind an ask gate',
          parameters: Type.Object({}),
          execute: async (_args, api, context) => {
            const provider: SecurityHostProvider = {
              host: 'desktop',
              pathSep: '/',
              getVars: () => ({}),
              getSessionGrants: () => ({ allowList: [] }),
              // 人把卡片关掉（取消）：不算「人回答了」，连续拒绝计数不清零
              requestUserInput: async (request: InputRequest): Promise<InputResponse> => {
                cards.push(request)
                return { kind: 'cancel', reason: 'aborted' }
              },
              logger: { info: () => {}, warn: () => {}, error: () => {} },
              onPermissionRequest: async (event, signal) => {
                decides.push(api.taskId)
                const decision = await rig().runner.decide(
                  'permission.request',
                  permissionPayload({ sessionId }),
                  { signal, ...(event.taskId === undefined ? {} : { ownerTaskId: event.taskId }) }
                )
                return decision && { verdict: decision.result, source: decision.hook }
              }
            }
            const decision: SecurityDecision = {
              effect: 'ask',
              tier: 'ask',
              matched: ['a1'],
              winning: 'a1',
              ask: { command: 'rm -rf build' }
            }
            try {
              await executeDecision({
                provider,
                request: {
                  subject: { kind: 'agent', sessionId, agentKind: 'root' },
                  action: 'execute',
                  object: { type: 'command', channel: 'bash', command: 'rm -rf build' },
                  environment: { host: 'desktop' }
                },
                decision,
                opts: {
                  toolCallId: api.callId,
                  toolName: 'gatedOp',
                  taskId: api.taskId,
                  conversationId: api.conversationId,
                  ...(context.abortSignal === undefined ? {} : { signal: context.abortSignal })
                },
                evaluateMs: 0
              })
              return { content: [{ type: 'text', text: 'ran' }] }
            } catch (error) {
              return {
                content: [
                  { type: 'text', text: error instanceof Error ? error.message : String(error) }
                ],
                isError: true
              }
            }
          }
        })
      ]
      const gatedAsker = { ...ASKER, name: 'gated', tools: ['gatedOp'] }
      const rig = await hookRig({
        tools: gated,
        config: rigConfig({}, ['gatedOp']),
        dispatchProfiles: { gated: gatedAsker }
      })
      try {
        const stateBefore = await rig.session.harness.snapshot(SessionStateDoc, BG)
        // 三次审查员拒绝：两次根的、一次派生 agent 里的（各是不同的工具任务）
        queueRoles(rig.kit, {
          root: [
            callTool('gatedOp', {}, 'g1'),
            callTool('gatedOp', {}, 'g2'),
            callAgent('gated', 'go', { tool: 'agent' }),
            callTool('gatedOp', {}, 'g3'),
            answer('child done'),
            callTool('gatedOp', {}, 'g4'),
            answer('root done')
          ],
          reviewer: [next('deny'), next('deny'), next('deny')]
        })
        expect(await rig.session.submitUser('go')).toEqual({})
        expect(new Set(decides).size).toBe(3)
        expect(decides).toHaveLength(3)
        // 第四次：审查暂停，不调判定，直接弹卡
        expect(cards).toHaveLength(1)
        expect(reviewSuspended('s1')).toBe(true)
        expect(reviewSuspended('s2')).toBe(false)
        // 关了再开（同一进程）：仍然暂停
        await rig.t.host.close('s1')
        await rig.t.host.open('s1')
        expect(reviewSuspended('s1')).toBe(true)
        // 没有任何文档多出字段
        const reopened = rig.t.host.get('s1')!
        expect(
          Object.keys((await reopened.harness.snapshot(SessionStateDoc, BG)) ?? {}).sort()
        ).toEqual(Object.keys(stateBefore ?? {}).sort())
        for (const id of await reopened.harness.commit(
          async (tx) => (await tx.scanConversations({}, 256)).items.map((c) => c.id),
          BG
        )) {
          const state = await reopened.harness.snapshot(AgentStateDoc, id, BG)
          for (const key of Object.keys(state ?? {})) {
            expect(key).not.toMatch(/denial|review/i)
          }
        }
        clearReviewState('s1')
        expect(reviewSuspended('s1')).toBe(false)
      } finally {
        clearReviewState('s1')
        clearSessionDecisions('s1')
      }
    },
    RESTART_TIMEOUT
  )
})
