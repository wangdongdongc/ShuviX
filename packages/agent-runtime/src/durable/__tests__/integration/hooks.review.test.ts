/**
 * P2-11 · J7：审查员的拥有者边与级联（审查桥开，PIN-02）。真安全 PEP 在弹卡之前把 ask 交给审查接缝 → 真
 * hook runner（内置 auto-review md）→ 真路由 → 真协调器派出内置 permission-reviewer；它的对话归**提问的那个
 * 工具任务**（Q16），交卷走结果契约的 `next`。
 */
import type { CommitPublication } from '@earendil-works/pi-durable'
import { PERMISSION_VERDICT_SCHEMA } from '@shuvix/chat-protocol/types/permissionReview'
import type { InputResponse } from '@shuvix/chat-protocol/types/inputRequest'
import { describe, expect, it } from 'vitest'
import { NEXT_NUDGE_TEXT, nextResultOf } from '../../../subagent/nextTool'
import { backgroundContext as BG } from '../../context'
import { executeTool, failureText } from '../../../tools/testing/invokeTool'
import type { DurableSession } from '../../durableSession'
import { answer, callTool } from '../support/faux'
import { registerHostCleanup } from '../support/host'
import { allEntries } from '../support/transcript'
import { sleep, waitFor, withTimeout } from '../support/wait'
import { memFs } from './support/memFs'
import { fileSuite, securityFor, type ReviewSeam } from './support/realTools'
import { callTools, textOf } from './support/scriptedModel'
import {
  childOfCall,
  fate,
  liveTasks,
  ownedBy,
  ownerOf,
  recordOf,
  registerSpawnCleanup,
  resultOf,
  reviewerOverrideMd,
  REVIEW_FENCE,
  spawnWorld,
  tasksIn,
  toolTaskOf,
  transcriptOf,
  V_ALLOW,
  V_DENY,
  type SpawnWorld
} from './support/spawnWorld'
import { allow, NOTES_TXT, nextInput, registerWorldCleanup } from './support/world'

registerHostCleanup()
registerWorldCleanup()
registerSpawnCleanup()

const TIMEOUT = 15000
const WRITE_ARGS = { path: 'out.txt', content: 'X' }

/** 直接调一次真 write（干净的磁盘、另一个安全上下文），卡片 / 审查按给定的回答 */
function directWrite(response: InputResponse, review?: ReviewSeam): ReturnType<typeof executeTool> {
  const suite = fileSuite(
    memFs({ '/ws/notes.txt': NOTES_TXT }),
    securityFor('direct-review', async () => response, [], review)
  )
  return executeTool(suite.write, 'c-w', WRITE_ARGS)
}

function contentText(result: Awaited<ReturnType<typeof executeTool>>): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/** 记下每个任务的状态序列（提交发布里的任务变化） */
function recordTaskStates(session: DurableSession): Map<number, string[]> {
  const states = new Map<number, string[]>()
  session.harness.subscribeCommits((publication: CommitPublication) => {
    for (const change of publication.changes) {
      if (change.type !== 'task') continue
      const id = change.value.id as unknown as number
      const list = states.get(id) ?? []
      list.push(change.value.state.status)
      states.set(id, list)
    }
  })
  return states
}

async function reviewWorld(profiles?: Record<string, string>): Promise<{
  sw: SpawnWorld
  session: DurableSession
}> {
  const sw = await spawnWorld(profiles === undefined ? {} : { profiles })
  sw.review.enabled = true
  const session = await sw.open()
  return { sw, session }
}

