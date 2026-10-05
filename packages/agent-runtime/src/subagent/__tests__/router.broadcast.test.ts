/**
 * 派生 agent 路由 · register / end 广播（P2-05 C 段，21–24；25 在桌面 agentManagerBroadcast.test.ts）：每次 runTask
 * 恰 [register, end]；结果契约的追问不广播（PIN-06）；end 的 result 与交回调用方的文本逐字相同；被拒 / 建不起来的
 * 路径一条事件都没有；面板追问发 [user_message, end]（PIN-07 的内联 Token）。
 */
import { fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { InlineToken } from '@shuvix/chat-protocol/types/chatMessage'
import { resolveTokensForAgent } from '@shuvix/chat-protocol/utils/inlineTokens'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../../durable/context'
import {
  answer,
  assistantWith,
  callTool,
  modelError,
  stalled
} from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import {
  callAgent,
  childOf,
  dispatchTask,
  TITLE_SCHEMA
} from '../../durable/__tests__/support/spawn'
import { holdTool } from '../../durable/__tests__/support/tools'
import { transcript } from '../../durable/__tests__/support/transcript'
import { deferred, waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import {
  ABORTED_NOTE,
  contractTool,
  fakeScope,
  hostR,
  toolParams,
  type HostR
} from '../../durable/__tests__/support/router'
import type { RunTaskOutcome, SubAgentManager } from '../manager'

registerHostCleanup()

const CONTRACT = { schema: structuredClone(TITLE_SCHEMA), sourceLabel: 'test' }

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

type Row = 'done' | 'model error' | 'soft interrupt' | 'Esc' | 'destroy' | 'contract capture'

/** 跑一行：交回宿主与路由交给调用方的那个结果 */
async function runRow(row: Row): Promise<{ r: HostR; outcome: RunTaskOutcome }> {
  const outcomes: (RunTaskOutcome | { rejected: string })[] = []
  const hanging = deferred()
  const r = await hostR({
    wrapManager: outcomesOf(outcomes as RunTaskOutcome[]),
    tools: (_sessionId, manager) => [
      holdTool('hang', new Promise(() => {}), { onRun: () => hanging.resolve() }),
      contractTool(manager, { contract: CONTRACT, outcomes })
    ]
  })
  const stall = stalled()
  switch (row) {
    case 'done':
      r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
      await r.session.submitUser('go')
      break
    case 'model error':
      r.t.kit.queue(callAgent('explore', 'find X'), modelError('boom'), answer('done'))
      await r.session.submitUser('go')
      break
    case 'soft interrupt': {
      r.t.kit.queue(
        callAgent('explore', 'find X'),
        assistantWith([fauxText('working on it'), fauxToolCall('hang', {}, { id: 'call-hang' })], {
          stopReason: 'toolUse'
        }),
        answer('done')
      )
      const sent = r.session.submitUser('go')
      await hanging.promise
      await withTimeout(r.router.interrupt(r.registers()[0]!.sessionId), 3000, 'interrupt')
      await withTimeout(sent, 3000, 'root')
      break
    }
    case 'Esc': {
      r.t.kit.queue(callAgent('explore', 'find X'), stall.step)
      const sent = r.session.submitUser('go')
      await stall.reached
      await withTimeout(r.session.abort(), 3000, 'abort')
      await withTimeout(sent, 3000, 'root')
      break
    }
    case 'destroy': {
      r.t.kit.queue(callAgent('explore', 'find X'), stall.step, answer('done'))
      const sent = r.session.submitUser('go')
      await stall.reached
      await withTimeout(r.router.destroy(r.registers()[0]!.sessionId), 3000, 'destroy')
      await withTimeout(sent, 3000, 'root')
      break
    }
    case 'contract capture':
      r.t.kit.queue(
        callTool('contract_agent', { prompt: 'title it' }),
        callTool('next', { title: 'X' }, 'call-next'),
        answer('done')
      )
      await r.session.submitUser('go')
      break
  }
  await waitFor(() => r.ends().length > 0 && outcomes.length > 0, 3000, 'end and outcome')
  return { r, outcome: outcomes[0] as RunTaskOutcome }
}

describe('router · register and end broadcasts', () => {
  it('P2-05-21 one run emits exactly [register, end]', async () => {
    const { r } = await runRow('done')
    const A = r.registers()[0]!.sessionId
    expect(r.events.map((event) => [event.type, event.sessionId])).toEqual([
      ['sub_session_register', A],
      ['sub_session_end', A]
    ])
  })

  it('P2-05-21 the contract nudge path broadcasts no user_message (PIN-06)', async () => {
    const outcomes: (RunTaskOutcome | { rejected: string })[] = []
    const r = await hostR({
      tools: (_sessionId, manager) => [contractTool(manager, { contract: CONTRACT, outcomes })]
    })
    r.t.kit.queue(
      callTool('contract_agent', { prompt: 'title it' }),
      answer('prose, no next'),
      callTool('next', { title: 'X' }, 'call-next'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    expect(outcomes).toEqual([
      expect.objectContaining({ structured: { title: 'X' }, result: '{\n  "title": "X"\n}' })
    ])
    expect(r.events.map((event) => event.type)).toEqual([
      'sub_session_register',
      'sub_session_end'
    ])
  })

  it.each<[Row, boolean, string | null]>([
    ['done', false, 'found'],
    ['model error', true, null],
    ['soft interrupt', false, 'working on it\n\n[Note] stopReason=toolUse'],
    ['Esc', true, ABORTED_NOTE],
    ['destroy', true, ABORTED_NOTE],
    ['contract capture', false, JSON.stringify({ title: 'X' }, null, 2)]
  ])('P2-05-22 end per outcome: %s → isError %s', async (row, isError, text) => {
    const { r, outcome } = await runRow(row)
    const A = r.registers()[0]!.sessionId
    const [end] = r.ends()
    expect(r.ends()).toHaveLength(1)
    expect(end).toEqual({
      type: 'sub_session_end',
      sessionId: A,
      parentSessionId: 's1',
      result: text ?? outcome.result,
      isError
    })
    expect('error' in end!).toBe(false)
    expect(end!.result).toBe(outcome.result)
    if (row === 'model error') expect(outcome.error).toBe('boom')
  })

  it('P2-05-23 silent paths: depth refusal, pre-creation failure, unknown / missing name', async () => {
    const r = await hostR({ host: { maxAgentDepth: 0 } })
    r.t.kit.queue(callAgent('explore', 'find X'), answer('refused'))
    expect(await r.session.submitUser('go')).toEqual({})
    expect(r.events).toEqual([])

    const failing = await hostR()
    failing.t.toolHost.failResolve = new Error('boom')
    failing.t.kit.queue(
      callAgent('explore', 'find X'),
      callTool('agent', { name: 'nope', prompt: 'p', description: 'd' }, 'call-unknown'),
      callTool('agent', { prompt: 'p', description: 'd' }, 'call-missing'),
      answer('done')
    )
    expect(await failing.session.submitUser('go')).toEqual({})
    const results = (await transcript(await failing.session.currentConversation())).filter(
      (line) => line.startsWith('pi.tool-result:')
    )
    expect(results).toHaveLength(3)
    expect(results[1]).toContain('Unknown agent "nope"')
    expect(results[2]).toContain('Missing "name"')
    expect(failing.events).toEqual([])
    expect(failing.taskBroadcasts).toEqual([])
  })

  it('P2-05-23 an invalid result contract rejects /invalid result contract/ with no events', async () => {
    const r = await hostR()
    const params = toolParams({
      owner: { tool: fakeScope() },
      resultContract: { schema: { type: 'string' }, sourceLabel: 'bad' }
    })
    await expect(r.router.runTask(params)).rejects.toThrow(/invalid result contract/)
    expect(r.events).toEqual([])
    expect(r.taskBroadcasts).toEqual([])
  })
})

describe('router · continue broadcasts', () => {
  async function headline(r: HostR): Promise<{ A: string; C: number }> {
    r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const [C] = await childOf(r.session, await dispatchTask(r.session))
    return { A: r.registers()[0]!.sessionId, C: C! }
  }

  it('P2-05-24 continue emits [user_message, end]; no second register', async () => {
    const r = await hostR()
    const { A } = await headline(r)
    const before = r.events.length
    r.t.kit.queue(answer('more ok'))
    await withTimeout(r.router.continueTask({ subSessionId: A, text: 'more' }), 3000, 'continue')
    const appended = r.events.slice(before)
    expect(appended.map((event) => event.type)).toEqual(['user_message', 'sub_session_end'])
    const message = appended[0] as Extract<(typeof appended)[number], { type: 'user_message' }>
    expect(message.sessionId).toBe(A)
    expect(JSON.parse(message.message)).toMatchObject({
      sessionId: A,
      role: 'user',
      type: 'text',
      content: 'more',
      metadata: null
    })
    expect(appended[1]).toEqual({
      type: 'sub_session_end',
      sessionId: A,
      parentSessionId: 's1',
      result: 'more ok',
      isError: false
    })
    expect(r.registers()).toHaveLength(1)
  })

  it('P2-05-24 inline tokens: metadata carries them; the child gets the resolved text (PIN-07)', async () => {
    const r = await hostR()
    const { A, C } = await headline(r)
    const tokens: Record<string, InlineToken> = {
      abc123: { type: 'at', id: 'f1', displayText: '@notes.md', payload: 'NOTES BODY' }
    }
    const text = 'look at {{shuvixInlineToken:abc123}}'
    r.t.kit.queue(answer('more ok'))
    await withTimeout(
      r.router.continueTask({ subSessionId: A, text, inlineTokens: tokens }),
      3000,
      'continue'
    )
    const [message] = r.userMessages()
    expect(JSON.parse(message!.message)).toMatchObject({
      content: text,
      metadata: { inlineTokens: tokens }
    })
    const lines = await transcript((await r.session.harness.conversation(C as never, BG))!)
    const resolved = resolveTokensForAgent(text, tokens)
    expect(resolved).toBe('look at NOTES BODY')
    expect(lines.filter((line) => line.startsWith('pi.user:')).at(-1)).toBe(`pi.user:${resolved}`)
  })

  it('P2-05-24 a nested G: the continue end names its caller A_C as parent', async () => {
    const r = await hostR()
    r.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('explore', 'leaf', { id: 'call-g' }),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    const [cReg, gReg] = r.registers()
    r.t.kit.queue(answer('more ok'))
    await withTimeout(
      r.router.continueTask({ subSessionId: gReg!.sessionId, text: 'more' }),
      3000,
      'continue'
    )
    expect(r.ends().at(-1)).toEqual({
      type: 'sub_session_end',
      sessionId: gReg!.sessionId,
      parentSessionId: cReg!.sessionId,
      result: 'more ok',
      isError: false
    })
  })
})
