/**
 * SpawnCoordinator · 崩溃、重开与重新挂上：一个子 agent、一条输入（P2-03，J 段 55–62，全部 SQLite）。
 * 派发工具 replay safe：继续时它重跑，按拥有者找到已建的子对话、以同一 requestId 拿回原来那条提交；
 * 子对话的生成在同一个 Harness 里接着跑。不再解析工具、不再算变量表、不再问档案模型。
 */
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type SubmissionId,
  type TaskId,
  type ToolExecutionApi
} from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import type { SpawnCreatedInfo } from '../spawn'
import { buildResultContractNote, NEXT_NUDGE_TEXT } from '../../subagent/nextTool'
import { answer, callTool, callTools, stalled } from './support/faux'
import { registerHostCleanup } from './support/host'
import { extensionTools } from './support/scenario'
import {
  callAgent,
  childOf,
  conversationIds,
  dispatchTask,
  firstChild,
  hostD,
  liveTasks,
  requestsWith,
  submissionByRequest,
  tasksOf,
  TITLE_SCHEMA,
  type HostD
} from './support/spawn'
import { holdTool } from './support/tools'
import { allEntries, transcript } from './support/transcript'
import { aborted, deferred, waitFor, withTimeout } from './support/wait'

registerHostCleanup()

const RESTART_TIMEOUT = 15000