describe('P2-11 · J7 reviewer owner edge and cascade', () => {
  it(
    'J7-01 a root write reviewed and allowed: the reviewer is owned by the write task, no card, the write runs once',
    async () => {
      const { sw, session } = await reviewWorld()
      const { world } = sw
      const states = recordTaskStates(session)
      const statesBefore = world.t.statesOf('s1').length
      world.chat(callTool('write', WRITE_ARGS, 'r-w'), answer('saved'))
      world.model.chatIn('reviewer', callTool('next', V_ALLOW, 'v1'))
      expect(await withTimeout(session.submitUser('save'), 8000, 'save')).toEqual({})

      const T_w = await toolTaskOf(session, 1, 'r-w')
      const owned = await ownedBy(session, T_w.id)
      expect(owned).toHaveLength(1)
      const R = owned[0]!
      expect(await ownerOf(session, R)).toEqual({ conversationId: 1, taskId: T_w.id })
      const record = (await recordOf(session, R))!
      expect(record).toMatchObject({
        dispatch: 'hook',
        hook: 'auto-review',
        profileName: 'permission-reviewer',
        toolNames: ['next']
      })
      expect(record.resultContract?.schema).toEqual(PERMISSION_VERDICT_SCHEMA)

      const [request] = world.model.laneRequests('reviewer')
      expect(request!.tools).toEqual(['next'])
      expect(request!.reasoning).toBe('low')
      expect(request!.modelId).toBe('faux-1')
      const lastUser = textOf([...request!.messages].reverse().find((m) => m.role === 'user'))
      expect(lastUser).toContain(REVIEW_FENCE)
      expect(lastUser).toContain('/ws/out.txt')

      expect(world.t.asksOf('input_request')).toEqual([])
      expect(session.pendingInputCount).toBe(0)
      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
      expect((await resultOf(session, 1, 'r-w')).text).toBe(
        contentText(await directWrite({ kind: 'ask', allowed: true }))
      )
      expect(fate((await toolTaskOf(session, 1, 'r-w')) as never)).toBe('completed')
      expect(states.get(T_w.id)).not.toContain('completing')

      expect(world.t.statesOf('s1').slice(statesBefore)).toEqual(['busy', 'idle'])
      expect(sw.router.registers()).toHaveLength(1)
      expect(sw.router.registers()[0]!.parentToolCallId).toBeUndefined()
      expect(sw.router.ends()).toEqual([expect.objectContaining({ isError: false })])
      expect(sw.ends('auto-review')).toEqual([expect.objectContaining({ ok: true })])
      await waitFor(async () => (await liveTasks(session)).length === 0, 2000, 'no live tasks')
    },
    TIMEOUT
  )

  it(
    "J7-02 a child's write reviewed and denied: the reviewer hangs under the child's write task; the PEP blocks with the reviewer's reason",
    async () => {
      const { sw, session } = await reviewWorld()
      const { world } = sw
      world.chat(
        callTool('agent', { name: 'explore', prompt: 'write', description: 'w' }, 'r-agent'),
        answer('done')
      )
      world.model.chatIn('explore', callTool('write', WRITE_ARGS, 'c-w'), answer('could not write'))
      world.model.chatIn('reviewer', callTool('next', V_DENY('too risky'), 'v1'))
      expect(await withTimeout(session.submitUser('go'), 8000, 'go')).toEqual({})

      const C = await childOfCall(session, 'r-agent')
      const writeTask = await toolTaskOf(session, C, 'c-w')
      const [R] = await ownedBy(session, writeTask.id)
      expect(R).toBeDefined()
      expect(await recordOf(session, R!)).toMatchObject({ parentConversationId: C, depth: 1 })
      const [request] = world.model.laneRequests('reviewer')
      const lastUser = textOf([...request!.messages].reverse().find((m) => m.role === 'user'))
      expect(lastUser).toContain('profile: explore')
      expect(lastUser).toContain('kind: spawned')

      const cw = await resultOf(session, C, 'c-w')
      expect(cw.isError).toBe(true)
      const expected = await failureText(
        directWrite({ kind: 'ask', allowed: true }, async () => ({
          verdict: V_DENY('too risky') as never,
          source: 'auto-review'
        }))
      )
      expect(cw.text).toBe(expected)
      expect(cw.text.startsWith('Blocked by the reviewer: too risky')).toBe(true)
      expect(world.fs.writes).toEqual([])
      expect(world.t.asksOf('input_request')).toEqual([])
      expect((await resultOf(session, 1, 'r-agent')).text).toBe('could not write')
    },
    TIMEOUT
  )

  it(
    'J7-03 nudge: prose first, then next after the nudge; the write proceeds with no card',
    async () => {
      const { sw, session } = await reviewWorld()
      const { world } = sw
      world.chat(callTool('write', WRITE_ARGS, 'r-w'), answer('saved'))
      world.model.chatIn('reviewer', answer('looks fine'), callTool('next', V_ALLOW, 'v1'))
      expect(await withTimeout(session.submitUser('save'), 8000, 'save')).toEqual({})

      const T_w = await toolTaskOf(session, 1, 'r-w')
      const [R] = await ownedBy(session, T_w.id)
      const lines = await transcriptOf(session, R!)
      expect(lines.map((line) => line.slice(0, line.indexOf(':')))).toEqual([
        'pi.user',
        'pi.assistant',
        'pi.user',
        'pi.assistant',
        'pi.tool-result'
      ])
      expect(lines[1]).toBe('pi.assistant:looks fine')
      expect(lines[2]).toBe(`pi.user:${NEXT_NUDGE_TEXT}`)
      expect(lines[3]).toBe('pi.assistant:[tool:next]')
      expect(world.model.laneRequests('reviewer')).toHaveLength(2)
      expect(world.t.asksOf('input_request')).toEqual([])
      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
    },
    TIMEOUT
  )

  it(
    'J7-04 no verdict: the card appears only after the reviewer has stopped; allowing it writes once',
    async () => {
      const { sw, session } = await reviewWorld()
      const { world } = sw
      world.chat(callTool('write', WRITE_ARGS, 'r-w'), answer('saved'))
      world.model.chatIn('reviewer', answer('hmm'), answer('still thinking'))
      const saving = session.submitUser('save')
      await nextInput(world, 'r-w')
      const T_w = await toolTaskOf(session, 1, 'r-w')
      const [R] = await ownedBy(session, T_w.id)
      expect((await liveTasks(session)).filter((task) => task.conversationId === R)).toEqual([])
      expect(sw.ends('auto-review')).toEqual([
        expect.objectContaining({ ok: false, error: 'no valid result' })
      ])
      allow(world, 'r-w')
      expect(await withTimeout(saving, 5000, 'save')).toEqual({})
      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
      expect(await ownedBy(session, T_w.id)).toEqual([R])
      for (const task of await tasksIn(session, R!)) expect(task.state.status).toBe('terminal')
    },
    TIMEOUT
  )

  it(
    "J7-05 a mixed batch cancels the reviewer's MCP call: the verdict is captured once, the reviewer is aborted, no nudge",
    async () => {
      const { sw, session } = await reviewWorld({
        'permission-reviewer': reviewerOverrideMd('mcp:docs')
      })
      const { world } = sw
      world.chat(callTool('write', WRITE_ARGS, 'r-w'), answer('saved'))
      world.model.chatIn(
        'reviewer',
        callTools(['next', V_ALLOW, 'v1'], ['mcp__docs__slow', {}, 'v2'])
      )
      expect(await withTimeout(session.submitUser('save'), 8000, 'save')).toEqual({})

      expect(world.t.asksOf('input_request')).toEqual([])
      expect(world.fs.writesTo('/ws/out.txt')).toBe(1)
      await waitFor(
        () => world.mcpLog.callsOf('slow')[0]?.abortedBy === 'signal',
        2000,
        'slow cancelled'
      )
      expect(world.mcpLog.errors).toEqual([])
      const T_w = await toolTaskOf(session, 1, 'r-w')
      const [R] = await ownedBy(session, T_w.id)
      await waitFor(async () => (await liveTasks(session)).length === 0, 2000, 'no live tasks')
      expect((await tasksIn(session, R!, 'pi.generation')).map(fate)).toEqual(['aborted'])
      expect(world.model.laneRequests('reviewer').length).toBeLessThanOrEqual(1)
      const conversation = await session.harness.conversation(R!, BG)
      const entries = await allEntries(conversation!)
      expect(
        entries.filter((entry) => entry.kind === 'pi.user').map((entry) => textOf(entry.model?.[0]))
      ).not.toContain(NEXT_NUDGE_TEXT)
      expect(
        entries.filter(
          (entry) => entry.kind === 'pi.tool-result' && nextResultOf(entry) !== undefined
        )
      ).toHaveLength(1)
      await sleep(0)
    },
    TIMEOUT
  )
})
