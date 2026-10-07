/**
 * P2-11 · J4：崩溃、重开、继续（SQLite，模拟换进程）。打开时按记录重建子 agent 的工具（不连服务器、不跑）；
 * 继续时派发工具（replay safe）重跑、按拥有者边找回子对话、以同一 requestId 重新挂上；不安全的工具记
 * 「中断，可能已部分执行」。宿主派发的辅助工作（titler、审查员）打开时打中止标记、从不续跑。
 */
import { describe, expect, it } from 'vitest'
import { answer, callTool, stalled } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { conversationIds } from '../support/spawn'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { harnessErrorText } from './support/entries'
import { callTools, lastToolResult, lines, when } from './support/scriptedModel'
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
  transcriptOf,
  type SpawnWorld
} from './support/spawnWorld'
import { choose, nextInput, registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 20000
const INTERRUPTED = (tool: string): string =>
  harnessErrorText(`Tool ${tool} was interrupted and may have partially run`)

const ASK_ARGS = {
  question: 'Q',
  options: [
    { label: 'A', description: 'first' },
    { label: 'B', description: 'second' }
  ]
}

function extensionTools(sw: SpawnWorld, name: string): string[] | undefined {
  const extension = sw.world.t.registryOf('s1')?.snapshot().extension(name)
  return extension === undefined ? undefined : (extension.tools ?? []).map((tool) => tool.name)
}

function connectsTotal(sw: SpawnWorld): number {
  return [...sw.world.mcp.connects.values()].reduce((sum, n) => sum + n, 0)
}

describe('P2-11 · J4 crash, reopen, continue', () => {
  it(
    'J4-01 re-attach across real MCP: open fully initializes the root lock (its MCP servers connect, option A) and rebuilds the child without connecting it or running anything; continue re-attaches the same submission',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      const rootLock = structuredClone(session.lock)
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'find X', description: 'look' }, 'r-agent')
      )
      world.model.chatIn('explore', callTool('mcp__docs__slow', {}, 'c-slow'))
      void session.submitUser('go')
      await waitFor(() => world.mcpLog.callsOf('slow').length === 1, 3000, 'slow call reached')
      const C = await childOfCall(session, 'r-agent')
      const record = (await recordOf(session, C))!
      const A = record.agentId
      const dispatchId = (await toolTaskOf(session, 1, 'r-agent')).id
      const submissionBefore = await submissionOf(session, C, `agent:${dispatchId}`)
      expect(submissionBefore).toBeDefined()
      await withTimeout(sw.restart(), 10000, 'restart')

      const varsBefore = world.vars.state.calls
      const reopened = await sw.open()
      expect(world.toolHost.rebuildCalls).toEqual([rootLock, record])
      expect(extensionTools(sw, `shuvix.agent.${C}`)).toEqual(
        expect.arrayContaining(['mcp__docs__lookup', 'mcp__docs__slow', 'mcp__ctx__whoami'])
      )
      // 只有根锁记着的服务器在打开时连上（完整初始化）；子 agent 的重建不连
      expect(connectsTotal(sw)).toBe(Object.keys(rootLock!.mcp).length)
      expect(reopened.isInterrupted()).toBe(true)
      expect(world.t.statesOf('s1')).toEqual(['interrupted'])
      await sleep(150)
      expect(world.t.kit.callCount).toBe(0)
      expect(sw.router.registers()).toEqual([])

      world.model.chatIn(
        'explore',
        when((messages) =>
          lastToolResult(messages, 'mcp__docs__slow')?.includes('was interrupted')
            ? callTool('mcp__docs__lookup', { q: 'y' }, 'c-look')
            : answer('the slow call was not interrupted?')
        ),
        answer('found')
      )
      world.chat(answer('done'))
      expect(await withTimeout(reopened.continue(), 8000, 'continue')).toEqual({})

      const childLines = await transcriptOf(reopened, C)
      expect(childLines.filter((line) => line.startsWith('pi.user:'))).toEqual(['pi.user:find X'])
      expect((await submissionOf(reopened, C, `agent:${dispatchId}`))?.id).toBe(
        submissionBefore!.id
      )
      expect(world.mcpLog.callsOf('slow')).toHaveLength(1)
      expect((await resultOf(reopened, C, 'c-slow')).text).toBe(INTERRUPTED('mcp__docs__slow'))
      expect(world.mcp.connectsOf('docs')).toBe(1)
      const rAgent = await resultOf(reopened, 1, 'r-agent')
      expect(rAgent.text).toBe('found')
      expect(rAgent.details).toEqual({ conversationId: C, agentId: A })
      expect(sw.router.registers()).toEqual([
        expect.objectContaining({ sessionId: A, parentToolCallId: 'r-agent' })
      ])
      expect(sw.router.statuses(A)).toEqual(['running', 'done'])
      expect(world.toolHost.resolveCalls).toEqual([])
      expect(world.vars.state.calls).toBe(varsBefore)
      expect(await conversationIds(reopened)).toHaveLength(2)
    },
    TIMEOUT
  )

  it(
    'J4-02 a crash with a titler and a reviewer live: both are abort-marked at open and never resumed; the child write is interrupted',
    async () => {
      const sw = await spawnWorld()
      sw.review.enabled = true
      const { world } = sw
      const session = await sw.open()
      const rootLock = structuredClone(session.lock)
      const titling = stalled()
      const reviewing = stalled()
      world.model.chatIn('titler', titling.step)
      world.model.chatIn('reviewer', reviewing.step)
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'write', description: 'w' }, 'r-agent')
      )
      world.model.chatIn('explore', callTool('write', { path: 'out.txt', content: 'X' }, 'c-w'))
      sw.fireTitle('go')
      void session.submitUser('go')
      await withTimeout(Promise.all([titling.reached, reviewing.reached]), 3000, 'both requests')
      const C = await childOfCall(session, 'r-agent')
      const record = (await recordOf(session, C))!
      const writeTask = await toolTaskOf(session, C, 'c-w')
      const [R] = await ownedBy(session, writeTask.id)
      const [anchor] = await anchorTasks(session)
      const [T] = await ownedBy(session, anchor!.id)
      await withTimeout(sw.restart(), 10000, 'restart')

      const reopened = await sw.open()
      for (const id of [T!, R!]) {
        const tasks = await tasksIn(reopened, id)
        expect(tasks.filter((task) => fate(task) !== 'completed').length).toBeGreaterThan(0)
        for (const task of tasks.filter((t) => t.state.status !== 'terminal')) {
          expect(task.abortRequested, `task ${task.id} in ${id}`).toBe(true)
        }
      }
      for (const id of [1, C]) {
        for (const task of (await liveTasks(reopened)).filter((t) => t.conversationId === id)) {
          expect(task.abortRequested, `task ${task.id} in ${id}`).toBe(false)
        }
      }
      expect(reopened.isInterrupted()).toBe(true)
      expect(world.t.statesOf('s1')).toEqual(['interrupted'])
      expect(world.toolHost.rebuildCalls).toEqual([rootLock, record])
      await sleep(150)
      expect(world.t.asksOf('input_request')).toEqual([])
      expect(world.t.kit.callCount).toBe(0)

      world.model.chatIn(
        'explore',
        when((messages) =>
          lastToolResult(messages, 'write')?.includes('was interrupted')
            ? answer('gave up')
            : answer('the write was not interrupted?')
        )
      )
      world.chat(answer('done'))
      expect(await withTimeout(reopened.continue(), 8000, 'continue')).toEqual({})

      expect((await resultOf(reopened, C, 'c-w')).text).toBe(INTERRUPTED('write'))
      expect((await resultOf(reopened, 1, 'r-agent')).text).toBe('gave up')
      expect(world.fs.writes).toEqual([])
      await waitFor(async () => (await liveTasks(reopened)).length === 0, 2000, 'no live tasks')

      // 审查员：没有续跑、没有卡片，终态 aborted，拥有者边不变
      expect(world.model.laneRequests('reviewer')).toEqual([])
      expect(world.t.asksOf('input_request')).toEqual([])
      expect((await tasksIn(reopened, R!, 'pi.generation')).map(fate)).toEqual(['aborted'])
      expect(await ownedBy(reopened, writeTask.id)).toEqual([R])

      // titler：没有续跑、桩没被调；生成任务与锚在继续开启调度器之后终结（PIN-06）
      expect(world.model.laneRequests('titler')).toEqual([])
      expect(sw.sessionCalls).toEqual([])
      expect((await tasksIn(reopened, T!, 'pi.generation')).map(fate)).toEqual(['aborted'])
      expect((await anchorTasks(reopened)).map((task) => task.state.status)).toEqual(['terminal'])
      await waitFor(() => world.t.statesOf('s1').length >= 3, 1000, 'run states')
      expect(world.t.statesOf('s1')).toEqual(['interrupted', 'busy', 'idle'])
    },
    TIMEOUT
  )

  it(
    'J4-03 asks pending in a child across a crash: continue re-asks the same ask on the session, the write is interrupted with no card',
    async () => {
      const sw = await spawnWorld()
      const { world } = sw
      const session = await sw.open()
      world.chat(callTool('agent', { name: 'explore', prompt: 'ask', description: 'a' }, 'r-agent'))
      world.model.chatIn(
        'explore',
        callTools(['ask', ASK_ARGS, 'c-a'], ['write', { path: 'out.txt', content: 'X' }, 'c-w'])
      )
      void session.submitUser('go')
      await nextInput(world, 'c-a')
      await nextInput(world, 'c-w')
      expect(session.pendingInputCount).toBe(2)
      const C = await childOfCall(session, 'r-agent')

      const t1 = world.t
      await withTimeout(sw.restart(), 10000, 'restart')
      const resolved = t1.asksOf('input_request_resolved')
      expect(resolved.map((event) => event.requestId).sort()).toEqual(['c-a', 'c-w'])
      const reopened = await sw.open()
      await sleep(150)
      expect(world.t.asksOf('input_request')).toEqual([])

      world.model.chatIn('explore', answer('ok'))
      world.chat(answer('done'))
      const continuing = reopened.continue()
      const reasked = await nextInput(world, 'c-a')
      expect(reasked).toMatchObject({ kind: 'choice', question: 'Q', options: ASK_ARGS.options })
      expect(world.t.asksOf('input_request')).toEqual([
        expect.objectContaining({ sessionId: 's1' })
      ])
      choose(world, 'c-a', ['B'])
      expect(await withTimeout(continuing, 8000, 'continue')).toEqual({})

      const childRequest = world.model.laneRequests('explore')[0]!
      expect(lines(childRequest).filter((line) => line.startsWith('toolResult:'))).toEqual([
        'toolResult:User selected: B',
        `toolResult:${INTERRUPTED('write')}`
      ])
      expect((await resultOf(reopened, C, 'c-w')).text).toBe(INTERRUPTED('write'))
      expect(world.t.asksOf('input_request')).toHaveLength(1)
      expect((await resultOf(reopened, 1, 'r-agent')).text).toBe('ok')
      expect((await transcriptOf(reopened, 1)).at(-1)).toBe('pi.assistant:done')
      expect(world.fs.writes).toEqual([])
    },
    TIMEOUT
  )
})
