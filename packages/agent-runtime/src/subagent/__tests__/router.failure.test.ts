/**
 * 派生 agent 路由 · 失败、中止与结果契约（P2-05 F 段，41–45；managerTurnFailure / managerResultContract 的移植，
 * 跑在真 durable 上）：isError、任务落定态、outcome.error 是同一个结论；捕获 > 中止 > 软停止（PIN-05）；
 * 每一轮各判各的；结果契约的契约段、捕获、追问次数。
 */
import { fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../durable/context'
import {
  answer,
  assistantWith,
  callTool,
  callTools,
  modelError,
  stalled
} from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import {
  callAgent,
  dispatchTask,
  firstChild,
  queueRouted,
  requestsOf,
  submissionByRequest,
  TITLE_SCHEMA
} from '../../durable/__tests__/support/spawn'
import { holdTool } from '../../durable/__tests__/support/tools'
import { transcript } from '../../durable/__tests__/support/transcript'
import { deferred, sleep, waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import {
  ABORTED_NOTE,
  contractTool,
  createdInfo,
  fakeScope,
  fakeSession,
  hostR,
  routerKit,
  toolParams,
  type HostR,
  type HostROptions
} from '../../durable/__tests__/support/router'
import type { RunTaskOutcome, SubAgentManager } from '../manager'
import { buildResultContractNote, type ResultContract } from '../nextTool'

registerHostCleanup()

const CONTRACT: ResultContract = { schema: structuredClone(TITLE_SCHEMA), sourceLabel: 'test' }
const CAPTURED = JSON.stringify({ title: 'X' }, null, 2)

type Outcomes = (RunTaskOutcome | { rejected: string })[]

function outcomesOf(sink: Outcomes): (router: SubAgentManager) => SubAgentManager {
  return (router) => ({
    ...router,
    runTask: async (params) => {
      const outcome = await router.runTask(params)
      sink.push(outcome)
      return outcome
    }
  })
}

/** 宿主 R + 一个扣住的 `hang` 工具 + 带契约的派发工具；路由交回的结果都进 `outcomes` */
async function failHost(
  options: HostROptions & { contract?: ResultContract } = {}
): Promise<{ r: HostR; outcomes: Outcomes; hanging: Promise<void> }> {
  const outcomes: Outcomes = []
  const hanging = deferred()
  const r = await hostR({
    wrapManager: outcomesOf(outcomes),
    tools: (_sessionId, manager) => [
      holdTool('hang', new Promise(() => {}), { onRun: () => hanging.resolve() }),
      contractTool(manager, { contract: options.contract ?? CONTRACT, outcomes })
    ],
    ...options
  })
  return { r, outcomes, hanging: hanging.promise }
}

const explorerRequests = (r: HostR): number => requestsOf(r.t.kit, 'explorer').length

/** 一次派发、子 agent 以 `child` 收尾、根答 done */
async function dispatchOnce(
  r: HostR,
  child: Parameters<HostR['t']['kit']['queue']>[0]
): Promise<void> {
  r.t.kit.queue(callAgent('explore', 'find X'), child, answer('done'))
  expect(await r.session.submitUser('go')).toEqual({})
  await waitFor(() => r.ends().length > 0, 3000, 'end')
}

function verdict(r: HostR, outcome: RunTaskOutcome): void {
  const [end] = r.ends()
  expect(end!.result).toBe(outcome.result)
  expect(end!.isError).toBe(outcome.error !== undefined)
}

describe('router · first-run failures (managerTurnFailure port, -41)', () => {
  it('ME-1 model error with partial text: error = errorMessage, end isError, same text, task error', async () => {
    const { r, outcomes } = await failHost()
    await dispatchOnce(
      r,
      assistantWith([fauxText('half')], { stopReason: 'error', errorMessage: 'boom' })
    )
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome.error).toBe('boom')
    expect(outcome.result).toBe('half\n\n[Note] stopReason=error; error=boom')
    verdict(r, outcome)
    expect(r.task(r.registers()[0]!.sessionId)?.status).toBe('error')
  })

  it('ME-2 model error with no text: the "no final text" sentence; same failure verdict', async () => {
    const { r, outcomes } = await failHost()
    await dispatchOnce(r, modelError('boom'))
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome.result.startsWith('Agent did not produce a final text response (')).toBe(true)
    expect(outcome.error).toBe('boom')
    verdict(r, outcome)
    expect(r.task(r.registers()[0]!.sessionId)?.status).toBe('error')
  })

  it('ME bare error (no errorMessage): error is the generic reason', async () => {
    const { r, outcomes } = await failHost()
    await dispatchOnce(r, assistantWith([], { stopReason: 'error' }))
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome.error).toBe('model call failed (stopReason=error)')
    verdict(r, outcome)
  })

  it('ME-20 a failing first run delivers no notice (the waiter is attached), even with a formatter', async () => {
    const { r } = await failHost({
      wrapTasks: (tasks) => ({
        ...tasks,
        create: (params) => tasks.create({ ...params, formatNotice: () => 'NOTICE' })
      })
    })
    await dispatchOnce(r, modelError('boom'))
    await sleep(20)
    expect(r.delivered).toEqual([])
  })

  it('ME-24 a router without tasks: the same isError and outcome.error', async () => {
    const { r, outcomes } = await failHost({ tasks: false })
    await dispatchOnce(r, modelError('boom'))
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome.error).toBe('boom')
    expect(r.ends()[0]!.isError).toBe(true)
    expect(r.tasks).toBeUndefined()
  })
})

