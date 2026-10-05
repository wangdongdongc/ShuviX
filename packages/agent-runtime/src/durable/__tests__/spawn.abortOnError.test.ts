/**
 * SpawnCoordinator · 出错即中止（P2-03，F 段 32–34）：子对话存在之后的任何失败都先中止子对话 —— 否则
 * 派发工具任务以 completing 挂着，根的这一轮永远等下去（fact 4）。
 */
import type { FauxResponseStep } from '@earendil-works/pi-ai'
import type { ConversationHandle, ToolExecutionApi } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { backgroundContext as BG } from '../context'
import { spawnedAgentRecordOf } from '../agentRecord'
import { answer, held } from './support/faux'
import { registerHostCleanup } from './support/host'
import {
  callAgent,
  conversationIds,
  dispatchTask,
  hostD,
  liveTasks,
  submissionByRequest,
  taskRecord,
  tasksOf,
  TITLE_SCHEMA
} from './support/spawn'
import { withTimeout } from './support/wait'

registerHostCleanup()

/** 包一层：`conversation()` 交回的句柄经 `wrap` 改写 */
function wrapHandle(
  wrap: (handle: ConversationHandle) => ConversationHandle
): (api: ToolExecutionApi) => ToolExecutionApi {
  return (api) => ({
    ...api,
    conversation: async (id, context) => {
      const handle = await api.conversation(id, context)
      return handle === undefined ? undefined : wrap(handle)
    }
  })
}

describe('SpawnCoordinator · abort on error', () => {
  it('P2-03-32 an error before submit: the child exists with its record but has no submission and no live work', async () => {
    const d = await hostD({
      dispatch: {
        wrapApi: (api) => ({ ...api, details: () => Promise.reject(new Error('details broke')) })
      }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('done'))
    expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.error).toContain('details broke')
    const C = outcome.conversationId!
    expect(await spawnedAgentRecordOf(d.session.harness, C, BG)).toBeDefined()
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}`)).toBeUndefined()
    expect(await liveTasks(d.session, C)).toEqual([])
  })

  it('P2-03-33 an error while the child runs: the child is aborted before the tool returns', async () => {
    const step = held(answer('never'))
    const inner = step.step as Extract<FauxResponseStep, (...args: never[]) => unknown>
    let sawAbort = false
    const watched: FauxResponseStep = async (context, options, state, model) => {
      try {
        return await inner(context, options, state, model)
      } catch (error) {
        sawAbort = true
        throw error
      }
    }
    const d = await hostD({
      dispatch: {
        wrapApi: wrapHandle((handle) => ({
          id: handle.id,
          abort: (context, options) => handle.abort(context, options),
          waitForIdle: (context) => handle.waitForIdle(context),
          submit: async (draft, context) => {
            const submission = await handle.submit(draft, context)
            return {
              id: submission.id,
              status: (c) => submission.status(c),
              abort: (c) => submission.abort(c),
              wait: async () => {
                await step.reached
                throw new Error('wait broke')
              }
            }
          }
        }))
      }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), watched, answer('done'))
    expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.error).toContain('wait broke')
    const C = outcome.conversationId!
    const generation = (await tasksOf(d.session, C)).at(-1)!
    expect(generation.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } })
    expect(sawAbort).toBe(true)
    const task = await dispatchTask(d.session)
    expect(await submissionByRequest(d.session, C, `agent:${task}`)).toMatchObject({
      status: 'unanswered',
      reason: 'aborted'
    })
    expect((await liveTasks(d.session)).filter((t) => t.state.status === 'completing')).toEqual([])
    expect((await taskRecord(d.session, task))!.state.status).toBe('terminal')
    expect(d.t.kit.callCount).toBe(3)
  })

  it('P2-03-34 a failing nudge submit: error, the child stops, root resolves', async () => {
    let submits = 0
    const d = await hostD({
      dispatch: {
        contract: { schema: structuredClone(TITLE_SCHEMA) },
        wrapApi: wrapHandle((handle) => ({
          id: handle.id,
          abort: (context, options) => handle.abort(context, options),
          waitForIdle: (context) => handle.waitForIdle(context),
          submit: async (draft, context) => {
            submits++
            if (submits === 2) throw new Error('nudge broke')
            return handle.submit(draft, context)
          }
        }))
      }
    })
    d.t.kit.queue(callAgent('explore', 'find X'), answer('text'), answer('done'))
    expect(await withTimeout(d.session.submitUser('go'), 3000, 'root')).toEqual({})
    const outcome = d.outcomes[0]!
    expect(outcome.error).toContain('nudge broke')
    expect(await liveTasks(d.session, outcome.conversationId)).toEqual([])
    expect(await conversationIds(d.session)).toHaveLength(2)
  })
})
