/**
 * SpawnCoordinator · 结果契约、追问与混批（P2-03，G 段 35–41）：`next` 作附加工具；第一条成功的 `next`
 * 结果即结构化结果（转写里读，持久）；混批看到捕获就中止子对话（PIN-10）；没捕获就以
 * `agent:<taskId>:nudge:<n>` 追问（出错 / 软停止 / 中止不追问）；契约 schema 不合法 → 拒绝（PIN-11）。
 */
import type { ConversationId, EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import {
  buildResultContractNote,
  NEXT_NUDGE_TEXT,
  nextResultOf,
  type ResultContract
} from '../../subagent/nextTool'
import { answer, callTool, callTools, modelError } from './support/faux'
import { registerHostCleanup, TEST_SETTINGS_OVERRIDES } from './support/host'
import {
  callAgent,
  conversationIds,
  dispatchTask,
  firstChild,
  hostD,
  liveTasks,
  requestsOf,
  routed,
  submissionByRequest,
  tasksOf,
  TITLE_SCHEMA,
  type HostD,
  type HostDOptions
} from './support/spawn'
import { holdTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const S = TITLE_SCHEMA
const RECORDED = 'Result recorded — the task is complete. Do not call any more tools.'
const contractOf = (overrides: Partial<ResultContract> = {}): ResultContract => ({
  schema: structuredClone(S),
  ...overrides
})
const NOTE = buildResultContractNote(contractOf())

async function contractHost(
  contract: ResultContract = contractOf(),
  options: HostDOptions = {}
): Promise<HostD> {
  return hostD({ ...options, dispatch: { ...options.dispatch, contract } })
}

async function childEntries(d: HostD, C: ConversationId): Promise<EntryRecord[]> {
  return allEntries((await d.session.harness.conversation(C, BG))!)
}

/** 子 agent 的请求（人设带 explorer） */
const childCount = (d: HostD): number => requestsOf(d.t.kit, 'explorer').length

describe('SpawnCoordinator · result contract', () => {
  it('P2-03-35 next alone: structured result, one child request, the note on the first input', async () => {
    const d = await contractHost()
    d.t.kit.queue(callAgent('explore', 'p'), callTool('next', { title: 'A' }), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome).toMatchObject({
      structured: { title: 'A' },
      result: JSON.stringify({ title: 'A' }, null, 2)
    })
    expect('error' in outcome).toBe(false)
    expect(childCount(d)).toBe(1)
    const C = outcome.conversationId!
    const lines = await transcript((await d.session.harness.conversation(C, BG))!)
    expect(lines[0]).toBe(`pi.user:p\n\n${NOTE}`)
    const record = (await spawnedAgentRecordOf(d.session.harness, C, BG))!
    expect(record.resultContract).toEqual(contractOf())
    expect(record.toolNames.at(-1)).toBe('next')
    const extras = d.t.toolHost.resolveCalls.at(-1)!.extraTools!
    expect(extras.map((tool) => tool.name)).toEqual(['next'])
    expect(extras[0]!.parameters).toMatchObject(S)
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}`)).toMatchObject({
      status: 'done'
    })
  })

  it('P2-03-36 a mixed batch: the coordinator aborts the child once the capture is seen', async () => {
    const d = await contractHost(contractOf(), {
      tools: () => [holdTool('hold', new Promise(() => {}))]
    })
    d.t.kit.queue(
      callAgent('explore', 'p'),
      callTools([
        ['next', { title: 'A' }, 'c1'],
        ['hold', {}, 'c2']
      ]),
      answer('should not be asked'),
      answer('done')
    )
    expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.structured).toEqual({ title: 'A' })
    expect('error' in outcome).toBe(false)
    const C = outcome.conversationId!
    const entries = await childEntries(d, C)
    const hold = entries.find(
      (entry) =>
        entry.kind === 'pi.tool-result' &&
        (entry.model![0] as { toolCallId?: string }).toolCallId === 'c2'
    )!
    expect(JSON.stringify(hold.model)).toContain('Tool hold was aborted')
    expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
      outcome: { status: 'aborted' }
    })
    expect(childCount(d)).toBe(1)
    expect(entries.filter((entry) => nextResultOf(entry) !== undefined)).toHaveLength(1)
  })

  it('P2-03-37 nudge, then capture', async () => {
    const d = await contractHost()
    d.t.kit.queue(
      callAgent('explore', 'p'),
      answer('text'),
      callTool('next', { title: 'B' }),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.structured).toEqual({ title: 'B' })
    const C = outcome.conversationId!
    expect(await transcript((await d.session.harness.conversation(C, BG))!)).toEqual([
      `pi.user:p\n\n${NOTE}`,
      'pi.assistant:text',
      `pi.user:${NEXT_NUDGE_TEXT}`,
      'pi.assistant:[tool:next]',
      `pi.tool-result:${RECORDED}`
    ])
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:1`)).toMatchObject({
      status: 'done'
    })
  })

  it.each([
    ['default (1)', undefined, 2],
    ['nudges 0', 0, 1],
    ['nudges 2', 2, 3]
  ])('P2-03-38 nudge counts: %s', async (_row, nudges, requests) => {
    const d = await contractHost(contractOf(nudges === undefined ? {} : { nudges }))
    const answers = Array.from({ length: requests }, (_, index) => answer(`text${index + 1}`))
    d.t.kit.queue(callAgent('explore', 'p'), ...answers, answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(childCount(d)).toBe(requests)
    const outcome = d.outcomes[0]!
    expect(outcome.result).toBe(`text${requests}`)
    expect('structured' in outcome).toBe(false)
    expect('error' in outcome).toBe(false)
    const C = outcome.conversationId!
    const task = await dispatchTask(d.session)
    for (let n = 1; n < requests; n++) {
      expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:${n}`)).toBeDefined()
    }
    expect(
      await submissionByRequest(d.session, C, `agent:${task}:nudge:${requests}`)
    ).toBeUndefined()
  })

  it('P2-03-39 no nudge after a model error', async () => {
    const d = await contractHost()
    d.t.kit.queue(callAgent('explore', 'p'), modelError('boom'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(childCount(d)).toBe(1)
    expect(d.outcomes[0]!.error).toBe('boom')
    expect('structured' in d.outcomes[0]!).toBe(false)
  })

  it('P2-03-39 no nudge after a soft interrupt: the partial result', async () => {
    const running = deferred()
    const d = await contractHost(contractOf(), {
      tools: () => [holdTool('hold', new Promise(() => {}), { onRun: () => running.resolve() })]
    })
    d.t.kit.queue(callAgent('explore', 'p'), callTool('hold'), answer('done'))
    const sent = d.session.submitUser('go')
    await running.promise
    const C = await firstChild(d.session)
    await d.session.agents.interrupt(C)
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    expect(childCount(d)).toBe(1)
    const outcome = d.outcomes[0]!
    expect('error' in outcome).toBe(false)
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:1`)).toBeUndefined()
  })

  it('P2-03-39 no nudge after root Esc', async () => {
    const running = deferred()
    const d = await contractHost(contractOf(), {
      tools: () => [holdTool('hold', new Promise(() => {}), { onRun: () => running.resolve() })]
    })
    d.t.kit.queue(callAgent('explore', 'p'), callTool('hold'))
    const sent = d.session.submitUser('go')
    await running.promise
    const C = await firstChild(d.session)
    await withTimeout(d.session.abort(), 3000, 'abort')
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    await waitFor(() => d.outcomes.length > 0, 3000, 'outcome')
    expect(d.outcomes[0]!.error).toBe('aborted')
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:1`)).toBeUndefined()
  })

  it('P2-03-40 first capture wins: sequential [next A, next B]', async () => {
    const d = await contractHost(contractOf(), {
      host: { settingsOverrides: { ...TEST_SETTINGS_OVERRIDES, toolExecution: 'sequential' } }
    })
    d.t.kit.queue(
      callAgent('explore', 'p'),
      callTools([
        ['next', { title: 'A' }, 'c1'],
        ['next', { title: 'B' }, 'c2']
      ]),
      answer('done')
    )
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes[0]!.structured).toEqual({ title: 'A' })
  })

  it('P2-03-40 first capture wins: [next {} (invalid), next A]', async () => {
    const d = await contractHost()
    d.t.kit.queue(
      callAgent('explore', 'p'),
      callTools([
        ['next', {}, 'c1'],
        ['next', { title: 'A' }, 'c2']
      ]),
      answer('spare'),
      answer('done')
    )
    expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
    expect(d.outcomes[0]!.structured).toEqual({ title: 'A' })
    expect('error' in d.outcomes[0]!).toBe(false)
  })

  it('P2-03-40 a capture followed by a model error in the same run: the capture wins (ME-15)', async () => {
    // 捕获之后这一轮还会接着跑（混批）：协调器在下一次请求之前就中止了它 —— 后面那个模型错误根本
    // 发不出来；不论哪种次序，结论都是捕获赢、没有 error
    const d = await contractHost()
    const child = `p\n\n${NOTE}`
    const step = routed({
      go: [callAgent('explore', 'p'), answer('done')],
      [child]: [
        callTools([
          ['next', { title: 'A' }, 'c1'],
          ['probe', {}, 'c2']
        ]),
        modelError('late boom')
      ]
    })
    d.t.kit.queue(step, step, step, step)
    expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
    expect(d.outcomes[0]!.structured).toEqual({ title: 'A' })
    expect('error' in d.outcomes[0]!).toBe(false)
  })

  it('P2-03-41 an invalid contract schema rejects the spawn; nothing is resolved or created', async () => {
    const d = await contractHost({ schema: { type: 'string' } })
    d.t.kit.queue(callAgent('explore', 'p'), answer('done'))
    expect(await d.session.submitUser('go')).toEqual({})
    expect(d.outcomes).toEqual([])
    const lines = await transcript(await d.session.currentConversation())
    expect(lines.find((line) => line.startsWith('pi.tool-result:'))).toMatch(
      /invalid result contract/
    )
    expect(d.t.toolHost.resolveCalls.filter((call) => call.kind === 'spawned')).toEqual([])
    expect(await conversationIds(d.session)).toHaveLength(1)
    expect(await liveTasks(d.session)).toEqual([])
  })
})
