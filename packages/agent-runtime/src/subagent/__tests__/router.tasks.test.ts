/**
 * 派生 agent 路由 · taskRegistry 的 'agent' 条目（P2-05 D 段，26–31；managerTasks 的移植，-40）：
 *
 *  - **taskId 就是 agentId**，归属可见会话（嵌套派生也是 s1），子 agent 跑起来之前就登记；
 *  - 落定映射 done / error / killed，同步等待挂着等待者 → 不通知；
 *  - 停 = 软停止（interrupt）：部分结果、done、isError false；
 *  - 追问让同一条任务回到运行态；
 *  - 每条路径都落定（没落定的任务会把会话钉在 LRU 里）；重新挂上是幂等的（PIN-14）。
 *
 * 行标题（TITLE-1 / TITLE-3）：`档案显示名 · 派发描述`，描述先 trim；描述为空白或与显示名相同只写显示名；
 * 条目被清掉之后追问重建的那条，标题与派发时同一个（描述随索引条目留着）。
 *
 * RT-1（并在 TITLE-3 里）：清掉之后追问重建的那条，subject 与派发时一模一样 —— 连同派发它的那次 tool_call id
 * （`parentToolCallId`），对话流里那张派发卡才找得回它。
 */
import { fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import type { TaskInfo } from '@shuvix/chat-protocol/types/task'
import { describe, expect, it, vi } from 'vitest'
import {
  answer,
  assistantWith,
  held,
  modelError,
  stalled
} from '../../durable/__tests__/support/faux'
import { registerHostCleanup } from '../../durable/__tests__/support/host'
import { callAgent, firstChild, tasksOf } from '../../durable/__tests__/support/spawn'
import { holdTool } from '../../durable/__tests__/support/tools'
import { transcript } from '../../durable/__tests__/support/transcript'
import { deferred, sleep, waitFor, withTimeout } from '../../durable/__tests__/support/wait'
import {
  CALL,
  createdInfo,
  fakeSession,
  hostR,
  routerKit,
  toolParams,
  type HostR
} from '../../durable/__tests__/support/router'
import type { TaskRegistry } from '../../task/registry'

registerHostCleanup()

/** 包一层任务枢纽：create 加上通知文案（绊线：没人等就会通知） */
function withNotice(tasks: TaskRegistry): TaskRegistry {
  return {
    ...tasks,
    create: (params) => tasks.create({ ...params, formatNotice: () => 'NOTICE' })
  }
}

async function headline(r: HostR): Promise<string> {
  r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
  expect(await r.session.submitUser('go')).toEqual({})
  return r.registers()[0]!.sessionId
}

describe('router · agent task entries', () => {
  it('P2-05-26 created at spawn, before the child runs: taskId = agentId, the visible session, no formatNotice', async () => {
    const creates: unknown[] = []
    const r = await hostR({
      wrapTasks: (tasks) => ({
        ...tasks,
        create: (params) => {
          creates.push(params)
          return tasks.create(params)
        }
      })
    })
    const step = held(answer('found'))
    let seen: TaskInfo[] | undefined
    r.t.kit.queue(
      callAgent('explore', 'find X'),
      async (context, options, state, model) => {
        seen = structuredClone(r.taskBroadcasts)
        const inner = step.step
        return typeof inner === 'function' ? inner(context, options, state, model) : inner
      },
      answer('done')
    )
    const sent = r.session.submitUser('go')
    await step.reached
    const A = r.registers()[0]!.sessionId
    expect(r.task(A)).toMatchObject({
      taskId: A,
      kind: 'agent',
      sessionId: 's1',
      title: 'Explorer · look',
      status: 'running',
      detached: false,
      subject: { kind: 'agent', profileName: 'explore', depth: 1, parentToolCallId: CALL }
    })
    expect(seen?.[0]).toMatchObject({ taskId: A, status: 'running' })
    expect(creates).toHaveLength(1)
    expect('formatNotice' in (creates[0] as object)).toBe(false)
    step.release()
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
  })

  it.each(['done', 'model error', 'Esc'] as const)(
    'P2-05-27 settle mapping: %s; endedAt set; the waiter means no notice even with a formatter',
    async (row) => {
      const r = await hostR({ wrapTasks: withNotice })
      const stall = stalled()
      if (row === 'done') {
        r.t.kit.queue(callAgent('explore', 'find X'), answer('found'), answer('done'))
        await r.session.submitUser('go')
      } else if (row === 'model error') {
        r.t.kit.queue(callAgent('explore', 'find X'), modelError('boom'), answer('done'))
        await r.session.submitUser('go')
      } else {
        r.t.kit.queue(callAgent('explore', 'find X'), stall.step)
        const sent = r.session.submitUser('go')
        await stall.reached
        await withTimeout(r.session.abort(), 3000, 'abort')
        await withTimeout(sent, 3000, 'root')
      }
      await waitFor(() => r.ends().length > 0, 3000, 'end')
      const A = r.registers()[0]!.sessionId
      const expected = { done: 'done', 'model error': 'error', Esc: 'killed' }[row]
      expect(r.task(A)?.status).toBe(expected)
      expect(r.task(A)?.endedAt).not.toBeNull()
      await sleep(20)
      expect(r.delivered).toEqual([])
      expect(r.tasks!.runningCount('s1', 'agent')).toBe(0)
    }
  )

  it('P2-05-28 stop = interrupt: the child is aborted, the outcome soft, the task done, no notice; root continues', async () => {
    const hanging = deferred()
    const r = await hostR({
      tools: () => [holdTool('hang', new Promise(() => {}), { onRun: () => hanging.resolve() })]
    })
    r.t.kit.queue(
      callAgent('explore', 'find X'),
      assistantWith([fauxText('partial'), fauxToolCall('hang', {}, { id: 'call-hang' })], {
        stopReason: 'toolUse'
      }),
      answer('done')
    )
    const sent = r.session.submitUser('go')
    await hanging.promise
    const A = r.registers()[0]!.sessionId
    const C = await firstChild(r.session)
    expect(r.tasks!.stop(A, { by: 'user' })).toBe(true)
    expect(await withTimeout(sent, 3000, 'root')).toEqual({})
    await waitFor(() => r.ends().length > 0, 3000, 'end')
    const inner = (await tasksOf(r.session, C, 'pi.tool')).at(-1)!
    expect(inner.state).toMatchObject({ status: 'terminal', outcome: { status: 'aborted' } })
    expect(r.task(A)?.status).toBe('done')
    expect(r.ends()[0]).toMatchObject({
      isError: false,
      result: 'partial\n\n[Note] stopReason=toolUse'
    })
    await sleep(20)
    expect(r.delivered).toEqual([])
    expect((await transcript(await r.session.currentConversation())).at(-1)).toBe(
      'pi.assistant:done'
    )
  })

  it('P2-05-29 continue reopens the same entry: running while held, done after; statuses running/done twice', async () => {
    const r = await hostR()
    const A = await headline(r)
    const step = held(answer('more ok'))
    r.t.kit.queue(step.step)
    const continued = r.router.continueTask({ subSessionId: A, text: 'more' })
    await step.reached
    expect(r.task(A)?.status).toBe('running')
    step.release()
    await withTimeout(continued, 3000, 'continue')
    expect(r.task(A)?.status).toBe('done')
    expect(r.statuses(A)).toEqual(['running', 'done', 'running', 'done'])
  })

  it('P2-05-29 tasks.stop during a held continue → done; continueTask resolves; no notice', async () => {
    const r = await hostR()
    const A = await headline(r)
    const stall = stalled()
    r.t.kit.queue(stall.step)
    const continued = r.router.continueTask({ subSessionId: A, text: 'more' })
    await stall.reached
    expect(r.tasks!.stop(A, { by: 'user' })).toBe(true)
    await expect(withTimeout(continued, 3000, 'continue')).resolves.toBeUndefined()
    expect(r.task(A)?.status).toBe('done')
    expect(r.ends().at(-1)).toMatchObject({ isError: false })
    await sleep(20)
    expect(r.delivered).toEqual([])
    expect(r.tasks!.runningCount('s1', 'agent')).toBe(0)
  })

  it('P2-05-30 FC: spawn calls onCreated then rejects → runTask rejects, end isError, task error, nothing left running', async () => {
    const fc = fakeSession({
      spawn: async (params) => {
        params.onCreated?.(createdInfo())
        throw new Error('x')
      }
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    await expect(kit.router.runTask(toolParams())).rejects.toThrow('x')
    expect(kit.ends()).toEqual([
      {
        type: 'sub_session_end',
        sessionId: 'sub-a1',
        parentSessionId: 's1',
        result: 'x',
        isError: true
      }
    ])
    expect(kit.task('sub-a1')?.status).toBe('error')
    expect(kit.tasks!.runningCount('s1', 'agent')).toBe(0)
    // 不再忙：面板追问照常受理
    await kit.router.continueTask({ subSessionId: 'sub-a1', text: 'more' })
    expect(fc.continueCalls).toEqual([[2, 'more']])
  })

  it('P2-05-31 FC: onCreated twice in one run (re-attach) → one create, two registers, one end, settled once (PIN-14)', async () => {
    const fc = fakeSession({
      spawn: async (params) => {
        params.onCreated?.(createdInfo())
        params.onCreated?.(createdInfo({ reattached: true }))
        return { result: 'found', conversationId: 2 as never, agentId: 'sub-a1' }
      }
    })
    const create = vi.fn()
    const join = vi.fn()
    const kit = routerKit(
      { get: () => fc.session, peek: async () => fc.session },
      {
        wrapTasks: (tasks) => ({
          ...tasks,
          create: (params) => {
            create(params)
            return tasks.create(params)
          },
          join: (taskId, policy) => {
            join(taskId)
            return tasks.join(taskId, policy)
          }
        })
      }
    )
    await kit.router.runTask(toolParams())
    expect(create).toHaveBeenCalledTimes(1)
    expect(join).toHaveBeenCalledTimes(1)
    expect(kit.registers()).toHaveLength(2)
    expect(kit.ends()).toHaveLength(1)
    expect(kit.statuses('sub-a1')).toEqual(['running', 'done'])
  })

  it('P2-05-31 a new run re-registering an ended entry reopens it (rerun in the same process)', async () => {
    let calls = 0
    const fc = fakeSession({
      spawn: async (params) => {
        calls++
        params.onCreated?.(createdInfo({ reattached: calls > 1 }))
        return { result: `run ${calls}`, conversationId: 2 as never, agentId: 'sub-a1' }
      }
    })
    const kit = routerKit({ get: () => fc.session, peek: async () => fc.session })
    await kit.router.runTask(toolParams())
    await kit.router.runTask(toolParams())
    expect(kit.statuses('sub-a1')).toEqual(['running', 'done', 'running', 'done'])
    expect(kit.ends().map((end) => end.result)).toEqual(['run 1', 'run 2'])
  })

  it('P2-05-40 managerTasks port: nested spawns register under the visible session too', async () => {
    const r = await hostR()
    r.t.kit.queue(
      callAgent('nester', 'mid'),
      callAgent('explore', 'leaf', { id: 'call-g' }),
      answer('leaf done'),
      answer('mid done'),
      answer('done')
    )
    expect(await r.session.submitUser('go')).toEqual({})
    for (const register of r.registers()) {
      expect(r.task(register.sessionId)).toMatchObject({
        taskId: register.sessionId,
        sessionId: 's1',
        status: 'done'
      })
    }
  })
})

describe('router · agent task titles', () => {
  it.each([
    ['', 'Explorer'],
    ['   ', 'Explorer'],
    ['Explorer', 'Explorer'],
    [' Explorer ', 'Explorer'],
    ['  find X  ', 'Explorer · find X']
  ])('TITLE-1 dispatch description %j → row title %j', async (description, title) => {
    const r = await hostR()
    r.t.kit.queue(callAgent('explore', 'find X', { description }), answer('found'), answer('done'))
    expect(await r.session.submitUser('go')).toEqual({})
    const A = r.registers()[0]!.sessionId
    // 空白 / 与显示名相同（trim 之后）只写显示名；描述两端的空白不进标题
    expect(r.task(A)?.title).toBe(title)
  })

  it.each(['dismiss', 'clearFinished'] as const)(
    'TITLE-3 the entry cleared by %s, then a follow-up: the recreated row keeps "display name · description"',
    async (clear) => {
      const r = await hostR()
      r.t.kit.queue(
        callAgent('explore', 'find X', { description: 'find the callers of X' }),
        answer('found'),
        answer('done')
      )
      expect(await r.session.submitUser('go')).toEqual({})
      const A = r.registers()[0]!.sessionId
      expect(r.task(A)?.title).toBe('Explorer · find the callers of X')
      // RT-1：派发时的 subject 带着派发卡那次调用的 id
      const spawned = r.task(A)!.subject
      expect(spawned).toEqual({
        kind: 'agent',
        profileName: 'explore',
        depth: 1,
        parentToolCallId: CALL
      })

      // 面板上把这条已结束的行清掉：条目没了，路由的索引条目还在
      if (clear === 'dismiss') expect(r.tasks!.dismiss(A)).toBe(true)
      else expect(r.tasks!.clearFinished('s1')).toBe(1)
      expect(r.task(A)).toBeUndefined()

      // 追问重建任务条目：标题从索引条目里的显示名 + 描述来，与派发时一字不差
      r.t.kit.queue(answer('more ok'))
      await withTimeout(r.router.continueTask({ subSessionId: A, text: 'more' }), 3000, 'continue')
      expect(r.task(A)).toMatchObject({
        title: 'Explorer · find the callers of X',
        status: 'done',
        subject: { kind: 'agent', profileName: 'explore', depth: 1 }
      })
      // RT-1：重建的 subject 与派发时一模一样（parentToolCallId 没丢）
      expect(r.task(A)!.subject).toEqual(spawned)
    }
  )
})
