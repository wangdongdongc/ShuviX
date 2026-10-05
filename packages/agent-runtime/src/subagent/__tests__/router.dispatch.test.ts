/**
 * 派生 agent 路由 · 真派发工具（P2-05 B 段，10–20；08 / 09 / 15 的单元版在 dispatchTool.test.ts）：调用方现取自
 * `api`；模型看到的文本（PIN-04）；Esc 与面板销毁（PIN-05）；replay safe 的重跑重新挂上（SQLite，PIN-10）。
 */
import { ROOT_CONVERSATION_ID, type ConversationId } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../durable/context'
import { spawnedAgentRecordOf } from '../../durable/agentRecord'
import type { DurableSession } from '../../durable/durableSession'
import { answer, callTool, modelError, stalled } from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import { piAgent } from '../../durable/__tests__/support/scenario'
import {
  callAgent,
  childOf,
  conversationIds,
  dispatchTask,
  firstChild,
  requestsWith,
  submissionByRequest,
  taskRecord
} from '../../durable/__tests__/support/spawn'
import { allEntries, transcript } from '../../durable/__tests__/support/transcript'
import { aborted, deferred, waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import { ABORTED_NOTE, CALL, hostR, type HostR } from '../../durable/__tests__/support/router'
import type { RunTaskOutcome, RunTaskParams, SubAgentManager } from '../manager'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

const depthText = (max: number, depth: number): string =>
  `Agent depth limit reached (max ${max}): this agent is already at depth ${depth} and cannot spawn further agents. Complete the task directly instead.`

interface ToolResultView {
  callId: string
  text: string
  isError: boolean | undefined
  details: unknown
  content: unknown
}

/** 某对话里的工具结果（按次序） */
async function toolResults(
  session: DurableSession,
  conversationId: ConversationId = ROOT_CONVERSATION_ID
): Promise<ToolResultView[]> {
  const entries = await allEntries((await session.harness.conversation(conversationId, BG))!)
  return entries
    .filter((entry) => entry.kind === 'pi.tool-result')
    .map((entry) => {
      const message = entry.model![0] as {
        toolCallId: string
        content: { type: string; text?: string }[]
        isError?: boolean
        details?: unknown
      }
      return {
        callId: message.toolCallId,
        text: message.content.map((part) => part.text ?? '').join(''),
        isError: message.isError,
        details: message.details,
        content: message.content
      }
    })
}

/** 记下路由交回派发工具的每个结果 */
function outcomesOf(sink: RunTaskOutcome[]): (router: SubAgentManager) => SubAgentManager {
  return (router) => ({
    ...router,
    runTask: async (params) => {
      const outcome = await router.runTask(params)
      sink.push(outcome)
      return outcome
    }
  })
}

const force = (prompt: string, id = 'call-force'): ReturnType<typeof callTool> =>
  callTool('force_agent', { name: 'explore', prompt, description: 'deep' }, id)

async function rootLast(r: HostR): Promise<string | undefined> {
  return (await transcript(await r.session.currentConversation())).at(-1)
}

describe('router · the dispatch tool on real durable', () => {
  it('P2-05-10 the live caller model: setThinkingLevel(high) on root reaches the child', async () => {
    const r = await hostR()
    await r.session.setThinkingLevel('high')
    r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const C = await firstChild(r.session)
    expect(await piAgent(r.session, C)).toMatchObject({ thinkingLevel: 'high' })
    expect(await spawnedAgentRecordOf(r.session.harness, C, BG)).toMatchObject({
      thinkingLevel: 'high'
    })
  })

  it('P2-05-11 depth error text (max 1): Error: prefix, no isError, nothing registered for it', async () => {
    const r = await hostR({ host: { maxAgentDepth: 1 } })
    r.t.kit.queue(callAgent('nester', 'mid'), force('deep'), answer('mid done'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const C = await firstChild(r.session)
    const [forced] = (await toolResults(r.session, C)).filter((t) => t.callId === 'call-force')
    expect(forced!.text).toBe(`Error: ${depthText(1, 1)}`)
    expect(forced!.isError).toBeFalsy()
    expect(r.registers()).toHaveLength(1)
    expect(r.ends()).toHaveLength(1)
    const A = r.registers()[0]!.sessionId
    expect(new Set(r.taskBroadcasts.map((task) => task.taskId))).toEqual(new Set([A]))
  })

  it('P2-05-11 depth error text (default max 2): G at depth 2 gets the (max 2) text verbatim', async () => {
    const r = await hostR()
    r.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('nester', 'leaf', { id: 'call-g' }),
      force('deep'),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    const C = await firstChild(r.session)
    const G = await firstChild(r.session, C)
    const [forced] = (await toolResults(r.session, G)).filter((t) => t.callId === 'call-force')
    expect(forced!.text).toBe(`Error: ${depthText(2, 2)}`)
    expect(forced!.isError).toBeFalsy()
    expect(r.registers()).toHaveLength(2)
    expect(r.ends()).toHaveLength(2)
  })

  it.each([
    ['the resolve fails', 'boom'],
    ['promptVars fail', 'vars']
  ] as const)(
    'P2-05-12 failures before the child exists (%s): Error: + outcome.error; silent; root ends done',
    async (row, needle) => {
      const outcomes: RunTaskOutcome[] = []
      const r = await hostR({ wrapManager: outcomesOf(outcomes) })
      if (row === 'the resolve fails') r.t.toolHost.failResolve = new Error('boom')
      else r.vars.state.fail = 'vars exploded'
      r.t.kit.queue(callAgent('explore', 'find X'), answer('done'))
      expect(await r.session.submitUser('go')).toEqual({})
      const [result] = await toolResults(r.session)
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.conversationId).toBeUndefined()
      expect(result!.text).toBe(`Error: ${outcomes[0]!.error}`)
      expect(result!.text).toContain(needle)
      expect(result!.isError).toBeFalsy()
      expect(r.events).toEqual([])
      expect(r.taskBroadcasts).toEqual([])
      expect(await conversationIds(r.session)).toEqual([ROOT_CONVERSATION_ID])
      expect(await rootLast(r)).toBe('pi.assistant:done')
    }
  )

  it('P2-05-13 the happy result shape: text found, no isError, details {conversationId, agentId}', async () => {
    const r = await hostR()
    r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const C = await firstChild(r.session)
    const A = r.registers()[0]!.sessionId
    const [result] = await toolResults(r.session)
    expect(result!.content).toEqual([{ type: 'text', text: 'found' }])
    expect(result!.isError).toBeFalsy()
    expect(result!.details).toEqual({ conversationId: C, agentId: A })
  })

  it('P2-05-14 child model error: the text is outcome.result (no Error: prefix); the dispatch completes', async () => {
    const outcomes: RunTaskOutcome[] = []
    const r = await hostR({ wrapManager: outcomesOf(outcomes) })
    r.t.kit.queue(callAgent('explore', 'find X'), modelError('boom'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const [result] = await toolResults(r.session)
    expect(outcomes[0]!.error).toBe('boom')
    expect(result!.text).toBe(outcomes[0]!.result)
    expect(result!.text.startsWith('Error:')).toBe(false)
    expect(result!.isError).toBeFalsy()
    const task = await taskRecord(r.session, await dispatchTask(r.session))
    expect(task!.state).toMatchObject({ status: 'terminal', outcome: { status: 'completed' } })
    expect(await rootLast(r)).toBe('pi.assistant:done')
  })

  it('P2-05-16 root Esc during the child: the tool rethrows (aborted); end ABORTED_NOTE isError; task killed', async () => {
    const r = await hostR()
    const stall = stalled()
    r.t.kit.queue(callAgent('explore', 'find X'), stall.step)
    const sent = r.session.submitUser('go')
    await stall.reached
    await withTimeout(r.session.abort(), 3000, 'abort')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    await waitFor(() => r.ends().length > 0, 3000, 'end')
    const A = r.registers()[0]!.sessionId
    const task = await taskRecord(r.session, await dispatchTask(r.session))
    expect(task!.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } })
    expect(r.ends()).toEqual([
      {
        type: 'sub_session_end',
        sessionId: A,
        parentSessionId: 's1',
        result: ABORTED_NOTE,
        isError: true
      }
    ])
    expect(r.task(A)?.status).toBe('killed')
  })

  it('P2-05-17 panel destroy during the wait: the root sees ABORTED_NOTE (no throw) and continues (PIN-05)', async () => {
    const r = await hostR()
    const stall = stalled()
    r.t.kit.queue(callAgent('explore', 'find X'), stall.step, answer('done'))
    const sent = r.session.submitUser('go')
    await stall.reached
    const A = r.registers()[0]!.sessionId
    await withTimeout(r.router.destroy(A), 3000, 'destroy')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    const [result] = await toolResults(r.session)
    expect(result!.text).toBe(ABORTED_NOTE)
    expect(result!.isError).toBeFalsy()
    expect(await rootLast(r)).toBe('pi.assistant:done')
    expect(r.ends()).toEqual([
      expect.objectContaining({ sessionId: A, isError: true, result: ABORTED_NOTE })
    ])
    expect(r.task(A)).toBeUndefined()
    expect(r.router.has(A)).toBe(false)
  })
})

describe('router · replay safe: the rerun re-attaches [SQLite]', () => {
  /** 进程 1：根派发、子 agent 卡住不答，然后崩溃；交回进程 2 与身份 */
  async function crashMidChild(
    first: HostR,
    before?: () => void
  ): Promise<{ r2: HostR; A: string; C: ConversationId; submissionId: number }> {
    const stall = stalled()
    first.t.kit.queue(callAgent('explore', 'find X'), stall.step)
    void first.session.submitUser('go')
    await stall.reached
    const A = first.registers()[0]!.sessionId
    const C = await firstChild(first.session)
    const task = await dispatchTask(first.session)
    const submission = (await submissionByRequest(first.session, C, `agent:${task}`))!
    before?.()
    const r2 = await first.reopen()
    return { r2, A, C, submissionId: submission.id }
  }

  const spawnedResolves = (r: HostR): number =>
    r.t.toolHost.resolveCalls.filter((call) => call.kind === 'spawned').length

  async function userLines(r: HostR, C: ConversationId): Promise<string[]> {
    const lines = await transcript((await r.session.harness.conversation(C, BG))!)
    return lines.filter((line) => line.startsWith('pi.user:'))
  }

  it(
    'P2-05-18 the rerun re-attaches: one register in R2 (same A), running → done, one input, text found',
    async () => {
      const first = await hostR()
      const { r2, A, C, submissionId } = await crashMidChild(first)
      r2.t.kit.queue(answer('found'), answer('done'))
      expect(await withTimeout(r2.session.continue(), 5000, 'continue')).toEqual({})
      expect(r2.registers()).toHaveLength(1)
      expect(r2.registers()[0]).toMatchObject({
        sessionId: A,
        parentToolCallId: CALL,
        depth: 1,
        parentSessionId: 's1'
      })
      expect(r2.statuses(A)).toEqual(['running', 'done'])
      expect(r2.ends()).toEqual([expect.objectContaining({ result: 'found', isError: false })])
      expect(r2.router.locate(A)).toEqual({ sessionId: 's1', conversationId: C })
      expect(await userLines(r2, C)).toEqual(['pi.user:find X'])
      const task = await dispatchTask(r2.session)
      expect((await submissionByRequest(r2.session, C, `agent:${task}`))!.id).toBe(submissionId)
      expect(requestsWith(r2.t.kit, 'find X')).toHaveLength(1)
      const [result] = await toolResults(r2.session)
      expect(result!.text).toBe('found')
      expect(spawnedResolves(r2)).toBe(0)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-05-19 rerun after the child settled: no child request; one register and one end; task done',
    async () => {
      const held = deferred()
      const first = await hostR({
        wrapManager: (router) => ({
          ...router,
          runTask: async (params: RunTaskParams) => {
            const outcome = await router.runTask(params)
            const scope = (params.owner as Extract<RunTaskParams['owner'], { tool: unknown }>).tool
            held.resolve()
            await aborted(scope.signal!)
            return outcome
          }
        })
      })
      first.t.kit.queue(callAgent('explore', 'find X'), answer('found'))
      void first.session.submitUser('go')
      await held.promise
      const A = first.registers()[0]!.sessionId
      const r2 = await first.reopen({ wrapManager: undefined })
      r2.t.kit.queue(answer('done'))
      expect(await withTimeout(r2.session.continue(), 5000, 'continue')).toEqual({})
      expect(requestsWith(r2.t.kit, 'find X')).toEqual([])
      const [result] = await toolResults(r2.session)
      expect(result!.text).toBe('found')
      expect(r2.registers()).toEqual([expect.objectContaining({ sessionId: A })])
      expect(r2.ends()).toEqual([expect.objectContaining({ sessionId: A, result: 'found' })])
      expect(r2.task(A)?.status).toBe('done')
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-05-20 the profile is gone on rerun: re-attaches from the memoised agentType (PIN-10)',
    async () => {
      const first = await hostR()
      const { r2, A, C } = await crashMidChild(first, () => first.profiles.delete('explore'))
      expect(r2.profiles.has('explore')).toBe(false)
      r2.t.kit.queue(answer('found'), answer('done'))
      expect(await withTimeout(r2.session.continue(), 5000, 'continue')).toEqual({})
      const [result] = await toolResults(r2.session)
      expect(result!.text).toBe('found')
      expect(result!.text).not.toContain('Unknown agent')
      expect(r2.registers()).toEqual([
        expect.objectContaining({ sessionId: A, subAgentName: 'explore' })
      ])
      expect(await childOf(r2.session, await dispatchTask(r2.session))).toEqual([C])
    },
    RESTART_TIMEOUT
  )
})