/** 子 agent 在本进程里的请求（最后一条用户消息） */
const lastUsers = (d: HostD): string[] =>
  d.t.kit.requests.map((request) => {
    const user = [...request.messages].reverse().find((message) => message.role === 'user')
    return typeof user?.content === 'string'
      ? user.content
      : (user?.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('')
  })

const spawnedResolves = (d: HostD): number =>
  d.t.toolHost.resolveCalls.filter((call) => call.kind === 'spawned').length

async function userLines(d: HostD, C: ConversationId): Promise<string[]> {
  const lines = await transcript((await d.session.harness.conversation(C, BG))!)
  return lines.filter((line) => line.startsWith('pi.user:'))
}

/** 进程 1：根派发、子 agent 卡住不答，然后崩溃；交回进程 2 与子对话 */
async function crashMidChild(
  first: HostD,
  prompt = 'find X'
): Promise<{
  d: HostD
  C: ConversationId
  task: TaskId
  agentId: string
  submissionId: SubmissionId
}> {
  const stall = stalled()
  first.t.kit.queue(callAgent('explore', prompt), stall.step)
  void first.session.submitUser('go')
  await stall.reached
  const C = await firstChild(first.session)
  const task = await dispatchTask(first.session)
  const record = (await spawnedAgentRecordOf(first.session.harness, C, BG))!
  const submission = (await submissionByRequest(first.session, C, `agent:${task}`))!
  const d = await first.reopen()
  return { d, C, task, agentId: record.agentId, submissionId: submission.id }
}

describe('SpawnCoordinator · re-attach after a crash', () => {
  it(
    'P2-03-55 headline: reopen paused with the child restored; continue re-attaches one child, one input',
    async () => {
      const first = await hostD()
      const { d, C, task, agentId, submissionId } = await crashMidChild(first)
      expect(d.session.isInterrupted()).toBe(true)
      expect(d.session.runState).toBe('interrupted')
      expect((await d.session.harness.inspect(BG)).scheduling).toBe('paused')
      expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
      expect(d.t.kit.callCount).toBe(0)
      const varsBefore = d.vars.state.calls
      const rpmBefore = d.rpm.calls.length
      d.t.kit.queue(answer('found'), answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(await childOf(d.session, task)).toEqual([C])
      expect(await conversationIds(d.session)).toHaveLength(2)
      expect(await userLines(d, C)).toEqual(['pi.user:find X'])
      expect((await submissionByRequest(d.session, C, `agent:${task}`))!.id).toBe(submissionId)
      expect(lastUsers(d).filter((text) => text === 'find X')).toHaveLength(1)
      const rootEntries = await allEntries(await d.session.currentConversation())
      const result = rootEntries.find((entry) => entry.kind === 'pi.tool-result')!
      const message = result.model![0] as { content: { text?: string }[]; details?: unknown }
      expect(message.content.map((part) => part.text).join('')).toBe('found')
      expect(message.details).toEqual({ conversationId: C, agentId })
      expect(spawnedResolves(d)).toBe(0)
      expect(d.vars.state.calls).toBe(varsBefore)
      expect(d.rpm.calls).toHaveLength(rpmBefore)
      // 进程 3：什么都没在跑，子对话不重建
      const third = await d.reopen()
      expect(third.t.toolHost.rebuildCalls.some((record) => 'agentId' in record)).toBe(false)
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-56 settled re-attach: the child had answered; the rerun reads it without a request',
    async () => {
      let holding = true
      const spawned = deferred()
      const first = await hostD({
        dispatch: {
          afterSpawn: async (context) => {
            if (!holding) return
            spawned.resolve()
            await aborted(context.abortSignal!)
          }
        }
      })
      first.t.kit.queue(callAgent('explore', 'find X'), answer('found'))
      void first.session.submitUser('go')
      await spawned.promise
      const C = await firstChild(first.session)
      const before = await transcript((await first.session.harness.conversation(C, BG))!)
      holding = false
      const d = await first.reopen()
      d.t.kit.queue(answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(d.outcomes.at(-1)).toMatchObject({ result: 'found', conversationId: C })
      expect(lastUsers(d).filter((text) => text === 'find X')).toEqual([])
      expect(await transcript((await d.session.harness.conversation(C, BG))!)).toEqual(before)
      expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
        'pi.assistant:done'
      )
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-57 a crash between commit and submit: not rebuilt at open; the rerun installs and submits fresh',
    async () => {
      let crashing = true
      let api: ToolExecutionApi | undefined
      const memos: unknown[] = []
      const reached = deferred()
      const first = await hostD({
        dispatch: {
          wrapApi: (given) => {
            api = given
            if (!crashing) return given
            return {
              ...given,
              conversation: (_id, context) => {
                reached.resolve()
                return aborted(context.abortSignal!)
              }
            }
          },
          afterSpawn: async () => void memos.push(await api!.memo('agentId', BG))
        }
      })
      first.t.kit.queue(callAgent('explore', 'find X'))
      void first.session.submitUser('go')
      await reached.promise
      const C = await firstChild(first.session)
      const record = (await spawnedAgentRecordOf(first.session.harness, C, BG))!
      crashing = false
      const d = await first.reopen()
      expect(await liveTasks(d.session, C)).toEqual([])
      expect(d.t.toolHost.rebuildCalls.some((r) => 'agentId' in r)).toBe(false)
      expect(extensionTools(d.t, `shuvix.agent.${C}`)).toBeUndefined()
      memos.length = 0
      d.t.kit.queue(answer('found'), answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(d.t.toolHost.rebuildCalls.at(-1)).toEqual(record)
      expect(await userLines(d, C)).toEqual(['pi.user:find X'])
      const after = (await spawnedAgentRecordOf(d.session.harness, C, BG))!
      expect(after.createdAt).toBe(record.createdAt)
      expect(after.agentId).toBe(record.agentId)
      expect(memos).toEqual([record.agentId])
      expect(spawnedResolves(d)).toBe(0)
      expect(d.outcomes.at(-1)).toMatchObject({ result: 'found' })
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-58 nested: both dispatch tasks rerun; one input each; one G request; answers bubble up',
    async () => {
      const first = await hostD()
      const stall = stalled()
      first.t.kit.queue(
        callAgent('nester', 'mid'),
        callAgent('explore', 'leaf', { id: 'call-g' }),
        stall.step
      )
      void first.session.submitUser('go')
      await stall.reached
      const C = await firstChild(first.session)
      const G = await firstChild(first.session, C)
      const d = await first.reopen()
      // 进程 1 关停时被中止的那两次调用也交回过结果；只看进程 2 的
      const before = d.outcomes.length
      d.t.kit.queue(answer('leaf done'), answer('mid done'), answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(await conversationIds(d.session)).toHaveLength(3)
      expect(await userLines(d, C)).toEqual(['pi.user:mid'])
      expect(await userLines(d, G)).toEqual(['pi.user:leaf'])
      expect(lastUsers(d).filter((text) => text === 'leaf')).toHaveLength(1)
      expect(d.outcomes.slice(before).map((outcome) => outcome.result)).toEqual([
        'leaf done',
        'mid done'
      ])
      expect((await transcript(await d.session.currentConversation())).at(-1)).toBe(
        'pi.assistant:done'
      )
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-59 a crash during the nudge run: the nudge re-attaches; the capture lands in process 2',
    async () => {
      const contract = { schema: structuredClone(TITLE_SCHEMA) }
      const first = await hostD({ dispatch: { contract } })
      const stall = stalled()
      first.t.kit.queue(callAgent('explore', 'p'), answer('text'), stall.step)
      void first.session.submitUser('go')
      await stall.reached
      const C = await firstChild(first.session)
      const task = await dispatchTask(first.session)
      const nudge = (await submissionByRequest(first.session, C, `agent:${task}:nudge:1`))!
      const d = await first.reopen()
      d.t.kit.queue(callTool('next', { title: 'B' }), answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(await userLines(d, C)).toEqual([
        `pi.user:p\n\n${buildResultContractNote(contract)}`,
        `pi.user:${NEXT_NUDGE_TEXT}`
      ])
      expect((await submissionByRequest(d.session, C, `agent:${task}:nudge:1`))!.id).toBe(nudge.id)
      expect(d.outcomes.at(-1)!.structured).toEqual({ title: 'B' })
      expect(await submissionByRequest(d.session, C, `agent:${task}:nudge:2`)).toBeUndefined()
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-60 a durable capture across a crash: the rerun reads it and stops the child',
    async () => {
      const contract = { schema: structuredClone(TITLE_SCHEMA) }
      const holding = deferred()
      const first = await hostD({
        dispatch: { contract },
        tools: () => [holdTool('hold', new Promise(() => {}), { onRun: () => holding.resolve() })]
      })
      // 崩在「next 的结果落了、协调器还没来得及中止」那一刻：同一次发布里同步关掉宿主
      let C: ConversationId | undefined
      const stop = first.session.harness.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (
            change.type === 'entry' &&
            change.value.kind === 'pi.tool-result' &&
            (change.value.model?.[0] as { toolName?: string }).toolName === 'next'
          ) {
            C = change.value.conversationId
            void first.t.host.closeAll()
          }
        }
      })
      first.t.kit.queue(
        callAgent('explore', 'p'),
        callTools([
          ['next', { title: 'A' }, 'c1'],
          ['hold', {}, 'c2']
        ])
      )
      void first.session.submitUser('go').catch(() => undefined)
      await holding.promise
      await waitFor(() => C !== undefined, 3000, 'the next result')
      stop()
      const d = await first.reopen()
      d.t.kit.queue(answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      const entries = await allEntries((await d.session.harness.conversation(C!, BG))!)
      const hold = entries.find(
        (entry) =>
          entry.kind === 'pi.tool-result' &&
          (entry.model![0] as { toolCallId?: string }).toolCallId === 'c2'
      )!
      expect(JSON.stringify(hold.model)).toContain('may have partially run')
      const outcome = d.outcomes.at(-1)!
      expect(outcome.structured).toEqual({ title: 'A' })
      expect('error' in outcome).toBe(false)
      expect(requestsWith(d.t.kit, `p\n\n${buildResultContractNote(contract)}`)).toEqual([])
      expect((await tasksOf(d.session, C!)).at(-1)!.state.status).toBe('terminal')
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-61 abort-then-send after a crash (R5): the dispatch and the child are aborted; only the new turn runs',
    async () => {
      const first = await hostD()
      const { d, C, task } = await crashMidChild(first)
      d.t.kit.queue(answer('new answer'))
      expect(await withTimeout(d.session.submitUser('new'), 5000, 'send')).toEqual({})
      const dispatch = (await tasksOf(d.session, ROOT_CONVERSATION_ID, 'pi.tool')).find(
        (t) => t.id === task
      )!
      expect(dispatch.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } })
      expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
        outcome: { status: 'aborted' }
      })
      expect(d.t.kit.requests).toHaveLength(1)
      expect(lastUsers(d)).toEqual(['new'])
      expect(extensionTools(d.t, `shuvix.agent.${C}`)).toEqual(['probe'])
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-62 an unsafe dispatch baseline: the call settles interrupted and its child is cancelled',
    async () => {
      const first = await hostD({ dispatch: { replay: 'unsafe' } })
      const { d, C } = await crashMidChild(first)
      d.t.kit.queue(answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      const lines = await transcript(await d.session.currentConversation())
      expect(lines.find((line) => line.startsWith('pi.tool-result:'))).toContain(
        'interrupted and may have partially run'
      )
      expect(await liveTasks(d.session, C)).toEqual([])
      expect((await tasksOf(d.session, C)).at(-1)!.state).toMatchObject({
        status: 'terminal'
      })
      expect(lastUsers(d).filter((text) => text === 'find X')).toEqual([])
      expect(lines.at(-1)).toBe('pi.assistant:done')
    },
    RESTART_TIMEOUT
  )

  it(
    'P2-03-OC4 onCreated fires again on the rerun, with reattached: true and the same ids',
    async () => {
      const seen: SpawnCreatedInfo[] = []
      const first = await hostD({ dispatch: { onCreated: (info) => seen.push(info) } })
      const { d, C, agentId } = await crashMidChild(first)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ conversationId: C, agentId, reattached: false })
      d.t.kit.queue(answer('found'), answer('done'))
      expect(await withTimeout(d.session.continue(), 5000, 'continue')).toEqual({})
      expect(seen).toHaveLength(2)
      expect(seen[1]).toEqual({ ...seen[0], reattached: true })
    },
    RESTART_TIMEOUT
  )
})
