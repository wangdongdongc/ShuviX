/**
 * P2-11 · J3：Esc 级联。根 Esc 原生地中止派发工具任务与它拥有的一切（子对话、审查员、孙子里的 MCP 调用），
 * 但碰不到后台锚拥有的 titler（辅助工作）。中止文本按 PIN-09 取确定的那一份，跑三遍看它不变。
 */
import { describe, expect, it } from 'vitest'
import { answer, callTool, held, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { waitFor, withTimeout } from '../support/wait'
import {
  anchorTasks,
  childOfCall,
  fate,
  liveTasks,
  ownedBy,
  recordOf,
  registerSpawnCleanup,
  resultOf,
  spawnWorld,
  submissionOf,
  tasksIn,
  toolTaskOf,
  type SpawnWorld
} from './support/spawnWorld'
import { harnessErrorText } from './support/entries'
import { nextInput, registerWorldCleanup, resolvedCount } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 20000
const ROUNDS = 3

async function noLiveTasks(sw: SpawnWorld): Promise<void> {
  const session = sw.world.session()
  await waitFor(async () => (await liveTasks(session)).length === 0, 2000, 'no live tasks')
}

/** J3-01 一轮：子 agent 的写挂着卡片、titler 在跑，Esc */
async function escWithCardAndTitler(): Promise<{ cwText: string }> {
  const sw = await spawnWorld()
  const { world } = sw
  const session = await sw.open()
  world.chat(callTool('agent', { name: 'explore', prompt: 'write', description: 'w' }, 'r-agent'))
  world.model.chatIn('explore', callTool('write', { path: 'out.txt', content: 'X' }, 'c-w'))
  const titling = held(callTool('session', { action: 'set-title', title: 'Hooked title' }, 't-s'))
  world.model.chatIn('titler', titling.step, answer('ok'))

  const sending = session.submitUser('go')
  await nextInput(world, 'c-w')
  sw.fireTitle('go')
  await withTimeout(titling.reached, 3000, 'titler request')
  const C = await childOfCall(session, 'r-agent')
  const A = (await recordOf(session, C))!.agentId
  const dispatch = await toolTaskOf(session, 1, 'r-agent')
  const statesBefore = world.t.statesOf('s1').length

  await withTimeout(session.abort(), 2000, 'abort')
  expect(await withTimeout(sending, 2000, 'send settles')).toEqual({})

  // 子 agent 一侧
  expect(resolvedCount(world, 'c-w')).toBe(1)
  expect(session.pendingInputCount).toBe(0)
  const cw = await resultOf(session, C, 'c-w')
  const generations = await tasksIn(session, C, 'pi.generation')
  expect(generations.map(fate)).toEqual(['aborted'])
  const submission = await submissionOf(session, C, `agent:${dispatch.id}`)
  expect(submission).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  await waitFor(
    async () => fate((await toolTaskOf(session, 1, 'r-agent')) as never) === 'aborted',
    2000,
    'dispatch task aborted'
  )
  await waitFor(() => sw.router.ends().length === 1, 2000, 'router end')
  expect(sw.router.ends()).toEqual([
    expect.objectContaining({ sessionId: A, result: 'ABORTED_NOTE', isError: true })
  ])
  expect(sw.router.task(A)?.status).toBe('killed')
  expect(world.fs.writesTo('/ws/out.txt')).toBe(0)

  // titler 一侧：辅助工作，不在 Esc 的范围里
  const [anchor] = await anchorTasks(session)
  expect(anchor).toBeDefined()
  const [T] = await ownedBy(session, anchor!.id)
  for (const task of await tasksIn(session, T!)) expect(task.abortRequested).toBe(false)
  expect(fate(anchor! as never)).not.toBe('aborted')

  titling.release()
  await waitFor(() => sw.ends('auto-title').length === 1, 3000, 'titler end')
  expect(sw.ends('auto-title')[0]).toMatchObject({ ok: true })
  expect(sw.sessionCalls).toEqual([
    expect.objectContaining({ action: 'set-title', title: 'Hooked title', conversationId: T })
  ])
  await noLiveTasks(sw)
  expect(world.t.statesOf('s1').slice(statesBefore)).toEqual(['idle'])
  expect(sw.router.tasks?.runningCount('s1', 'agent')).toBe(0)
  return { cwText: cw.text }
}

/** J3-02 一轮：审查员在审子 agent 的写，Esc */
async function escDuringReview(): Promise<{ cwText: string }> {
  const sw = await spawnWorld()
  sw.review.enabled = true
  const { world } = sw
  const session = await sw.open()
  world.chat(callTool('agent', { name: 'explore', prompt: 'write', description: 'w' }, 'r-agent'))
  world.model.chatIn('explore', callTool('write', { path: 'out.txt', content: 'X' }, 'c-w'))
  const reviewing = stalled()
  world.model.chatIn('reviewer', reviewing.step)

  const sending = session.submitUser('go')
  await withTimeout(reviewing.reached, 3000, 'reviewer request')
  const C = await childOfCall(session, 'r-agent')
  const A = (await recordOf(session, C))!.agentId
  const writeTask = await toolTaskOf(session, C, 'c-w')
  const [R] = await ownedBy(session, writeTask.id)
  expect(R).toBeDefined()
  const R_A = (await recordOf(session, R!))!.agentId

  await withTimeout(session.abort(), 2000, 'abort')
  expect(await withTimeout(sending, 2000, 'send settles')).toEqual({})

  await waitFor(async () => (await liveTasks(session)).length === 0, 2000, 'no live tasks')
  expect((await tasksIn(session, R!, 'pi.generation')).map(fate)).toEqual(['aborted'])
  const runId = sw.runs.find((event) => event.type === 'start')!
  const reviewSubmission = await submissionOf(
    session,
    R!,
    `hook:${(runId as { run: { runId: string } }).run.runId}`
  )
  expect(reviewSubmission).toMatchObject({ status: 'unanswered', reason: 'aborted' })
  expect(world.t.asksOf('input_request')).toEqual([])
  const cw = await resultOf(session, C, 'c-w')

  expect((await tasksIn(session, C, 'pi.generation')).map(fate)).toEqual(['aborted'])
  expect(fate((await toolTaskOf(session, 1, 'r-agent')) as never)).toBe('aborted')
  expect(world.fs.writesTo('/ws/out.txt')).toBe(0)
  await waitFor(() => sw.router.ends().length === 2, 2000, 'router ends')
  const ends = new Map(sw.router.ends().map((end) => [end.sessionId, end.isError]))
  expect(ends.get(R_A)).toBe(true)
  expect(ends.get(A)).toBe(true)
  expect(sw.router.tasks?.runningCount('s1', 'agent')).toBe(0)
  await waitFor(() => sw.ends('auto-review').length === 1, 2000, 'review end')
  expect(sw.ends('auto-review')[0]).toMatchObject({ ok: false, error: 'aborted' })
  return { cwText: cw.text }
}

describe('P2-11 · J3 Esc cascade', () => {
  it(
    "J3-01 Esc with a child's card pending and a titler live: the child, its card and its dispatch stop; the titler runs on",
    async () => {
      const texts: string[] = []
      for (let round = 0; round < ROUNDS; round++) texts.push((await escWithCardAndTitler()).cwText)
      expect(texts).toEqual(Array(ROUNDS).fill(harnessErrorText('Tool write was aborted')))
    },
    TIMEOUT * 2
  )

  it(
    "J3-02 Esc during the review of a child's write: the reviewer, the child and the dispatch abort; no card ever appears",
    async () => {
      const texts: string[] = []
      for (let round = 0; round < ROUNDS; round++) texts.push((await escDuringReview()).cwText)
      expect(texts).toEqual(Array(ROUNDS).fill(harnessErrorText('Tool write was aborted')))
    },
    TIMEOUT * 2
  )

  it(
    'J3-03 a nested Esc cuts an MCP call: the server sees the cancel, every dispatch level aborts',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(
        callTool('agent', { name: 'nester', prompt: 'find X', description: 'n' }, 'r-agent')
      )
      world.model.chatIn(
        'nester',
        callTool('agent', { name: 'explore', prompt: 'slow', description: 's' }, 'c-agent')
      )
      world.model.chatIn('explore', callTool('mcp__docs__slow', {}, 'g-slow'))
      const sending = session.submitUser('go')
      await waitFor(() => world.mcpLog.callsOf('slow').length === 1, 3000, 'slow call reached')
      const C = await childOfCall(session, 'r-agent')
      const G = await childOfCall(session, 'c-agent', C)
      const A_C = (await recordOf(session, C))!.agentId
      const A_G = (await recordOf(session, G))!.agentId

      await withTimeout(session.abort(), 2000, 'abort')
      expect(await withTimeout(sending, 2000, 'send settles')).toEqual({})
      await waitFor(
        () => world.mcpLog.callsOf('slow')[0]!.abortedBy === 'signal',
        2000,
        'slow cancelled'
      )
      expect(world.mcpLog.errors).toEqual([])
      expect(world.mcpLog.callsOf('slow')).toHaveLength(1)
      await noLiveTasks(sw)
      expect(fate((await toolTaskOf(session, C, 'c-agent')) as never)).toBe('aborted')
      expect(fate((await toolTaskOf(session, 1, 'r-agent')) as never)).toBe('aborted')
      expect(fate((await toolTaskOf(session, G, 'g-slow')) as never)).toBe('aborted')
      await waitFor(() => sw.router.ends().length === 2, 2000, 'router ends')
      const ends = new Map(sw.router.ends().map((end) => [end.sessionId, end.isError]))
      expect(ends.get(A_G)).toBe(true)
      expect(ends.get(A_C)).toBe(true)
    },
    TIMEOUT
  )
})