describe('router · result contract with failure (-42)', () => {
  it('ME-15 capture in a mixed batch: the child is stopped before its next request; structured wins', async () => {
    const { r, outcomes } = await failHost()
    const childPrompt = `title it\n\n${buildResultContractNote(CONTRACT)}`
    queueRouted(r.t.kit, {
      go: [callTool('contract_agent', { prompt: 'title it' }), answer('done')],
      [childPrompt]: [
        callTools([
          ['next', { title: 'X' }, 'call-next'],
          ['probe', {}, 'call-probe']
        ]),
        modelError('boom')
      ]
    })
    expect(await withTimeout(r.session.submitUser('go'), 5000, 'root')).toEqual({})
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome).toEqual(
      expect.objectContaining({ structured: { title: 'X' }, result: CAPTURED })
    )
    expect('error' in outcome).toBe(false)
    expect(r.ends()[0]).toMatchObject({ isError: false, result: CAPTURED })
    expect(r.task(r.registers()[0]!.sessionId)?.status).toBe('done')
    expect(explorerRequests(r)).toBe(1)
  })

  it('ME-16 the first run answers prose, the nudge run errors: error, no structured, end isError', async () => {
    const { r, outcomes } = await failHost()
    r.t.kit.queue(
      callTool('contract_agent', { prompt: 'title it' }),
      answer('prose'),
      modelError('boom'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome.error).toBe('boom')
    expect('structured' in outcome).toBe(false)
    expect(r.ends()[0]).toMatchObject({ isError: true, result: outcome.result })
  })

  it('ME-17 capture beats abort (FC): structured with the tool signal aborted → done, no error', async () => {
    const controller = new AbortController()
    const fc = fakeSession({
      spawn: async (params) => {
        params.onCreated?.(createdInfo())
        controller.abort()
        return {
          result: CAPTURED,
          structured: { title: 'X' },
          error: 'aborted',
          conversationId: 2 as never,
          agentId: 'sub-a1'
        }
      }
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    const outcome = await kit.router.runTask(
      toolParams({
        owner: { tool: fakeScope({ signal: controller.signal }) },
        resultContract: CONTRACT
      })
    )
    expect(outcome).toEqual({
      result: CAPTURED,
      structured: { title: 'X' },
      conversationId: 2,
      agentId: 'sub-a1'
    })
    expect(kit.task('sub-a1')?.status).toBe('done')
    expect(kit.ends()[0]).toMatchObject({ isError: false, result: CAPTURED })
  })

  it('ME-17 capture, then root Esc before the tool returns (real durable): structured, no error, task done', async () => {
    const { r, outcomes, hanging } = await failHost()
    r.t.kit.queue(
      callTool('contract_agent', { prompt: 'title it' }),
      callTools([
        ['next', { title: 'X' }, 'call-next'],
        ['hang', {}, 'call-hang']
      ])
    )
    const sent = r.session.submitUser('go')
    await hanging
    const C = await firstChild(r.session)
    await waitFor(
      async () =>
        (await transcript((await r.session.harness.conversation(C, BG))!)).some((line) =>
          line.startsWith('pi.tool-result:')
        ),
      3000,
      'the next result'
    )
    await withTimeout(r.session.abort(), 3000, 'abort')
    await withTimeout(sent, 3000, 'root')
    await waitFor(() => outcomes.length > 0, 3000, 'outcome')
    const outcome = outcomes[0] as RunTaskOutcome
    expect(outcome.structured).toEqual({ title: 'X' })
    expect('error' in outcome).toBe(false)
    expect(r.task(r.registers()[0]!.sessionId)?.status).toBe('done')
  })

  it('ME-18 the first run errors: one child request, no nudge submission', async () => {
    const { r, outcomes } = await failHost()
    r.t.kit.queue(
      callTool('contract_agent', { prompt: 'title it' }),
      modelError('boom'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    expect((outcomes[0] as RunTaskOutcome).error).toBe('boom')
    expect(explorerRequests(r)).toBe(1)
    const C = await firstChild(r.session)
    const task = await dispatchTask(r.session, 'call-contract_agent')
    expect(await submissionByRequest(r.session, C, `agent:${task}:nudge:1`)).toBeUndefined()
  })
})

describe('router · abort beats soft (-43, ME-25)', () => {
  it('interrupt then root abort with no await between: killed, isError, the soft text kept, error aborted', async () => {
    const { r, outcomes, hanging } = await failHost()
    r.t.kit.queue(
      callAgent('explore', 'find X'),
      assistantWith([fauxText('working on it'), fauxToolCall('hang', {}, { id: 'call-hang' })], {
        stopReason: 'toolUse'
      })
    )
    const sent = r.session.submitUser('go')
    await hanging
    const A = r.registers()[0]!.sessionId
    const interrupted = r.router.interrupt(A)
    const abortedRoot = r.session.abort()
    await withTimeout(Promise.all([interrupted, abortedRoot]), 3000, 'interrupt + abort')
    await withTimeout(sent, 3000, 'root')
    await waitFor(() => r.ends().length > 0 && outcomes.length > 0, 3000, 'end')
    expect(r.task(A)?.status).toBe('killed')
    expect(r.ends()[0]).toMatchObject({
      isError: true,
      result: 'working on it\n\n[Note] stopReason=toolUse'
    })
    expect((outcomes[0] as RunTaskOutcome).error).toBe('aborted')
  })

  it('without the soft flag the aborted text is the note (control)', async () => {
    const { r } = await failHost()
    const stall = stalled()
    r.t.kit.queue(callAgent('explore', 'find X'), stall.step)
    const sent = r.session.submitUser('go')
    await stall.reached
    await withTimeout(r.session.abort(), 3000, 'abort')
    await withTimeout(sent, 3000, 'root')
    await waitFor(() => r.ends().length > 0, 3000, 'end')
    expect(r.ends()[0]).toMatchObject({ isError: true, result: ABORTED_NOTE })
  })
})

describe('router · each round is judged on its own (-44, ME-19/21/23)', () => {
  it('answer → continue model error → continue interrupt → continue answer', async () => {
    const { r, hanging } = await failHost()
    await dispatchOnce(r, answer('found'))
    const A = r.registers()[0]!.sessionId
    r.t.kit.queue(modelError('boom'))
    await withTimeout(r.router.continueTask({ subSessionId: A, text: 'two' }), 3000, 'two')
    r.t.kit.queue(
      assistantWith([fauxText('three partial'), fauxToolCall('hang', {}, { id: 'call-hang' })], {
        stopReason: 'toolUse'
      })
    )
    const third = r.router.continueTask({ subSessionId: A, text: 'three' })
    await hanging
    await withTimeout(r.router.interrupt(A), 3000, 'interrupt')
    await withTimeout(third, 3000, 'three')
    r.t.kit.queue(answer('four ok'))
    await withTimeout(r.router.continueTask({ subSessionId: A, text: 'four' }), 3000, 'four')
    const settled = r.statuses(A).filter((status) => status !== 'running')
    expect(settled).toEqual(['done', 'error', 'done', 'done'])
    expect(r.ends().map((end) => end.isError)).toEqual([false, true, false, false])
    for (const end of r.ends()) expect([end.sessionId, end.parentSessionId]).toEqual([A, 's1'])
    await sleep(20)
    expect(r.delivered).toEqual([])
  })

  it('ME-21 tripwire: with a formatter, the failing continue (nobody waits) does deliver', async () => {
    const { r } = await failHost({
      wrapTasks: (tasks) => ({
        ...tasks,
        create: (params) => tasks.create({ ...params, formatNotice: () => 'NOTICE' })
      })
    })
    await dispatchOnce(r, answer('found'))
    await sleep(20)
    expect(r.delivered).toEqual([])
    const A = r.registers()[0]!.sessionId
    r.t.kit.queue(modelError('boom'))
    await withTimeout(r.router.continueTask({ subSessionId: A, text: 'two' }), 3000, 'two')
    await waitFor(() => r.delivered.length > 0, 3000, 'notice')
    expect(r.delivered).toEqual([['s1', 'NOTICE']])
  })
})

describe('router · result contract (managerResultContract port, -45)', () => {
  it('the child gets prompt + contract note; the register keeps the bare prompt; capture → JSON text', async () => {
    const { r, outcomes } = await failHost()
    r.t.kit.queue(
      callTool('contract_agent', { prompt: 'p' }),
      callTool('next', { title: 'X' }, 'call-next'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    const C = await firstChild(r.session)
    const users = (await transcript((await r.session.harness.conversation(C, BG))!)).filter(
      (line) => line.startsWith('pi.user:')
    )
    expect(users[0]).toBe(`pi.user:p\n\n${buildResultContractNote(CONTRACT)}`)
    expect(r.registers()[0]!.prompt).toBe('p')
    expect(outcomes[0]).toEqual(
      expect.objectContaining({ structured: { title: 'X' }, result: CAPTURED })
    )
    expect(r.ends()[0]).toMatchObject({ result: CAPTURED, isError: false })
  })

  it('an invalid schema rejects /invalid result contract/ with no events or task', async () => {
    const { r, outcomes } = await failHost({
      contract: { schema: { type: 'string' }, sourceLabel: 'bad' }
    })
    r.t.kit.queue(callTool('contract_agent', { prompt: 'p' }), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    expect(outcomes).toEqual([{ rejected: expect.stringMatching(/invalid result contract/) }])
    expect(r.events).toEqual([])
    expect(r.taskBroadcasts).toEqual([])
  })

  it.each([
    [undefined, 2],
    [0, 1],
    [2, 3]
  ] as const)('nudges %s → %i child requests; never a user_message event', async (nudges, n) => {
    const contract = nudges === undefined ? CONTRACT : { ...CONTRACT, nudges }
    const { r, outcomes } = await failHost({ contract })
    r.t.kit.queue(callTool('contract_agent', { prompt: 'p' }))
    for (let index = 0; index < n; index++) r.t.kit.queue(answer(`prose ${index}`))
    r.t.kit.queue(answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    expect(explorerRequests(r)).toBe(n)
    expect(r.userMessages()).toEqual([])
    expect('structured' in (outcomes[0] as RunTaskOutcome)).toBe(false)
  })

  it.each(['errorMessage', 'bare', 'Esc', 'clean', 'capture'] as const)(
    'outcome.error row: %s',
    async (row) => {
      const { r, outcomes } = await failHost()
      const stall = stalled()
      if (row === 'Esc') {
        r.t.kit.queue(callTool('contract_agent', { prompt: 'p' }), stall.step)
        const sent = r.session.submitUser('go')
        await stall.reached
        await withTimeout(r.session.abort(), 3000, 'abort')
        await withTimeout(sent, 3000, 'root')
        await waitFor(() => outcomes.length > 0, 3000, 'outcome')
      } else {
        const child = {
          errorMessage: modelError('boom'),
          bare: assistantWith([], { stopReason: 'error' }),
          clean: answer('prose'),
          capture: callTool('next', { title: 'X' }, 'call-next')
        }[row]
        r.t.kit.queue(callTool('contract_agent', { prompt: 'p' }), child)
        if (row === 'clean') r.t.kit.queue(answer('still prose'))
        r.t.kit.queue(answer('done'))
        expect(await r.session.submitUser('go')).toEqual({})
      }
      const outcome = outcomes[0] as RunTaskOutcome
      const expected = {
        errorMessage: 'boom',
        bare: 'model call failed (stopReason=error)',
        Esc: 'aborted',
        clean: undefined,
        capture: undefined
      }[row]
      if (expected === undefined) expect('error' in outcome).toBe(false)
      else expect(outcome.error).toBe(expected)
    }
  )
})
